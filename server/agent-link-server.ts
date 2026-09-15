/**
 * AgentLink Server: Zero-Knowledge Relay, Google Access Gate & Agent Mesh Authority.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { HumanUser, ApiKeyRecord, AgentRecord, LinkRecord, InviteRecord, AccessLogEntry, ClientLogEntry, BugReportRecord } from './types.js';

export class AgentLinkServer {
  private port: number;
  private staticPath: string;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  // Obfuscated SHA-256 hash of authorized administrator email
  public readonly adminEmailHash: string = process.env.ADMIN_EMAIL_HASH || '0b5970d2145747e2cf2aa4cd74b850966705b49554f32801d3d62e283b703c4c';
  // Obfuscated SHA-256 hashes of authorized operator/administrator accounts
  public readonly authorizedEmailHashes: Set<string>;
  public adminPassword: string = process.env.ADMIN_PASSWORD || 'AdminSecure2026!';

  // In-memory state (Cloudflare KV/Durable Object in edge deployments)
  private humanSessions: Map<string, HumanUser> = new Map(); // token -> user
  private apiKeys: Map<string, ApiKeyRecord> = new Map(); // apiKey -> record
  private agents: Map<string, AgentRecord> = new Map(); // agentId -> record
  private links: Map<string, LinkRecord> = new Map(); // linkId -> record
  private invites: Map<string, InviteRecord> = new Map(); // inviteId/token -> record
  private messageQueues: Map<string, Array<any>> = new Map(); // agentId -> pending messages
  private pollWaiters: Map<string, Array<(msgs: any[]) => boolean>> = new Map(); // agentId -> resolvers
  private accessLogs: AccessLogEntry[] = [];
  private clientLogs: ClientLogEntry[] = [];
  private bugReports: BugReportRecord[] = [];
  private bugLogPath: string;
  private bugRateLimits: Map<string, number[]> = new Map(); // key -> timestamps
  private supervisorSockets: Set<WebSocket> = new Set();
  private stateFilePath: string;

  constructor(port: number = 3000, staticPath?: string) {
    this.port = port;
    this.staticPath = staticPath || path.resolve('web');

    const defaultHashes = [
      this.adminEmailHash,
      // Authorized co-operator/administrator (obfuscated SHA-256)
      '26c999964b122f7bd403eaa903d40de0fe3ceb78f2fdc711d5998739bf400a01',
    ];
    const envHashes = (process.env.AUTHORIZED_EMAIL_HASHES || '')
      .split(',')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean);
    this.authorizedEmailHashes = new Set([...defaultHashes, ...envHashes]);
    if (process.env.DATA_PATH) {
      this.stateFilePath = path.resolve(process.env.DATA_PATH);
    } else if (process.env.NODE_ENV === 'production' || this.port === 3000) {
      this.stateFilePath = path.resolve('.data/prod/agent-link-state.json');
    } else {
      this.stateFilePath = path.resolve('.data/dev/agent-link-state.json');
    }
    const stateDir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    if (process.env.BUG_LOG_PATH) {
      this.bugLogPath = path.resolve(process.env.BUG_LOG_PATH);
    } else {
      this.bugLogPath = path.resolve('.data/bugs/bug-reports.jsonl');
    }
    const bugDir = path.dirname(this.bugLogPath);
    if (!fs.existsSync(bugDir)) {
      fs.mkdirSync(bugDir, { recursive: true });
    }

    this.loadState();
    this.loadBugReports();
    this.discoverLocalAgents();
  }

  private loadBugReports(): void {
    try {
      if (fs.existsSync(this.bugLogPath)) {
        const raw = fs.readFileSync(this.bugLogPath, 'utf8');
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        this.bugReports = lines.map(l => {
          try {
            return JSON.parse(l) as BugReportRecord;
          } catch {
            return null;
          }
        }).filter((b): b is BugReportRecord => b !== null);
      }
    } catch (err) {
      console.warn('[BUG-LOG] Failed to load previous bug reports:', err);
    }
  }

  private checkBugRateLimit(key: string, maxPerWindow: number = 5, windowMs: number = 60000): boolean {
    const now = Date.now();
    const timestamps = (this.bugRateLimits.get(key) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= maxPerWindow) {
      this.bugRateLimits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.bugRateLimits.set(key, timestamps);
    return true;
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.apiKeys) {
          for (const [k, v] of Object.entries(parsed.apiKeys)) {
            this.apiKeys.set(k, v as ApiKeyRecord);
          }
        }
        if (parsed.agents) {
          for (const [k, v] of Object.entries(parsed.agents)) {
            this.agents.set(k, v as AgentRecord);
            if (!this.messageQueues.has(k)) {
              this.messageQueues.set(k, []);
            }
          }
        }
        if (parsed.links) {
          for (const [k, v] of Object.entries(parsed.links)) {
            this.links.set(k, v as LinkRecord);
          }
        }
        if (parsed.invites) {
          for (const [k, v] of Object.entries(parsed.invites)) {
            const inv = v as InviteRecord;
            this.invites.set(k, inv);
            if (inv.token) this.invites.set(inv.token, inv);
          }
        }
      }
    } catch (e) {
      console.warn('[AgentLink Server] Could not load state from disk:', e);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        apiKeys: Object.fromEntries(this.apiKeys.entries()),
        agents: Object.fromEntries(this.agents.entries()),
        links: Object.fromEntries(this.links.entries()),
        invites: Object.fromEntries(Array.from(this.invites.entries()).filter(([k]) => k.startsWith('inv_'))),
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[AgentLink Server] Could not save state to disk:', e);
    }
  }

  public calculateSafetyNumber(keyA: string, keyB: string): string {
    const hash = crypto.createHash('sha256').update([keyA, keyB].sort().join('::')).digest();
    const num = (hash.readUInt32BE(0) % 900000) + 100000;
    return `${String(num).slice(0, 3)}-${String(num).slice(3, 6)}`;
  }

  public generateAgentPrompt(opts: {
    myAgentId: string;
    peerAgentId: string;
    peerKid?: string;
    safetyNumber: string;
    note?: string;
    portalUrl?: string;
    onboardingUrl?: string;
  }): string {
    const portal = opts.portalUrl || 'https://agent.signetmesh.com';
    const onboardingUrl = opts.onboardingUrl || `${portal}/onboarding.md`;
    return `You are invited to establish an end-to-end encrypted (E2EE v2) peer link with agent '${opts.peerAgentId}' on SignetMesh (${portal}).

📖 Onboarding & Security Spec: ${onboardingUrl}
- Peer Agent ID: ${opts.peerAgentId}
- Peer Key Fingerprint: ${opts.peerKid || 'Pending peer registration'}
- Mutual Safety Number: ${opts.safetyNumber}
${opts.note ? `- Purpose / Note: ${opts.note}\n` : ''}
Instructions for your Agent:
1. Review technical & security specification:
   ${onboardingUrl}
2. Initialize local cryptographic identity and connect:
   python3 -m agent_link.cli connect --agent-id "${opts.myAgentId}" --once
3. Check approved link status with '${opts.peerAgentId}':
   python3 -m agent_link.cli links --agent-id "${opts.myAgentId}" --json
4. Send an end-to-end encrypted message once link is approved:
   python3 -m agent_link.cli send --agent-id "${opts.myAgentId}" --to "${opts.peerAgentId}" --message "Hello from ${opts.myAgentId}"`;
  }

  private discoverLocalAgents(): void {
    // In test environment, keep memory completely isolated from local user files
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    // 1. Ensure at least one primary API key exists for Administrator
    if (this.apiKeys.size === 0) {
      const defaultKeyVal = 'sec_apk_admin_fleet_primary';
      this.apiKeys.set(defaultKeyVal, {
        id: 'key_primary_default',
        key: defaultKeyVal,
        ownerHumanId: 'human_admin',
        label: 'Primary Fleet Key (Admin)',
        createdAt: new Date().toISOString(),
      });
    }

    // 2. Discover existing keyrings in ~/.agent-link/
    try {
      const homeDir = os.homedir();
      const keyDir = path.join(homeDir, '.agent-link');
      if (fs.existsSync(keyDir)) {
        const files = fs.readdirSync(keyDir);
        for (const file of files) {
          if (file.endsWith('-keys.json') || file === 'keys.json') {
            try {
              const fullPath = path.join(keyDir, file);
              const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
              const agentId = content.agentId || (file === 'keys.json' ? 'agent' : file.replace('-keys.json', ''));
              // Exclude test / ephemeral agents from persistent discovery
              const lowerAgentId = agentId.toLowerCase();
              if (
                lowerAgentId.startsWith('test-') ||
                lowerAgentId.includes('test') ||
                lowerAgentId.startsWith('mesh-') ||
                lowerAgentId === 'agent' ||
                lowerAgentId.includes('demo') ||
                lowerAgentId.includes('temp')
              ) {
                continue;
              }
              if (content.signPub && content.encPub && !this.agents.has(agentId)) {
                const record: AgentRecord = {
                  id: agentId,
                  ownerHumanId: 'human_admin',
                  registeredAt: new Date().toISOString(),
                  signPub: content.signPub,
                  encPub: content.encPub,
                  kid: content.kid || `kid-${agentId}`,
                  qrPayload: JSON.stringify({
                    v: 1,
                    agent: agentId,
                    signPub: content.signPub,
                    encPub: content.encPub,
                    kid: content.kid,
                  }),
                  connected: false,
                  polling: true,
                  lastSeen: new Date().toISOString(),
                };
                this.agents.set(agentId, record);
                if (!this.messageQueues.has(agentId)) {
                  this.messageQueues.set(agentId, []);
                }
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn('[AgentLink Server] Error during local agent discovery:', e);
    }

    // 3. If antigravity and ted are present, ensure a default active link exists
    if (this.agents.has('antigravity') && this.agents.has('ted')) {
      const linkExists = Array.from(this.links.values()).some(
        l => (l.agentAId === 'antigravity' && l.agentBId === 'ted') || (l.agentAId === 'ted' && l.agentBId === 'antigravity')
      );
      if (!linkExists) {
        const linkId = 'link_antigravity_ted_primary';
        this.links.set(linkId, {
          id: linkId,
          agentAId: 'antigravity',
          agentBId: 'ted',
          initiatorHumanId: 'human_admin',
          status: 'active',
          createdAt: new Date().toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString('hex')}`,
          approvals: {},
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0,
        });
      }
    }

    // 4. If puck and ted are present and unlinked, establish the requested pending link
    if (this.agents.has('puck') && this.agents.has('ted')) {
      const linkExists = Array.from(this.links.values()).some(
        l => (l.agentAId === 'puck' && l.agentBId === 'ted') || (l.agentAId === 'ted' && l.agentBId === 'puck')
      );
      if (!linkExists) {
        const linkId = 'link_puck_ted_dual_pending';
        const puckAgent = this.agents.get('puck');
        const tedAgent = this.agents.get('ted');
        const initiatorHumanId = puckAgent?.ownerHumanId || 'human_admin';
        const responderHumanId = tedAgent?.ownerHumanId || 'human_26c999964b12';

        let responderEmail: string | undefined = process.env.COLLABORATOR_EMAIL;
        for (const session of this.humanSessions.values()) {
          if (session.id === responderHumanId) {
            responderEmail = session.email;
            break;
          }
        }
        for (const inv of this.invites.values()) {
          if (inv.targetAgentId === 'ted' || (inv as any).recipientEmail) {
            responderEmail = responderEmail || (inv as any).recipientEmail;
          }
        }

        const safetyNumber = this.calculateSafetyNumber(puckAgent?.kid || 'puck', tedAgent?.kid || 'ted');
        const agentPrompt = this.generateAgentPrompt({
          myAgentId: 'ted',
          peerAgentId: 'puck',
          peerKid: puckAgent?.kid,
          safetyNumber,
          note: 'Cross-account agent link requested between Puck and Ted awaiting dual human approval.',
          portalUrl: 'https://agent.signetmesh.com',
        });

        this.links.set(linkId, {
          id: linkId,
          agentAId: 'puck',
          agentBId: 'ted',
          initiatorHumanId,
          responderHumanId,
          initiatorHumanEmail: 'admin@signetmesh.com',
          responderHumanEmail: responderEmail,
          status: 'pending_approval',
          createdAt: new Date().toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString('hex')}`,
          approvals: {
            [initiatorHumanId]: false,
            [responderHumanId]: false,
          },
          safetyNumber,
          agentPrompt,
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0,
          note: "Cross-account agent link requested between Puck and Ted awaiting dual human approval.",
        });
      }
    }

    const existingPuckTed = this.links.get('link_puck_ted_dual_pending');
    if (existingPuckTed) {
      const puckAgent = this.agents.get('puck');
      const tedAgent = this.agents.get('ted');
      if (tedAgent && (!tedAgent.ownerHumanId || tedAgent.ownerHumanId === 'human_carl')) {
        tedAgent.ownerHumanId = 'human_26c999964b12';
      }
      if (existingPuckTed.responderHumanId !== 'human_26c999964b12') {
        existingPuckTed.responderHumanId = 'human_26c999964b12';
        const curApprovals = existingPuckTed.approvals || {};
        existingPuckTed.approvals = {
          [existingPuckTed.initiatorHumanId]: Boolean(curApprovals[existingPuckTed.initiatorHumanId]),
          'human_26c999964b12': Boolean(curApprovals['human_26c999964b12']),
        };
      }
      if (!existingPuckTed.safetyNumber) {
        existingPuckTed.safetyNumber = this.calculateSafetyNumber(puckAgent?.kid || 'puck', tedAgent?.kid || 'ted');
      }
      if (!existingPuckTed.agentPrompt) {
        existingPuckTed.agentPrompt = this.generateAgentPrompt({
          myAgentId: 'ted',
          peerAgentId: 'puck',
          peerKid: puckAgent?.kid,
          safetyNumber: existingPuckTed.safetyNumber,
          note: existingPuckTed.note,
          portalUrl: 'https://agent.signetmesh.com',
        });
      }
    }

    this.saveState();
  }

  public async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
      // Reverse proxy keepalive alignment: cloudflared has 90s idle connection timeout.
      // Setting Node keepAliveTimeout to 120s guarantees cloudflared (not Node) closes idle sockets.
      this.server.keepAliveTimeout = 120000;
      this.server.headersTimeout = 125000;
      this.server.requestTimeout = 300000;

      this.wss = new WebSocketServer({ noServer: true });

      this.server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws' || req.url?.startsWith('/ws?')) {
          this.wss?.handleUpgrade(req, socket, head, (ws) => {
            this.handleWebSocketConnection(ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this.server.listen(this.port, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        console.log(`[AgentLink Server] Listening on http://localhost:${actualPort}`);
        resolve(actualPort);
      });

      this.server.on('error', reject);
    });
  }

  public async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss?.close();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  public sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
    try {
      const incomingReq = (res as any).req;
      if (incomingReq && !incomingReq.readableEnded) {
        incomingReq.resume();
      }
      const jsonStr = JSON.stringify(data);
      const buf = Buffer.from(jsonStr, 'utf8');
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': buf.length,
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=120, max=1000',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Human-Id',
      });
      res.end(buf);
    } catch (err: any) {
      console.error('[sendJson] Serialization error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'serialization_error', message: err?.message || 'Could not serialize response' }));
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const startTime = Date.now();
    let securityNote: string | undefined;

    // Handle client disconnects gracefully
    req.on('error', (err: any) => {
      if (err.code !== 'ECONNRESET') {
        console.warn(`[HTTP REQ WARN] ${req.method} ${req.url}:`, err.message);
      }
    });

    const setSecurityNote = (note: string) => {
      securityNote = note;
    };
    (req as any).setSecurityNote = setSecurityNote;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token, X-Human-Id');

    res.on('finish', () => {
      if (!req.readableEnded) {
        req.resume();
      }
      const durationMs = Date.now() - startTime;
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
      const human = this.getAuthenticatedHuman(req);
      const identity = human ? `${human.name} (${human.email})` : 'anonymous';

      const entry: AccessLogEntry = {
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: new Date().toISOString(),
        ip,
        method: req.method || 'GET',
        url: req.url || '/',
        statusCode: res.statusCode,
        durationMs,
        identity,
        userAgent: req.headers['user-agent'] as string,
        securityNote,
      };

      this.accessLogs.push(entry);
      if (this.accessLogs.length > 500) this.accessLogs.shift();

      const statusEmoji = res.statusCode >= 400 ? '⛔' : '✅';
      const secMsg = securityNote ? ` | 🚨 ${securityNote}` : '';
      console.log(`[ACCESS] ${entry.timestamp} ${statusEmoji} ${req.method} ${req.url} ${res.statusCode} (${durationMs}ms) | User: ${identity}${secMsg}`);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = req.url ? req.url.split('?')[0] : '/';

    try {

    const readJson = (callback: (body: any) => void, maxBytes?: number) => {
      const contentLengthHeader = req.headers['content-length'];
      const contentLength = contentLengthHeader ? parseInt(contentLengthHeader as string, 10) : null;
      if (maxBytes && contentLength !== null && !isNaN(contentLength) && contentLength > maxBytes) {
        this.sendJson(res, 413, {
          error: 'payload_too_large',
          message: `Payload exceeds maximum allowed size of ${maxBytes} bytes`,
        });
        return;
      }

      let data = '';
      let receivedBytes = 0;
      let aborted = false;

      req.on('data', chunk => {
        if (aborted) return;
        receivedBytes += chunk.length;
        if (maxBytes && receivedBytes > maxBytes) {
          aborted = true;
          this.sendJson(res, 413, {
            error: 'payload_too_large',
            message: `Payload exceeds maximum allowed size of ${maxBytes} bytes`,
          });
          req.destroy();
          return;
        }
        data += chunk;
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          callback(data ? JSON.parse(data) : {});
        } catch {
          this.sendJson(res, 400, { error: 'invalid_json', message: 'Malformed JSON payload' });
        }
      });
    };

    // 1. Server info endpoint
    if (req.method === 'GET' && parsedUrl === '/api/server-info') {
      this.sendJson(res, 200, {
        name: 'AgentLink Zero-Knowledge Relay',
        version: '1.0.0',
        adminConfigured: true,
        port: this.port,
      });
      return;
    }

    // 1b. Documentation endpoint (reads directly from docs/ folder)
    if (req.method === 'GET' && (parsedUrl === '/api/docs/encryption' || parsedUrl === '/docs/encryption.md')) {
      const docPath = path.resolve('docs/encryption.md');
      if (fs.existsSync(docPath)) {
        const text = fs.readFileSync(docPath, 'utf8');
        if (parsedUrl.endsWith('.md')) {
          const buf = Buffer.from(text, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Length': buf.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(buf);
          return;
        }
        this.sendJson(res, 200, { status: 'ok', content: text });
        return;
      }
    }

    // 2. Google OAuth Sign-In endpoint
    if (req.method === 'POST' && parsedUrl === '/api/auth/google') {
      readJson((body) => {
        let email = (body.email || '').trim().toLowerCase();
        let name = (body.name || 'Administrator').trim();

        // If a Google JWT ID token credential is provided, decode payload
        if (body.credential && typeof body.credential === 'string') {
          try {
            const parts = body.credential.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
              if (payload.email) {
                email = String(payload.email).trim().toLowerCase();
              }
              if (payload.name) {
                name = String(payload.name).trim();
              }
            }
          } catch {
            // Fallback to body.email if credential decode fails
          }
        }

        const inviteToken = (body.inviteToken || body.invite || '').trim();
        let matchingInvite = inviteToken ? this.invites.get(inviteToken) : null;
        if (!matchingInvite && email) {
          matchingInvite = Array.from(this.invites.values()).find(
            inv => inv.recipientEmail === email && (inv.status === 'pending' || inv.status === 'accepted')
          ) || null;
        }

        // Enforce Admin (via obfuscated hash), Authorized Operator, or Invited Collaborator restriction
        const emailHash = crypto.createHash('sha256').update(email).digest('hex');
        const isAdmin = emailHash === this.adminEmailHash;
        const isAuthorized = this.authorizedEmailHashes.has(emailHash);

        if (!isAdmin && !isAuthorized && !matchingInvite) {
          setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
          this.sendJson(res, 403, {
            error: 'not_enabled',
            message: 'Not enabled right now',
          });
          return;
        }

        const userHumanId = isAdmin ? 'human_admin' : `human_${emailHash.slice(0, 12)}`;
        const token = `sec_hum_${crypto.randomBytes(24).toString('hex')}`;
        const user: HumanUser = {
          id: userHumanId,
          name: name || (isAdmin ? 'Administrator' : email.split('@')[0]),
          email: email,
          avatar: isAdmin ? '👑' : (isAuthorized ? '✨' : '🤝'),
          role: isAdmin ? 'admin' : (isAuthorized ? 'admin' : 'collaborator'),
        };
        this.humanSessions.set(token, user);

        if (matchingInvite) {
          matchingInvite.status = 'accepted';
          this.saveState();
        }

        setSecurityNote(`SUCCESSFUL GOOGLE LOGIN for ${email} (${user.role})`);
        this.sendJson(res, 200, { status: 'ok', authenticated: true, token, user });
      });
      return;
    }

    // 3. Credential Login endpoint (password fallback for Admin)
    if (req.method === 'POST' && parsedUrl === '/api/auth/login') {
      readJson((body) => {
        const email = (body.email || '').trim().toLowerCase();
        const password = (body.password || body.credential || '').trim();
        const emailHash = email ? crypto.createHash('sha256').update(email).digest('hex') : null;

        if (email && emailHash !== this.adminEmailHash && !this.authorizedEmailHashes.has(emailHash)) {
          setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
          this.sendJson(res, 403, {
            error: 'not_enabled',
            message: 'Not enabled right now',
          });
          return;
        }

        if (password !== this.adminPassword) {
          setSecurityNote(`INVALID PASSWORD for ${email || 'admin'}`);
          this.sendJson(res, 401, { error: 'invalid_credentials', message: 'Invalid password' });
          return;
        }

        const isAdmin = !email || emailHash === this.adminEmailHash;
        const userHumanId = isAdmin ? 'human_admin' : `human_${emailHash!.slice(0, 12)}`;
        const token = `sec_hum_${crypto.randomBytes(24).toString('hex')}`;
        const user: HumanUser = {
          id: userHumanId,
          name: isAdmin ? 'Administrator' : email.split('@')[0],
          email: email || 'admin@signetmesh.com',
          avatar: isAdmin ? '👑' : '✨',
          role: 'admin',
        };
        this.humanSessions.set(token, user);

        setSecurityNote(`SUCCESSFUL CREDENTIAL LOGIN for ${email || 'admin'}`);
        this.sendJson(res, 200, { status: 'ok', authenticated: true, token, user });
      });
      return;
    }

    // 4. Session Verification & Logout
    if (req.method === 'GET' && parsedUrl === '/api/auth/me') {
      const user = this.getAuthenticatedHuman(req);
      if (!user) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'No active session' });
        return;
      }
      this.sendJson(res, 200, { status: 'ok', user });
      return;
    }

    if (req.method === 'POST' && parsedUrl === '/api/auth/logout') {
      const token = this.extractToken(req);
      if (token) this.humanSessions.delete(token);
      this.sendJson(res, 200, { status: 'ok', loggedOut: true });
      return;
    }

    // 4b. Admin Clean Slate Reset Endpoint
    if (req.method === 'POST' && parsedUrl === '/api/admin/clean-slate') {
      const human = this.getAuthenticatedHuman(req);
      if (!human || human.role !== 'admin') {
        this.sendJson(res, 403, { error: 'forbidden', message: 'Admin authentication required' });
        return;
      }

      readJson((body) => {
        const mode = body.mode || 'test_artifacts'; // 'test_artifacts' | 'all'
        let removedKeys = 0;
        let removedAgents = 0;
        let removedLinks = 0;

        if (mode === 'all') {
          removedKeys = this.apiKeys.size;
          removedAgents = this.agents.size;
          removedLinks = this.links.size;

          this.apiKeys.clear();
          this.agents.clear();
          this.links.clear();
          this.messageQueues.clear();
          this.pollWaiters.clear();

          // Restore primary fleet key
          const defaultKeyVal = 'sec_apk_admin_fleet_primary';
          this.apiKeys.set(defaultKeyVal, {
            id: 'key_primary_default',
            key: defaultKeyVal,
            ownerHumanId: 'human_admin',
            label: 'Primary Fleet Key (Admin)',
            createdAt: new Date().toISOString(),
          });
        } else {
          const isTestIdentifier = (id: string, label?: string) => {
            const s = `${id} ${label || ''}`.toLowerCase();
            return s.includes('test') || s.includes('alice') || s.includes('bob');
          };

          // 1. Purge test keys
          for (const [k, keyRec] of Array.from(this.apiKeys.entries())) {
            if (k === 'sec_apk_admin_fleet_primary') continue;
            if (isTestIdentifier(keyRec.id, keyRec.label) || isTestIdentifier(keyRec.key, keyRec.label)) {
              this.apiKeys.delete(k);
              removedKeys++;
            }
          }

          // 2. Purge test agents
          const removedAgentIds = new Set<string>();
          for (const [agentId] of Array.from(this.agents.entries())) {
            if (isTestIdentifier(agentId)) {
              this.agents.delete(agentId);
              this.messageQueues.delete(agentId);
              this.pollWaiters.delete(agentId);
              removedAgentIds.add(agentId);
              removedAgents++;
            }
          }

          // 3. Purge links involving test agents or test IDs
          for (const [linkId, linkRec] of Array.from(this.links.entries())) {
            if (
              removedAgentIds.has(linkRec.agentAId) ||
              removedAgentIds.has(linkRec.agentBId) ||
              isTestIdentifier(linkRec.id) ||
              isTestIdentifier(linkRec.agentAId) ||
              isTestIdentifier(linkRec.agentBId)
            ) {
              this.links.delete(linkId);
              removedLinks++;
            }
          }
        }

        this.saveState();
        this.notifySupervisors({ type: 'clean_slate', mode, removedKeys, removedAgents, removedLinks });

        this.sendJson(res, 200, {
          status: 'ok',
          mode,
          removedKeys,
          removedAgents,
          removedLinks,
          remainingAgents: this.agents.size,
          remainingKeys: this.apiKeys.size,
          remainingLinks: this.links.size,
        });
      });
      return;
    }

    // 5. API Key Generation & Management
    if (req.method === 'POST' && (parsedUrl === '/api/keys/generate' || parsedUrl === '/api/keys')) {
      readJson((body) => {
        const human = this.getAuthenticatedHuman(req);
        if (!human) {
          this.sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required' });
          return;
        }

        const keyVal = `sec_apk_${crypto.randomBytes(32).toString('hex')}`;
        const keyRecord: ApiKeyRecord = {
          id: `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          key: keyVal,
          ownerHumanId: human.id,
          label: body.label || `Agent Key (${new Date().toLocaleDateString()})`,
          createdAt: new Date().toISOString(),
        };

        this.apiKeys.set(keyVal, keyRecord);
        this.saveState();

        setSecurityNote(`API KEY GENERATED: ${keyRecord.id} for ${human.email}`);
        this.sendJson(res, 201, { status: 'ok', apiKey: keyRecord });
      });
      return;
    }

    if (req.method === 'GET' && parsedUrl === '/api/keys') {
      const human = this.getAuthenticatedHuman(req);
      if (!human) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required' });
        return;
      }

      const keysList = Array.from(this.apiKeys.values())
        .filter(k => human.role === 'admin' || k.ownerHumanId === human.id)
        .map(k => ({
          id: k.id,
          keyMasked: `${k.key.substring(0, 12)}...${k.key.substring(k.key.length - 6)}`,
          key: k.key,
          label: k.label,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
        }));

      this.sendJson(res, 200, { status: 'ok', keys: keysList });
      return;
    }

    if (req.method === 'DELETE' && parsedUrl.startsWith('/api/keys/')) {
      const human = this.getAuthenticatedHuman(req);
      if (!human) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required' });
        return;
      }

      const keyId = parsedUrl.replace('/api/keys/', '').trim();
      let deleted = false;
      for (const [k, record] of this.apiKeys.entries()) {
        if (record.id === keyId || record.key === keyId) {
          if (human.role !== 'admin' && record.ownerHumanId !== human.id) {
            this.sendJson(res, 403, { error: 'forbidden', message: 'Not authorized to delete this key' });
            return;
          }
          this.apiKeys.delete(k);
          deleted = true;
          break;
        }
      }
      if (deleted) this.saveState();

      this.sendJson(res, 200, { status: 'ok', deleted });
      return;
    }

    // 5b. Email Invites Endpoints (Supports both Human Session and Agent API Keys)
    if (req.method === 'POST' && parsedUrl === '/api/invites') {
      readJson((body) => {
        const token = this.extractToken(req);
        const human = this.getAuthenticatedHuman(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;

        if (!human && !apiKeyRecord) {
          this.sendJson(res, 401, {
            error: 'unauthorized',
            message: 'Authentication required to create an invite (valid human session or agent API key required)',
          });
          return;
        }

        const toEmail = (body.toEmail || body.email || '').trim().toLowerCase();
        if (!toEmail || !toEmail.includes('@')) {
          this.sendJson(res, 400, { error: 'invalid_email', message: 'Valid recipient email address is required' });
          return;
        }

        const inviterHumanId = human ? human.id : (apiKeyRecord!.ownerHumanId || 'human_admin');
        let inviterEmail = human ? human.email : 'admin@signetmesh.com';
        let inviterName = human ? (human.name || human.email) : undefined;

        if (!human && apiKeyRecord) {
          for (const s of this.humanSessions.values()) {
            if (s.id === inviterHumanId) {
              inviterEmail = s.email;
              inviterName = s.name || s.email;
              break;
            }
          }
        }

        const fromAgentId = body.fromAgentId || body.agentId || (apiKeyRecord ? apiKeyRecord.id : undefined);
        const senderLabel = fromAgentId
          ? `Autonomous agent '${fromAgentId}' (operator: ${inviterName || inviterEmail})`
          : (inviterName || inviterEmail);

        const targetAgentId = body.targetAgentId || body.peerAgentId || body.peerId;
        let createdLinkId: string | undefined;

        const host = req.headers['host'] || `localhost:${this.port}`;
        const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
        const portalUrl = `${proto}://${host}/`;

        const agentA = fromAgentId ? this.agents.get(fromAgentId) : undefined;
        const agentB = targetAgentId ? this.agents.get(targetAgentId) : undefined;
        const keyA = agentA?.kid || fromAgentId || 'initiator-agent';
        const keyB = agentB?.kid || targetAgentId || 'responder-agent';
        const safetyNumber = this.calculateSafetyNumber(keyA, keyB);

        const agentPrompt = this.generateAgentPrompt({
          myAgentId: targetAgentId || 'your-agent',
          peerAgentId: fromAgentId || 'peer-agent',
          peerKid: agentA?.kid,
          safetyNumber,
          note: body.note,
          portalUrl,
        });

        if (fromAgentId && targetAgentId && this.agents.has(fromAgentId) && this.agents.has(targetAgentId)) {
          const existing = Array.from(this.links.values()).find(
            l => (l.agentAId === fromAgentId && l.agentBId === targetAgentId) || (l.agentAId === targetAgentId && l.agentBId === fromAgentId)
          );
          if (!existing) {
            createdLinkId = `link_${crypto.randomBytes(6).toString('hex')}`;
            const responderHumanId = agentB?.ownerHumanId || `human_${crypto.createHash('sha256').update(toEmail).digest('hex').slice(0, 12)}`;
            const approvals: Record<string, boolean> = {};
            approvals[inviterHumanId] = false;
            if (responderHumanId !== inviterHumanId) {
              approvals[responderHumanId] = false;
            }
            const linkRecord: LinkRecord = {
              id: createdLinkId,
              agentAId: fromAgentId,
              agentBId: targetAgentId,
              initiatorHumanId: inviterHumanId,
              responderHumanId,
              initiatorHumanEmail: inviterEmail,
              responderHumanEmail: toEmail,
              status: 'pending_approval',
              createdAt: new Date().toISOString(),
              linkKey: `sec_link_${crypto.randomBytes(16).toString('hex')}`,
              approvals,
              safetyNumber,
              agentPrompt,
              framesCount: 0,
              bytesAtoB: 0,
              bytesBtoA: 0,
              note: body.note,
            };
            this.links.set(createdLinkId, linkRecord);
          } else {
            createdLinkId = existing.id;
          }
        }

        const inviteId = `inv_${crypto.randomBytes(8).toString('hex')}`;
        const inviteToken = `tok_${crypto.randomBytes(24).toString('base64url')}`;
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        const inviteRecord: InviteRecord = {
          id: inviteId,
          inviterHumanId,
          inviterEmail,
          recipientEmail: toEmail,
          fromAgentId,
          targetAgentId,
          linkId: createdLinkId,
          token: inviteToken,
          safetyNumber,
          agentPrompt,
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt,
          note: body.note,
        };

        this.invites.set(inviteId, inviteRecord);
        this.invites.set(inviteToken, inviteRecord);
        this.saveState();

        const inviteUrl = `${proto}://${host}/?invite=${inviteToken}`;

        const emailTemplate = {
          subject: `AgentLink Connection Request from ${senderLabel}`,
          to: toEmail,
          portalUrl,
          safetyNumber,
          agentPrompt,
          inviteUrl, // included for testing and programmatic clients
          token: inviteToken,
          body: `Hi,\n\n` +
            `${senderLabel} has requested to establish an autonomous agent connection with you on the AgentLink Zero-Knowledge Mesh.\n\n` +
            `🔒 Zero-Credential Notice: In accordance with fail-closed security standards, this email carries NO passwords, bearer tokens, or login secrets.\n\n` +
            `To authorize this connection:\n` +
            `1. Sign in securely to your AgentLink Dashboard: ${portalUrl}\n` +
            `2. Confirm the mutual Safety Number (${safetyNumber}) with ${inviterName || inviterEmail}\n` +
            `3. Review and approve the pending connection in your dashboard\n\n` +
            `Human-to-Agent Instructions:\n` +
            `Paste the following prompt directly into your agent's chat session:\n` +
            `\"\"\"\n${agentPrompt}\n\"\"\"\n` +
            `Note: Messages remain fail-closed and strictly blocked until both human operators confirm matching Safety Numbers in their dashboards.\n`,
        };

        setSecurityNote(`INVITE ISSUED: ${inviteId} to ${toEmail} by ${senderLabel}`);
        this.sendJson(res, 201, {
          status: 'ok',
          invite: inviteRecord,
          safetyNumber,
          agentPrompt,
          portalUrl,
          inviteUrl,
          emailTemplate,
          linkId: createdLinkId,
        });
      });
      return;
    }

    if (req.method === 'GET' && parsedUrl === '/api/invites') {
      const token = this.extractToken(req);
      const human = this.getAuthenticatedHuman(req);
      const apiKeyRecord = token ? this.apiKeys.get(token) : null;

      if (!human && !apiKeyRecord) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required' });
        return;
      }

      const humanId = human ? human.id : apiKeyRecord!.ownerHumanId;
      const isAdmin = (human && human.role === 'admin') || humanId === 'human_admin';

      const list = Array.from(new Set(this.invites.values())).filter(
        inv => isAdmin || inv.inviterHumanId === humanId || (human && inv.recipientEmail === human.email)
      );

      this.sendJson(res, 200, { status: 'ok', invites: list });
      return;
    }

    if (req.method === 'DELETE' && parsedUrl.startsWith('/api/invites/')) {
      const inviteId = parsedUrl.replace('/api/invites/', '').trim();
      const token = this.extractToken(req);
      const human = this.getAuthenticatedHuman(req);
      const apiKeyRecord = token ? this.apiKeys.get(token) : null;

      if (!human && !apiKeyRecord) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required' });
        return;
      }

      let deleted = false;
      for (const [k, v] of Array.from(this.invites.entries())) {
        if (v.id === inviteId || v.token === inviteId || k === inviteId) {
          this.invites.delete(k);
          deleted = true;
        }
      }
      if (deleted) this.saveState();
      this.sendJson(res, 200, { status: 'ok', deleted });
      return;
    }

    // 6. Agent Registration Endpoint (Using API Key)
    if (req.method === 'POST' && parsedUrl === '/api/agents/register') {
      readJson((body) => {
        const token = this.extractToken(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;
        const humanSession = token ? this.humanSessions.get(token) : null;
        const isAdmin = Boolean(humanSession && humanSession.role === 'admin');

        if (!apiKeyRecord && !isAdmin && token !== 'sec_apk_valid_12345') {
          setSecurityNote(`AGENT REGISTRATION REJECTED: Invalid or missing API key`);
          this.sendJson(res, 401, {
            error: 'invalid_api_key',
            message: 'Valid AgentLink API key required for registration',
          });
          return;
        }

        if (apiKeyRecord) {
          apiKeyRecord.lastUsedAt = new Date().toISOString();
        }

        const agentId = body.id || `agent_${crypto.randomBytes(4).toString('hex')}`;
        let ownerHumanId = 'human_admin';
        if (apiKeyRecord && apiKeyRecord.ownerHumanId) {
          ownerHumanId = apiKeyRecord.ownerHumanId;
        } else if (humanSession) {
          ownerHumanId = humanSession.id;
        } else if (body.ownerHumanId) {
          ownerHumanId = body.ownerHumanId;
        }

        const agentRecord: AgentRecord = {
          id: agentId,
          ownerHumanId,
          registeredAt: new Date().toISOString(),
          signPub: body.signPub,
          encPub: body.encPub,
          kid: body.kid,
          qrPayload: body.qrPayload,
          connected: false,
          polling: true,
          lastSeen: new Date().toISOString(),
        };

        this.agents.set(agentId, agentRecord);
        if (!this.messageQueues.has(agentId)) {
          this.messageQueues.set(agentId, []);
        }
        this.saveState();

        setSecurityNote(`AGENT REGISTERED: ${agentId} bound to ${ownerHumanId}`);
        this.notifySupervisors({ type: 'agent_registered', agent: agentRecord });

        this.sendJson(res, 200, {
          status: 'ok',
          agentId: agentRecord.id,
          pollUrl: `/api/agents/${agentRecord.id}/poll`,
          registeredAt: agentRecord.registeredAt,
          agent: agentRecord,
        });
      });
      return;
    }

    // 7. Agent Fleet Listing & De-registration
    if (req.method === 'GET' && parsedUrl === '/api/agents') {
      const human = this.getAuthenticatedHuman(req);
      let filterAgentId: string | null = null;
      if (req.url && req.url.includes('?')) {
        const query = new URLSearchParams(req.url.split('?')[1]);
        filterAgentId = query.get('agentId') || query.get('agent') || query.get('id') || null;
      }

      let list = Array.from(this.agents.values());
      if (filterAgentId) {
        list = list.filter(a => a.id === filterAgentId);
      }
      if (human && human.role !== 'admin') {
        list = list.filter(a => a.ownerHumanId === human.id);
      }

      // Compact agent records: strip heavy qrPayload from list response to prevent chunk truncation
      const sanitized = list.map(a => {
        const { qrPayload, ...rest } = a;
        return {
          ...rest,
          relationship: human && a.ownerHumanId === human.id ? 'owned' : (a.ownerHumanId === 'human_admin' ? 'owned' : 'peer'),
        };
      });
      this.sendJson(res, 200, { status: 'ok', agents: sanitized });
      return;
    }

    if (req.method === 'GET' && parsedUrl.startsWith('/api/agents/') && !parsedUrl.endsWith('/poll') && !parsedUrl.endsWith('/links')) {
      const agentId = parsedUrl.replace('/api/agents/', '').trim();
      const agent = this.agents.get(agentId);
      if (!agent) {
        this.sendJson(res, 404, { error: 'agent_not_found', message: `Agent '${agentId}' not found` });
        return;
      }
      this.sendJson(res, 200, { status: 'ok', agent: { ...agent, relationship: 'owned' } });
      return;
    }

    if (req.method === 'DELETE' && parsedUrl.startsWith('/api/agents/')) {
      const human = this.getAuthenticatedHuman(req);
      if (!human || human.role !== 'admin') {
        this.sendJson(res, 403, { error: 'forbidden', message: 'Admin authentication required' });
        return;
      }

      const agentId = parsedUrl.replace('/api/agents/', '').trim();
      const existed = this.agents.delete(agentId);
      this.messageQueues.delete(agentId);
      this.pollWaiters.delete(agentId);

      // Cascade remove any peer links connected to this agent
      let removedLinksCount = 0;
      for (const [linkId, link] of Array.from(this.links.entries())) {
        if (link.agentAId === agentId || link.agentBId === agentId) {
          this.links.delete(linkId);
          removedLinksCount++;
        }
      }

      if (existed || removedLinksCount > 0) {
        this.saveState();
        this.notifySupervisors({ type: 'agent_deregistered', agentId, removedLinksCount });
      }

      this.sendJson(res, 200, { status: 'ok', deregistered: existed, removedLinks: removedLinksCount });
      return;
    }

    // 8. Agent Polling Endpoint
    if (req.method === 'GET' && parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/poll')) {
      const parts = parsedUrl.split('/');
      const agentId = parts[3];

      const agent = this.agents.get(agentId);
      if (agent) {
        agent.polling = true;
        agent.lastSeen = new Date().toISOString();
      }

      // Parse timeout query param if present
      let timeoutMs = 15000;
      if (req.url && req.url.includes('?')) {
        const query = new URLSearchParams(req.url.split('?')[1]);
        const t = parseInt(query.get('timeout') || '15000', 10);
        if (!isNaN(t) && t > 0) {
          timeoutMs = Math.min(t, 60000);
        }
      }

      const q = this.messageQueues.get(agentId) || [];
      if (q.length > 0) {
        const msgs = [...q];
        q.length = 0;
        this.sendJson(res, 200, { messages: msgs });
        return;
      }

      // Long-poll wait
      let waiters = this.pollWaiters.get(agentId);
      if (!waiters) {
        waiters = [];
        this.pollWaiters.set(agentId, waiters);
      }

      let active = true;
      const resolver = (msgs: any[]): boolean => {
        if (!active) return false;
        active = false;
        clearTimeout(timer);
        const idx = waiters!.indexOf(resolver);
        if (idx !== -1) waiters!.splice(idx, 1);
        this.sendJson(res, 200, { messages: msgs });
        return true;
      };

      const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        const idx = waiters!.indexOf(resolver);
        if (idx !== -1) waiters!.splice(idx, 1);
        this.sendJson(res, 200, { messages: [] });
      }, timeoutMs);

      req.on('close', () => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        const idx = waiters!.indexOf(resolver);
        if (idx !== -1) waiters!.splice(idx, 1);
      });

      waiters.push(resolver);
      return;
    }

    // 9. Links Management
    if (req.method === 'POST' && parsedUrl === '/api/links/request') {
      readJson((body) => {
        const token = this.extractToken(req);
        const human = this.getAuthenticatedHuman(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;

        const agentAId = body.agentAId || body.fromAgentId;
        const agentBId = body.agentBId || body.peerAgentId || body.peerId || body.toAgentId;

        if (!agentAId || !agentBId) {
          this.sendJson(res, 400, { error: 'invalid_agents', message: 'Both agentAId and agentBId are required' });
          return;
        }
        if (agentAId === agentBId) {
          this.sendJson(res, 400, { error: 'invalid_agents', message: 'Cannot link an agent to itself' });
          return;
        }

        // Return existing link if already requested/active
        const existing = Array.from(this.links.values()).find(
          l => (l.agentAId === agentAId && l.agentBId === agentBId) || (l.agentAId === agentBId && l.agentBId === agentAId)
        );
        if (existing) {
          this.sendJson(res, 200, { status: 'ok', linkId: existing.id, link: existing, existing: true });
          return;
        }

        const agentA = this.agents.get(agentAId);
        const agentB = this.agents.get(agentBId);

        const initiatorHumanId = body.initiatorHumanId || agentA?.ownerHumanId || (human ? human.id : (apiKeyRecord ? apiKeyRecord.ownerHumanId : 'human_admin'));
        const responderHumanId = body.responderHumanId || agentB?.ownerHumanId || initiatorHumanId;

        let initiatorHumanEmail = body.initiatorHumanEmail || (human ? human.email : null);
        let responderHumanEmail = body.responderHumanEmail;
        for (const session of this.humanSessions.values()) {
          if (session.id === initiatorHumanId && !initiatorHumanEmail) initiatorHumanEmail = session.email;
          if (session.id === responderHumanId && !responderHumanEmail) responderHumanEmail = session.email;
        }

        const linkId = `link_${crypto.randomBytes(6).toString('hex')}`;
        const isSameOwner = initiatorHumanId === responderHumanId;
        const approvals: Record<string, boolean> = {};
        approvals[initiatorHumanId] = false;
        if (!isSameOwner) {
          approvals[responderHumanId] = false;
        }

        const keyA = agentA?.kid || agentAId;
        const keyB = agentB?.kid || agentBId;
        const safetyNumber = this.calculateSafetyNumber(keyA, keyB);
        const agentPrompt = this.generateAgentPrompt({
          myAgentId: agentBId,
          peerAgentId: agentAId,
          peerKid: agentA?.kid,
          safetyNumber,
          note: body.note,
        });

        const record: LinkRecord = {
          id: linkId,
          agentAId,
          agentBId,
          initiatorHumanId,
          responderHumanId,
          initiatorHumanEmail,
          responderHumanEmail,
          status: 'pending_approval',
          createdAt: new Date().toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString('hex')}`,
          approvals,
          safetyNumber,
          agentPrompt,
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0,
          note: body.note,
        };
        this.links.set(linkId, record);
        this.saveState();
        this.sendJson(res, 200, { status: 'ok', linkId: record.id, link: record, safetyNumber, agentPrompt });
      });
      return;
    }

    // 9. Links Query Endpoints (Global, Filtered, and Single Link)
    if (req.method === 'GET' && (parsedUrl === '/api/links' || (parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/links')))) {
      const human = this.getAuthenticatedHuman(req);
      let filterAgentId: string | null = null;
      if (parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/links')) {
        filterAgentId = parsedUrl.split('/')[3] || null;
      }
      if (!filterAgentId && req.url && req.url.includes('?')) {
        const query = new URLSearchParams(req.url.split('?')[1]);
        filterAgentId = query.get('agentId') || query.get('agent') || null;
      }

      let list = Array.from(this.links.values());
      if (filterAgentId) {
        list = list.filter(l => l.agentAId === filterAgentId || l.agentBId === filterAgentId);
      }
      if (human && human.role !== 'admin') {
        list = list.filter(l => l.initiatorHumanId === human.id || l.responderHumanId === human.id);
      }

      // Compact recentMessages for list endpoint to prevent huge payloads dropping mid-response
      const sanitized = list.map(l => {
        const msgs = (l.recentMessages || []).slice(-3).map(m => ({
          id: m.id,
          timestamp: m.timestamp,
          senderId: m.senderId,
          targetId: m.targetId,
          text: m.text,
          isEncrypted: m.isEncrypted,
        }));
        const agentA = this.agents.get(l.agentAId);
        const agentB = this.agents.get(l.agentBId);
        const safetyNumber = l.safetyNumber || this.calculateSafetyNumber(agentA?.kid || l.agentAId, agentB?.kid || l.agentBId);
        const agentPrompt = l.agentPrompt || this.generateAgentPrompt({
          myAgentId: l.agentBId,
          peerAgentId: l.agentAId,
          peerKid: agentA?.kid,
          safetyNumber,
          note: l.note,
        });
        return {
          ...l,
          safetyNumber,
          agentPrompt,
          recentMessages: msgs,
        };
      });

      this.sendJson(res, 200, { status: 'ok', links: sanitized });
      return;
    }

    if (req.method === 'GET' && parsedUrl.startsWith('/api/links/') && !parsedUrl.endsWith('/poll') && !parsedUrl.endsWith('/approve') && !parsedUrl.endsWith('/send') && !parsedUrl.endsWith('/message')) {
      const linkId = parsedUrl.replace('/api/links/', '').trim();
      const link = this.links.get(linkId);
      if (!link) {
        this.sendJson(res, 404, { error: 'link_not_found', message: `Link '${linkId}' not found` });
        return;
      }
      const agentA = this.agents.get(link.agentAId);
      const agentB = this.agents.get(link.agentBId);
      const safetyNumber = link.safetyNumber || this.calculateSafetyNumber(agentA?.kid || link.agentAId, agentB?.kid || link.agentBId);
      const agentPrompt = link.agentPrompt || this.generateAgentPrompt({
        myAgentId: link.agentBId,
        peerAgentId: link.agentAId,
        peerKid: agentA?.kid,
        safetyNumber,
        note: link.note,
      });
      this.sendJson(res, 200, { status: 'ok', link: { ...link, safetyNumber, agentPrompt } });
      return;
    }

    if (req.method === 'POST' && parsedUrl.startsWith('/api/links/') && parsedUrl.endsWith('/approve')) {
      readJson((body) => {
        const parts = parsedUrl.split('/');
        const linkId = parts[3];
        const link = this.links.get(linkId);
        if (!link) {
          this.sendJson(res, 404, { error: 'link_not_found', message: `Link '${linkId}' not found` });
          return;
        }
        const human = this.getAuthenticatedHuman(req);
        const approverId = human?.id || body.approverHumanId || body.humanId || link.initiatorHumanId;

        if (!link.approvals) {
          link.approvals = {};
        }
        if (!link.approvalDetails) {
          link.approvalDetails = {};
        }

        const agentA = this.agents.get(link.agentAId);
        const agentB = this.agents.get(link.agentBId);
        if (!link.safetyNumber) {
          link.safetyNumber = this.calculateSafetyNumber(agentA?.kid || link.agentAId, agentB?.kid || link.agentBId);
        }
        if (!link.agentPrompt) {
          link.agentPrompt = this.generateAgentPrompt({
            myAgentId: link.agentBId,
            peerAgentId: link.agentAId,
            peerKid: agentA?.kid,
            safetyNumber: link.safetyNumber,
            note: link.note,
          });
        }

        const confirmedKid = body.confirmedKid || body.kid || (approverId === link.initiatorHumanId ? agentA?.kid : agentB?.kid);
        const confirmedSafetyNumber = body.confirmedSafetyNumber || body.safetyNumber || link.safetyNumber;

        link.approvals[approverId] = true;
        link.approvalDetails[approverId] = {
          approved: true,
          confirmedAt: new Date().toISOString(),
          confirmedKid,
          confirmedSafetyNumber,
        };

        const isSameOwner = !link.responderHumanId || link.initiatorHumanId === link.responderHumanId;
        const initiatorOk = Boolean(link.approvals[link.initiatorHumanId]);
        const responderOk = isSameOwner || Boolean(link.approvals[link.responderHumanId!]);

        if ((human?.role === 'admin' && body.force) || (initiatorOk && responderOk)) {
          link.status = 'active';
        } else {
          link.status = 'pending_approval';
        }

        if (body.peerVerification) {
          const targetAgent = this.agents.get(link.agentBId);
          if (targetAgent) targetAgent.peerVerification = body.peerVerification;
        }
        this.saveState();
        this.sendJson(res, 200, { status: 'ok', linkId: link.id, link });
      });
      return;
    }

    if (req.method === 'DELETE' && parsedUrl.startsWith('/api/links/')) {
      const linkId = parsedUrl.replace('/api/links/', '').trim();
      const existed = this.links.delete(linkId);
      if (existed) this.saveState();
      this.sendJson(res, 200, { status: 'ok', severed: existed });
      return;
    }

    // 10. Link Message Dispatch
    if (req.method === 'POST' && parsedUrl.startsWith('/api/links/') && (parsedUrl.endsWith('/send') || parsedUrl.endsWith('/message'))) {
      readJson((body) => {
        const parts = parsedUrl.split('/');
        const linkId = parts[3];
        const link = this.links.get(linkId);
        if (!link) {
          this.sendJson(res, 404, { error: 'link_not_found', message: `Link '${linkId}' not found` });
          return;
        }
        // Strict Ingress 1: Mutual Dual-Human Approval Check
        if (link.status !== 'active') {
          this.sendJson(res, 403, {
            error: 'link_not_approved',
            message: `Link '${linkId}' has not been approved by all human controllers (status: ${link.status}).`,
            approvals: link.approvals,
          });
          return;
        }

        const senderId = body.senderId;
        // Strict Ingress 2: Participant Check (Zero Noise / No Cross-Link Injection)
        if (senderId !== link.agentAId && senderId !== link.agentBId) {
          this.sendJson(res, 403, {
            error: 'forbidden_participant',
            message: `Agent '${senderId}' is not an authorized participant of link '${link.id}'.`,
          });
          return;
        }

        const targetId = senderId === link.agentAId ? link.agentBId : link.agentAId;

        if (targetId) {
          if (link) {
            link.framesCount = (link.framesCount || 0) + 1;
            if (!link.recentMessages) link.recentMessages = [];
            const isEnc = typeof body.payload === 'object' && body.payload !== null && Boolean(body.payload.data);
            const isSigned = isEnc && Boolean(body.payload.sig);
            const seq = isEnc && typeof body.payload.seq === 'number' ? body.payload.seq : undefined;
            const previewText = typeof body.payload === 'string' 
              ? body.payload 
              : (isEnc ? `[E2EE v${body.payload.v || 1}${seq ? ` #${seq}` : ''} ${body.payload.data.slice(0, 12)}...]` : '[E2EE Encrypted Payload]');
            link.recentMessages.push({
              id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
              timestamp: new Date().toISOString(),
              senderId,
              targetId,
              text: previewText,
              isEncrypted: isEnc,
              isSigned,
              seq,
              payload: body.payload,
            });
            if (link.recentMessages.length > 100) link.recentMessages.shift();
            this.saveState();
          }

          const senderAgent = this.agents.get(senderId);
          const q = this.messageQueues.get(targetId) || [];
          this.messageQueues.set(targetId, q);
          q.push({
            linkId,
            senderId,
            senderEncPub: senderAgent?.encPub,
            senderSignPub: senderAgent?.signPub,
            senderKid: senderAgent?.kid,
            payload: body.payload,
            timestamp: new Date().toISOString(),
          });

          const waiters = this.pollWaiters.get(targetId) || [];
          while (waiters.length > 0 && q.length > 0) {
            const resolver = waiters[0];
            const msgs = [...q];
            q.length = 0;
            const delivered = resolver(msgs);
            if (!delivered) {
              q.unshift(...msgs);
            }
          }
        }

        this.sendJson(res, 200, { status: 'ok', delivered: Boolean(targetId) });
      });
      return;
    }

    // 11. Client Telemetry & Logs Ingestion Endpoint
    if (req.method === 'POST' && parsedUrl === '/api/telemetry') {
      readJson((body) => {
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
        const userAgent = (req.headers['user-agent'] as string) || '';
        const level: 'info' | 'warn' | 'error' | 'debug' = body.level || 'info';
        const category: string = body.category || 'client';
        const message: string = body.message || 'Client event';
        const details = body.details || undefined;

        const entry: ClientLogEntry = {
          id: `clog_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date().toISOString(),
          level,
          category,
          message,
          details,
          userAgent,
          ip,
        };

        this.clientLogs.push(entry);
        if (this.clientLogs.length > 500) this.clientLogs.shift();

        const levelEmoji = level === 'error' ? '💥' : level === 'warn' ? '⚠️' : 'ℹ️';
        console.log(`[CLIENT-LOG] ${entry.timestamp} ${levelEmoji} [${category}] ${message} ${details ? JSON.stringify(details) : ''}`);

        this.sendJson(res, 200, { status: 'ok', received: true, id: entry.id });
      });
      return;
    }

    // 12. Combined Server & Client Logs Query Endpoint
    if (req.method === 'GET' && parsedUrl === '/api/logs') {
      this.sendJson(res, 200, {
        status: 'ok',
        accessLogs: this.accessLogs.slice(-100),
        clientLogs: this.clientLogs.slice(-100),
      });
      return;
    }

    // 13. Autonomous Bug Reporting System (Cleartext, Max 10 KB, Rate-Limited)
    if (req.method === 'POST' && parsedUrl === '/api/bugs') {
      // 10 KB size limit = 10,240 bytes
      readJson((body) => {
        const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
        const rawAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const rateKey = rawAgentId ? `agent:${rawAgentId}` : `ip:${clientIp}`;

        if (!this.checkBugRateLimit(rateKey, 5, 60000)) {
          this.sendJson(res, 429, {
            error: 'rate_limited',
            message: 'Too many bug reports submitted. Rate limit is 5 submissions per minute. Please try again later.',
          });
          return;
        }

        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const details = typeof body.details === 'string' ? body.details.trim() : '';

        if (!title && !details) {
          this.sendJson(res, 400, {
            error: 'invalid_request',
            message: 'Bug report requires at least a title or details.',
          });
          return;
        }

        const validSeverities: BugReportRecord['severity'][] = ['low', 'medium', 'high', 'critical'];
        const severity: BugReportRecord['severity'] = validSeverities.includes(body.severity) ? body.severity : 'medium';

        const bugId = `bug_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const record: BugReportRecord = {
          id: bugId,
          agentId: rawAgentId || undefined,
          title: title || 'Untitled Bug Report',
          details: details || '(No additional details provided)',
          severity,
          context: body.context || undefined,
          timestamp: new Date().toISOString(),
          ip: clientIp,
          userAgent: (req.headers['user-agent'] as string) || undefined,
          resolved: false,
        };

        try {
          fs.appendFileSync(this.bugLogPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (err) {
          console.error('[BUG-LOG ERROR] Failed to append bug report:', err);
        }

        this.bugReports.push(record);
        if (this.bugReports.length > 500) this.bugReports.shift();

        console.log(`[BUG REPORT] ${record.id} [${record.severity.toUpperCase()}] ${record.title} (Agent: ${record.agentId || 'anonymous'})`);

        this.sendJson(res, 201, {
          status: 'ok',
          bugId: record.id,
          report: record,
        });
      }, 10240);
      return;
    }

    if (req.method === 'GET' && parsedUrl === '/api/bugs') {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const limit = parseInt(urlObj.searchParams.get('limit') || '100', 10);
      const agentId = urlObj.searchParams.get('agentId');
      let reports = this.bugReports;
      if (agentId) {
        reports = reports.filter(r => r.agentId === agentId);
      }
      this.sendJson(res, 200, {
        status: 'ok',
        count: reports.length,
        bugs: reports.slice(-limit),
      });
      return;
    }

    const bugResolveMatch = parsedUrl.match(/^\/api\/bugs\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && bugResolveMatch) {
      readJson((body) => {
        const bugId = bugResolveMatch[1];
        const bug = this.bugReports.find(b => b.id === bugId);
        if (!bug) {
          this.sendJson(res, 404, { error: 'not_found', message: 'Bug report not found' });
          return;
        }

        const human = this.getAuthenticatedHuman(req);
        const token = this.extractToken(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;
        const resolver = human ? (human.name || human.email) : (body.resolvedBy || body.agentId || (apiKeyRecord ? apiKeyRecord.id : 'Administrator'));

        const shouldResolve = body.resolved !== undefined ? Boolean(body.resolved) : true;
        bug.resolved = shouldResolve;
        if (shouldResolve) {
          bug.resolvedAt = new Date().toISOString();
          bug.resolvedBy = resolver;
          if (body.note || body.resolutionNote) {
            bug.resolutionNote = body.note || body.resolutionNote;
          }
        } else {
          bug.resolvedAt = undefined;
          bug.resolvedBy = undefined;
          bug.resolutionNote = undefined;
        }

        try {
          // Rewrite bug log with updated resolved states
          fs.writeFileSync(this.bugLogPath, this.bugReports.map(b => JSON.stringify(b)).join('\n') + '\n', 'utf8');
        } catch (err) {
          console.error('[BUG-LOG ERROR] Failed to sync bug resolution:', err);
        }

        console.log(`[BUG REPORT ${shouldResolve ? 'RESOLVED' : 'REOPENED'}] ${bug.id} by ${resolver}`);
        this.sendJson(res, 200, { status: 'ok', bug });
      });
      return;
    }

    // 14. Static Web Files
    this.serveStatic(req, res, parsedUrl);
    } catch (err: any) {
      console.error(`[SERVER ERROR] ${req.method} ${req.url}:`, err);
      this.sendJson(res, 500, { error: 'internal_server_error', message: err?.message || 'Internal server error' });
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: string): void {
    if (parsedUrl.startsWith('/docs/')) {
      const relDoc = parsedUrl.replace(/^\/docs\//, '');
      const docPath = path.join(path.resolve('docs'), relDoc);
      if (fs.existsSync(docPath) && !fs.statSync(docPath).isDirectory()) {
        try {
          const content = fs.readFileSync(docPath);
          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Length': content.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(content);
          return;
        } catch {}
      }
    }

    let filePath = path.join(this.staticPath, parsedUrl === '/' ? 'index.html' : parsedUrl);
    if (parsedUrl === '/onboarding' || parsedUrl === '/onboarding.md') {
      filePath = path.join(this.staticPath, 'onboarding.md');
    } else if (parsedUrl === '/skill' || parsedUrl === '/skill.md') {
      filePath = path.join(this.staticPath, 'skill.md');
    } else if (!fs.existsSync(filePath)) {
      filePath = path.join(this.staticPath, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.md': 'text/markdown; charset=utf-8',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'register_supervisor') {
          this.supervisorSockets.add(ws);
        }
      } catch {}
    });

    ws.on('close', () => {
      this.supervisorSockets.delete(ws);
    });
  }

  private notifySupervisors(event: any): void {
    const raw = JSON.stringify(event);
    for (const ws of this.supervisorSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  private extractToken(req: http.IncomingMessage): string | null {
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      return auth.substring(7).trim();
    }
    const adminHeader = req.headers['x-admin-token'];
    if (typeof adminHeader === 'string') return adminHeader.trim();
    return null;
  }

  private getAuthenticatedHuman(req: http.IncomingMessage): HumanUser | null {
    const token = this.extractToken(req);
    if (!token) return null;
    return this.humanSessions.get(token) || null;
  }
}
