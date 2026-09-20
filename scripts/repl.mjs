#!/usr/bin/env node
/**
 * AgentMesh Multi-Pane Terminal REPL & Live Telemetry Monitor
 *
 * Interactive 5-pane TUI terminal interface:
 * ┌───────────────────┬───────────────────┬───────────────────┐
 * │ Bot A Shell       │ Human Operator    │ Bot B Shell       │
 * │ Bot A > _________ │ Human > _________ │ Bot B > _________ │
 * ├───────────────────┴───────────────────┴───────────────────┤
 * │ Encrypted Flow with Wire IDs (Real-Time Transit)          │
 * ├───────────────────────────────────────────────────────────┤
 * │ Decrypted Flow using Human Key (Link Telemetry Viewer)    │
 * └───────────────────────────────────────────────────────────┘
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// Attempt to load .env from current directory or SignetMesh
for (const envPath of ['.env', '../SignetMesh/.env', '../../SignetMesh/.env']) {
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    } catch {}
    break;
  }
}

// -----------------------------------------------------------------------------
// Cryptographic Identity & Encryption Helpers
// -----------------------------------------------------------------------------
export function generateAgentKeys(agentId) {
  const edKey = crypto.generateKeyPairSync('ed25519');
  const xKey = crypto.generateKeyPairSync('x25519');

  const extractRawPublicKey = (key) => {
    const spki = key.export({ type: 'spki', format: 'der' });
    return spki.subarray(spki.length - 32);
  };

  const signPubRaw = extractRawPublicKey(crypto.createPublicKey(edKey.privateKey));
  const encPubRaw = extractRawPublicKey(crypto.createPublicKey(xKey.privateKey));
  const kid = `kid-${agentId}-${crypto.createHash('sha256').update(signPubRaw).digest('hex').slice(0, 16)}`;

  return {
    agentId,
    kid,
    edKey,
    xKey,
    signPubRaw,
    encPubRaw,
    signPubB64: signPubRaw.toString('base64'),
    encPubB64: encPubRaw.toString('base64'),
  };
}

export function deriveSharedKey(myPrivKey, peerPubKey, linkId) {
  const shared = crypto.diffieHellman({
    privateKey: myPrivKey,
    publicKey: peerPubKey,
  });
  const salt = crypto.createHash('sha256').update(linkId).digest();
  const info = Buffer.from(`AgentLink-v2-E2EE:${linkId}`);
  return crypto.hkdfSync('sha256', shared, salt, info, 32);
}

export function encryptPayload(derivedKey, plaintext, linkId, senderId, targetId, seq, nonce = null) {
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`v2:${linkId}:${senderId}:${targetId}:${seq}:${n}`);

  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const data = Buffer.concat([encrypted, authTag]);

  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    nonce: n,
    seq,
  };
}

export function decryptPayload(derivedKey, ivB64, dataB64, linkId, senderId, targetId, seq, nonce) {
  const iv = Buffer.from(ivB64, 'base64');
  const rawData = Buffer.from(dataB64, 'base64');
  const ciphertext = rawData.subarray(0, rawData.length - 16);
  const authTag = rawData.subarray(rawData.length - 16);
  const aad = Buffer.from(`v2:${linkId}:${senderId}:${targetId}:${seq}:${nonce}`);

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function signEnvelope(edPrivKey, canonicalStr) {
  return crypto.sign(null, Buffer.from(canonicalStr), edPrivKey).toString('base64');
}

// -----------------------------------------------------------------------------
// REPL State Manager
// -----------------------------------------------------------------------------
export class ReplManager {
  constructor(options = {}) {
    this.serverUrl = (options.serverUrl || process.env.PORTAL_URL || process.env.TARGET_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
    this.adminEmail = options.adminEmail || process.env.ADMIN_EMAIL || 'admin@signetmesh.internal';
    this.adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD || '';
    this.adminToken = null;

    this.botA = generateAgentKeys(options.botAId || 'bot-alpha');
    this.botB = generateAgentKeys(options.botBId || 'bot-beta');

    this.activeLinkId = null;
    this.linkRecord = null;
    this.seqAtoB = 0;
    this.seqBtoA = 0;

    // Derived symmetric keys for E2EE
    this.symKeyA = null;
    this.symKeyB = null;

    // Panes logs
    this.logs = {
      botA: [],
      human: [],
      botB: [],
      encrypted: [],
      decrypted: [],
    };

    // Active focus: 0 = botA, 1 = human, 2 = botB
    this.activePaneIndex = 0;
    this.panes = ['botA', 'human', 'botB'];

    this.inputBuffers = {
      botA: '',
      human: '',
      botB: '',
    };

    this.history = {
      botA: [],
      human: [],
      botB: [],
    };
    this.historyIndex = { botA: -1, human: -1, botB: -1 };

    this.ws = null;
    this.pollInterval = null;
    this.isRunning = false;
  }

  log(pane, msg) {
    const list = this.logs[pane];
    if (list) {
      list.push(msg);
      if (list.length > 200) list.shift();
    }
  }

  getActivePane() {
    return this.panes[this.activePaneIndex];
  }

  switchPane(index) {
    if (index >= 0 && index < this.panes.length) {
      this.activePaneIndex = index;
    }
  }

  cyclePane(direction = 1) {
    this.activePaneIndex = (this.activePaneIndex + direction + this.panes.length) % this.panes.length;
  }

  // HTTP Helper
  async apiRequest(endpoint, opts = {}) {
    const url = `${this.serverUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    };
    if (this.adminToken && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.adminToken}`;
    }

    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(data.message || `HTTP ${res.status}: ${res.statusText}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Setup: Authenticate Human & Register Both Bots
  async initialize() {
    this.log('human', `Connecting to Mesh at ${this.serverUrl}...`);

    // 1. Authenticate human operator if adminPassword provided
    if (this.adminPassword) {
      try {
        const authRes = await this.apiRequest('/api/auth/login', {
          method: 'POST',
          body: {
            email: this.adminEmail,
            password: this.adminPassword,
          },
        });
        if (authRes.token) {
          this.adminToken = authRes.token;
          this.log('human', `✅ Operator authenticated as ${authRes.user?.email || 'admin'} (Role: ${authRes.user?.role})`);
        }
      } catch (err) {
        this.log('human', `⚠️ Operator login note: ${err.message} (Proceeding with local permissions)`);
      }
    }

    // 2. Register Bot A
    try {
      await this.apiRequest('/api/agents/register', {
        method: 'POST',
        body: {
          agentId: this.botA.agentId,
          signPub: this.botA.signPubB64,
          encPub: this.botA.encPubB64,
          kid: this.botA.kid,
        },
      });
      this.log('botA', `✅ ${this.botA.agentId} registered (KID: ${this.botA.kid.slice(0, 16)}...)`);
    } catch (err) {
      this.log('botA', `ℹ️ Registration: ${err.message}`);
    }

    // 3. Register Bot B
    try {
      await this.apiRequest('/api/agents/register', {
        method: 'POST',
        body: {
          agentId: this.botB.agentId,
          signPub: this.botB.signPubB64,
          encPub: this.botB.encPubB64,
          kid: this.botB.kid,
        },
      });
      this.log('botB', `✅ ${this.botB.agentId} registered (KID: ${this.botB.kid.slice(0, 16)}...)`);
    } catch (err) {
      this.log('botB', `ℹ️ Registration: ${err.message}`);
    }

    this.log('human', `🤖 Fleet agents ready: ${this.botA.agentId} & ${this.botB.agentId}.`);
    this.log('human', `👉 Link them via Web UI (${this.serverUrl}) or type "link" in Human shell.`);

    // 4. Connect WebSocket for Real-Time Supervisor Wire Events
    this.connectSupervisorWs();

    // 5. Initial link check & background sync
    await this.syncLinks();
    this.startBackgroundPolling();
  }

  connectSupervisorWs() {
    try {
      const wsUrl = `${this.serverUrl.replace(/^http/, 'ws')}/ws`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        if (this.adminToken) {
          this.ws.send(JSON.stringify({
            type: 'register_supervisor',
            token: this.adminToken,
          }));
        }
      });

      this.ws.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'message_sent' && event.linkId === this.activeLinkId) {
            await this.refreshLinkTelemetry();
          } else if (event.type === 'link_approved' || event.type === 'link_requested') {
            await this.syncLinks();
          }
        } catch {}
      });

      this.ws.on('error', () => {});
      this.ws.on('close', () => {
        if (this.isRunning) {
          setTimeout(() => this.connectSupervisorWs(), 3000);
        }
      });
    } catch {}
  }

  async syncLinks() {
    try {
      const res = await this.apiRequest('/api/links');
      const links = res.links || [];
      const pairLink = links.find(l => 
        (l.agentAId === this.botA.agentId && l.agentBId === this.botB.agentId) ||
        (l.agentAId === this.botB.agentId && l.agentBId === this.botA.agentId)
      );

      if (pairLink) {
        this.activeLinkId = pairLink.id;
        this.linkRecord = pairLink;

        if (pairLink.status === 'active' && !this.symKeyA) {
          // Derive symmetric E2EE keys
          try {
            const pubB = crypto.createPublicKey({
              key: Buffer.concat([
                Buffer.from('302a300506032b656e032100', 'hex'),
                this.botB.encPubRaw
              ]),
              format: 'der',
              type: 'spki',
            });
            const pubA = crypto.createPublicKey({
              key: Buffer.concat([
                Buffer.from('302a300506032b656e032100', 'hex'),
                this.botA.encPubRaw
              ]),
              format: 'der',
              type: 'spki',
            });
            this.symKeyA = deriveSharedKey(this.botA.xKey.privateKey, pubB, pairLink.id);
            this.symKeyB = deriveSharedKey(this.botB.xKey.privateKey, pubA, pairLink.id);

            this.log('botA', `🔒 Link ${pairLink.id} ACTIVE! E2EE Session Key Established.`);
            this.log('botB', `🔒 Link ${pairLink.id} ACTIVE! E2EE Session Key Established.`);
            this.log('human', `✅ Link ${pairLink.id} (${this.botA.agentId} ⟷ ${this.botB.agentId}) is ACTIVE!`);
          } catch (err) {
            this.log('human', `Key derivation error: ${err.message}`);
          }
        }
        await this.refreshLinkTelemetry();
      }
    } catch {}
  }

  async refreshLinkTelemetry() {
    if (!this.activeLinkId) return;
    try {
      const res = await this.apiRequest(`/api/links/${encodeURIComponent(this.activeLinkId)}`);
      const link = res.link;
      if (!link) return;
      this.linkRecord = link;

      const msgs = link.recentMessages || [];
      // Process messages into encrypted and decrypted flow panes
      for (const m of msgs) {
        const msgKey = m.id || `${m.timestamp}_${m.seq}`;
        if (!this.processedMsgIds) this.processedMsgIds = new Set();
        if (this.processedMsgIds.has(msgKey)) continue;
        this.processedMsgIds.add(msgKey);

        const isFromA = m.senderId === this.botA.agentId;
        const target = isFromA ? this.botB.agentId : this.botA.agentId;
        const timestampStr = new Date(m.timestamp).toLocaleTimeString();

        // 1. Middle Pane: Encrypted Flow with Wire IDs
        if (m.isEncrypted && m.payload) {
          const cipherSnippet = m.payload.data ? m.payload.data.slice(0, 20) : 'encrypted';
          const sizeBytes = m.payload.data ? Buffer.byteLength(m.payload.data, 'base64') : 0;
          this.log('encrypted', `[WIRE #${m.seq || '?'}] Link: ${this.activeLinkId} | ${m.senderId} ➔ ${target} | ${sizeBytes} B | E2EE v${m.payload.v || 2} (aes-256-gcm) | cipher: ${cipherSnippet}...`);
        } else {
          this.log('encrypted', `[WIRE] Link: ${this.activeLinkId} | ${m.senderId} ➔ ${target} | Plaintext/Operator Frame | Text: "${(m.text || '').slice(0, 30)}"`);
        }

        // 2. Bottom Pane: Decrypted Flow using Human / Peer Key (Link Telemetry View)
        let plaintext = m.text || '';
        if (m.isEncrypted && m.payload && m.payload.data && m.payload.iv) {
          try {
            const symKey = isFromA ? this.symKeyB : this.symKeyA;
            if (symKey) {
              plaintext = decryptPayload(
                symKey,
                m.payload.iv,
                m.payload.data,
                this.activeLinkId,
                m.senderId,
                target,
                m.seq,
                m.payload.nonce
              );
            }
          } catch {
            plaintext = `[Ciphertext: ${m.payload.data.slice(0, 16)}...]`;
          }
        }

        // Deliver notification to recipient bot shell
        if (isFromA) {
          this.log('botB', `📥 [Received from ${this.botA.agentId}]: "${plaintext}"`);
        } else if (m.senderId === this.botB.agentId) {
          this.log('botA', `📥 [Received from ${this.botB.agentId}]: "${plaintext}"`);
        }

        // Format decrypted conversation bubble matching Web UI
        const senderBadge = m.senderType === 'operator' ? '👑 Human Operator' : (isFromA ? '🟣 ' + this.botA.agentId : '🔵 ' + this.botB.agentId);
        const tag = m.isEncrypted ? (m.isSigned ? '🔒 E2EE Signed' : '🔒 E2EE') : '👤 Operator Dispatch';
        this.log('decrypted', `${senderBadge} ➔ ${target} [#${m.seq || 0}, ${timestampStr}] [${tag}] "${plaintext}"`);
      }
    } catch {}
  }

  startBackgroundPolling() {
    this.isRunning = true;
    this.pollInterval = setInterval(async () => {
      await this.syncLinks();
    }, 2500);
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.ws) this.ws.close();
  }

  // ---------------------------------------------------------------------------
  // Command Execution (Bot A, Human, Bot B)
  // ---------------------------------------------------------------------------
  async executeCommand(pane, line) {
    const raw = line.trim();
    if (!raw) return;

    // Save to history
    this.history[pane].push(raw);
    this.historyIndex[pane] = this.history[pane].length;

    // Support prefix routing: e.g. "b: send hello" or "h: approve"
    if (/^[ab]:\s*/i.test(raw)) {
      const targetPane = raw[0].toLowerCase() === 'a' ? 'botA' : 'botB';
      return this.executeCommand(targetPane, raw.slice(2).trim());
    } else if (/^h:\s*/i.test(raw)) {
      return this.executeCommand('human', raw.slice(2).trim());
    }

    const [cmd, ...args] = raw.split(/\s+/);
    const cmdLower = cmd.toLowerCase();

    // Common commands
    if (cmdLower === 'help') {
      if (pane === 'human') {
        this.log('human', '📖 Human Commands:');
        this.log('human', '   • approve <linkId>       - Approve pending link between agents');
        this.log('human', '   • link                   - Request & auto-approve link between Bot A and B');
        this.log('human', '   • send <msg>             - Dispatch operator message across active link');
        this.log('human', '   • links                  - List all links in the mesh');
        this.log('human', '   • agents                 - List registered fleet agents');
        this.log('human', '   • status                 - Check mesh connection status');
        this.log('human', '   • clear                  - Clear terminal pane');
        this.log('human', '   • exit                   - Quit REPL');
      } else {
        const botName = pane === 'botA' ? this.botA.agentId : this.botB.agentId;
        this.log(pane, `📖 ${botName} Commands:`);
        this.log(pane, '   • send <message text>    - Send E2EE encrypted message to peer');
        this.log(pane, '   • whoami                 - Display agent ID, key ID, and public keys');
        this.log(pane, '   • links                  - View link state with peer');
        this.log(pane, '   • clear                  - Clear terminal pane');
        this.log(pane, '   • exit                   - Quit REPL');
      }
      return;
    }

    if (cmdLower === 'clear') {
      this.logs[pane] = [];
      return;
    }

    if (cmdLower === 'exit' || cmdLower === 'quit') {
      this.stop();
      process.exit(0);
    }

    // -------------------------------- Bot A / Bot B Execution ----------------
    if (pane === 'botA' || pane === 'botB') {
      const isA = pane === 'botA';
      const sender = isA ? this.botA : this.botB;
      const recipient = isA ? this.botB : this.botA;
      const symKey = isA ? this.symKeyA : this.symKeyB;

      if (cmdLower === 'whoami') {
        this.log(pane, `Agent: ${sender.agentId} | KID: ${sender.kid}`);
        this.log(pane, `Signing Pub: ${sender.signPubB64}`);
        this.log(pane, `Encrypt Pub: ${sender.encPubB64}`);
        return;
      }

      if (cmdLower === 'links') {
        if (this.activeLinkId && this.linkRecord) {
          this.log(pane, `Link ID: ${this.activeLinkId} [${this.linkRecord.status.toUpperCase()}] Peer: ${recipient.agentId}`);
        } else {
          this.log(pane, `No active link established yet. Request and approve via UI or Human shell.`);
        }
        return;
      }

      if (cmdLower === 'send') {
        if (!this.activeLinkId || !this.linkRecord || this.linkRecord.status !== 'active' || !symKey) {
          this.log(pane, `❌ Cannot send: Link with ${recipient.agentId} is not active yet! Link via UI first.`);
          return;
        }

        // Support send "message" or send message text
        let messageText = args.join(' ');
        if (messageText.startsWith('"') && messageText.endsWith('"')) {
          messageText = messageText.slice(1, -1);
        }
        if (!messageText) {
          this.log(pane, `Usage: send <message>`);
          return;
        }

        const seq = isA ? ++this.seqAtoB : ++this.seqBtoA;
        const enc = encryptPayload(symKey, messageText, this.activeLinkId, sender.agentId, recipient.agentId, seq);

        const canonicalStr = `v2:${this.activeLinkId}:${sender.agentId}:${recipient.agentId}:${seq}:${Date.now()}:${enc.nonce}:${enc.iv}:${enc.data}`;
        const sig = signEnvelope(sender.edKey.privateKey, canonicalStr);

        try {
          await this.apiRequest(`/api/links/${encodeURIComponent(this.activeLinkId)}/send`, {
            method: 'POST',
            body: {
              senderId: sender.agentId,
              targetId: recipient.agentId,
              payload: {
                v: 2,
                kid: sender.kid,
                nonce: enc.nonce,
                seq: enc.seq,
                timestamp: Date.now(),
                iv: enc.iv,
                data: enc.data,
                sig,
              },
            },
          });

          this.log(pane, `🚀 Sent E2EE message #${seq} to ${recipient.agentId}: "${messageText}"`);
          await this.refreshLinkTelemetry();
        } catch (err) {
          this.log(pane, `❌ Send failed: ${err.message}`);
        }
        return;
      }

      this.log(pane, `Unknown command: "${cmd}". Type "help" for command list.`);
      return;
    }

    // -------------------------------- Human Execution ------------------------
    if (pane === 'human') {
      if (cmdLower === 'status') {
        this.log('human', `Mesh Server: ${this.serverUrl}`);
        this.log('human', `Active Link: ${this.activeLinkId || 'none'} (${this.linkRecord?.status || 'unlinked'})`);
        this.log('human', `Bot A: ${this.botA.agentId} | Bot B: ${this.botB.agentId}`);
        return;
      }

      if (cmdLower === 'agents') {
        try {
          const res = await this.apiRequest('/api/agents');
          const agents = res.agents || [];
          this.log('human', `Fleet Agents (${agents.length}):`);
          for (const a of agents) {
            this.log('human', `  • ${a.id} (KID: ${a.kid || 'n/a'}) [${a.registered ? 'Registered' : 'Pending'}]`);
          }
        } catch (err) {
          this.log('human', `❌ Failed to list agents: ${err.message}`);
        }
        return;
      }

      if (cmdLower === 'links') {
        try {
          const res = await this.apiRequest('/api/links');
          const links = res.links || [];
          this.log('human', `Mesh Links (${links.length}):`);
          for (const l of links) {
            this.log('human', `  • ${l.id}: ${l.agentAId} ⟷ ${l.agentBId} [${l.status.toUpperCase()}]`);
          }
        } catch (err) {
          this.log('human', `❌ Failed to list links: ${err.message}`);
        }
        return;
      }

      if (cmdLower === 'link') {
        try {
          this.log('human', `Initiating link request: ${this.botA.agentId} ⟷ ${this.botB.agentId}...`);
          const reqRes = await this.apiRequest('/api/links/request', {
            method: 'POST',
            body: {
              agentAId: this.botA.agentId,
              agentBId: this.botB.agentId,
            },
          });
          const linkId = reqRes.linkId || reqRes.link?.id;
          this.log('human', `Approving link ${linkId} with human supervisor authority...`);
          await this.apiRequest(`/api/links/${encodeURIComponent(linkId)}/approve`, {
            method: 'POST',
            body: { force: true },
          });
          this.log('human', `✅ Link ${linkId} approved and active!`);
          await this.syncLinks();
        } catch (err) {
          this.log('human', `❌ Linking error: ${err.message}`);
        }
        return;
      }

      if (cmdLower === 'approve') {
        const targetId = args[0] || this.activeLinkId;
        if (!targetId) {
          this.log('human', 'Usage: approve <linkId>');
          return;
        }
        try {
          await this.apiRequest(`/api/links/${encodeURIComponent(targetId)}/approve`, {
            method: 'POST',
            body: { force: true },
          });
          this.log('human', `✅ Link ${targetId} approved!`);
          await this.syncLinks();
        } catch (err) {
          this.log('human', `❌ Approve failed: ${err.message}`);
        }
        return;
      }

      if (cmdLower === 'send') {
        if (!this.activeLinkId) {
          this.log('human', '❌ No active link established to dispatch operator message.');
          return;
        }
        let msg = args.join(' ');
        if (msg.startsWith('"') && msg.endsWith('"')) msg = msg.slice(1, -1);
        if (!msg) {
          this.log('human', 'Usage: send <message>');
          return;
        }

        try {
          await this.apiRequest(`/api/links/${encodeURIComponent(this.activeLinkId)}/send`, {
            method: 'POST',
            body: {
              senderId: this.botA.agentId,
              targetId: this.botB.agentId,
              senderType: 'operator',
              operatorEmail: this.adminEmail,
              payload: msg,
            },
          });
          this.log('human', `👑 Dispatched operator message across link ${this.activeLinkId}: "${msg}"`);
          await this.refreshLinkTelemetry();
        } catch (err) {
          this.log('human', `❌ Operator dispatch failed: ${err.message}`);
        }
        return;
      }

      this.log('human', `Unknown command: "${cmd}". Type "help" for operator commands.`);
    }
  }

  // Auto-complete logic
  getCompletions(pane, buffer) {
    const commonCommands = ['help', 'clear', 'exit'];
    const botCommands = ['send', 'send "', 'whoami', 'links', ...commonCommands];
    const humanCommands = ['approve', 'link', 'send', 'links', 'agents', 'status', ...commonCommands];

    const pool = pane === 'human' ? humanCommands : botCommands;
    const lower = buffer.toLowerCase();
    return pool.filter(c => c.toLowerCase().startsWith(lower));
  }
}

// -----------------------------------------------------------------------------
// Terminal ANSI TUI Renderer
// -----------------------------------------------------------------------------
export class TuiRenderer {
  constructor(manager) {
    this.manager = manager;
    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 36;
    this.boundResize = this.onResize.bind(this);
  }

  start() {
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen buffer
    process.stdout.write('\x1b[?25h');   // Ensure cursor visible
    process.stdout.on('resize', this.boundResize);
    this.render();
  }

  stop() {
    process.stdout.removeListener('resize', this.boundResize);
    process.stdout.write('\x1b[?1049l'); // Leave alternate screen buffer
  }

  onResize() {
    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 36;
    this.render();
  }

  // Draw box border with text
  render() {
    const W = Math.max(this.cols, 80);
    const H = Math.max(this.rows, 28);

    // Heights allocation
    const topH = Math.max(10, Math.floor(H * 0.40));
    const midH = Math.max(6, Math.floor(H * 0.22));
    const botH = H - topH - midH - 2;

    const colW1 = Math.floor((W - 4) / 3);
    const colW2 = colW1;
    const colW3 = W - 4 - colW1 - colW2;

    let buf = '\x1b[H'; // Cursor to top-left

    const activeIdx = this.manager.activePaneIndex;

    // Helper: truncate or pad string
    const formatCell = (str, len) => {
      // Strip ANSI for length calculation
      const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
      if (stripped.length > len) {
        return str.slice(0, len);
      }
      return str + ' '.repeat(Math.max(0, len - stripped.length));
    };

    // 1. Top Row: 3 Columns (Bot A | Human | Bot B)
    const titleA = activeIdx === 0 ? `\x1b[1;35m[1] Bot A: ${this.manager.botA.agentId} (ACTIVE)\x1b[0m` : `[1] Bot A: ${this.manager.botA.agentId}`;
    const titleH = activeIdx === 1 ? `\x1b[1;33m[2] Human Operator (ACTIVE)\x1b[0m` : `[2] Human Operator`;
    const titleB = activeIdx === 2 ? `\x1b[1;36m[3] Bot B: ${this.manager.botB.agentId} (ACTIVE)\x1b[0m` : `[3] Bot B: ${this.manager.botB.agentId}`;

    buf += `┌─ ${titleA} ${'─'.repeat(Math.max(0, colW1 - 18))}┬─ ${titleH} ${'─'.repeat(Math.max(0, colW2 - 22))}┬─ ${titleB} ${'─'.repeat(Math.max(0, colW3 - 18))}┐\n`;

    const logsA = this.manager.logs.botA.slice(-(topH - 3));
    const logsH = this.manager.logs.human.slice(-(topH - 3));
    const logsB = this.manager.logs.botB.slice(-(topH - 3));

    for (let r = 0; r < topH - 3; r++) {
      const lineA = formatCell(logsA[r] || '', colW1);
      const lineH = formatCell(logsH[r] || '', colW2);
      const lineB = formatCell(logsB[r] || '', colW3);
      buf += `│${lineA}│${lineH}│${lineB}│\n`;
    }

    // Prompt row for top columns
    const promptA = `Bot A > ${this.manager.inputBuffers.botA}`;
    const promptH = `Human > ${this.manager.inputBuffers.human}`;
    const promptB = `Bot B > ${this.manager.inputBuffers.botB}`;

    const cellPromptA = activeIdx === 0 ? `\x1b[1;35m${formatCell(promptA, colW1)}\x1b[0m` : formatCell(promptA, colW1);
    const cellPromptH = activeIdx === 1 ? `\x1b[1;33m${formatCell(promptH, colW2)}\x1b[0m` : formatCell(promptH, colW2);
    const cellPromptB = activeIdx === 2 ? `\x1b[1;36m${formatCell(promptB, colW3)}\x1b[0m` : formatCell(promptB, colW3);

    buf += `├${'─'.repeat(colW1)}┼${'─'.repeat(colW2)}┼${'─'.repeat(colW3)}┤\n`;
    buf += `│${cellPromptA}│${cellPromptH}│${cellPromptB}│\n`;

    // 2. Middle Row: Encrypted flow with IDs (Full Width)
    buf += `├─ \x1b[1;32m📦 Encrypted Flow with Wire IDs (Real-Time Transit)\x1b[0m ${'─'.repeat(Math.max(0, W - 53))}┤\n`;
    const logsEnc = this.manager.logs.encrypted.slice(-(midH - 2));
    for (let r = 0; r < midH - 2; r++) {
      const lineEnc = formatCell(logsEnc[r] || '', W - 2);
      buf += `│${lineEnc}│\n`;
    }

    // 3. Bottom Row: Decrypted flow using Human Key (Full Width)
    buf += `├─ \x1b[1;34m💬 Decrypted Flow using Human Key (Link Telemetry & Conversation Flow)\x1b[0m ${'─'.repeat(Math.max(0, W - 72))}┤\n`;
    const logsDec = this.manager.logs.decrypted.slice(-(botH - 2));
    for (let r = 0; r < botH - 2; r++) {
      const lineDec = formatCell(logsDec[r] || '', W - 2);
      buf += `│${lineDec}│\n`;
    }

    buf += `└─ \x1b[2m[Tab] Switch Shell (1: Bot A | 2: Human | 3: Bot B) • [Ctrl+C] Exit • Type "help"\x1b[0m ${'─'.repeat(Math.max(0, W - 80))}┘`;

    process.stdout.write(buf);

    // Place cursor at active prompt
    const promptY = topH;
    let promptX = 1;
    let curBuffer = '';
    if (activeIdx === 0) {
      promptX = 9 + this.manager.inputBuffers.botA.length;
    } else if (activeIdx === 1) {
      promptX = colW1 + 10 + this.manager.inputBuffers.human.length;
    } else {
      promptX = colW1 + colW2 + 10 + this.manager.inputBuffers.botB.length;
    }
    process.stdout.write(`\x1b[${promptY};${Math.min(promptX, W - 1)}H`);
  }
}

// -----------------------------------------------------------------------------
// Interactive Keyboard Loop
// -----------------------------------------------------------------------------
export function runInteractive(manager) {
  const renderer = new TuiRenderer(manager);
  renderer.start();

  // Periodic redraw to render incoming messages & wire telemetry
  const renderInterval = setInterval(() => {
    renderer.render();
  }, 200);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', async (key) => {
      // Ctrl+C
      if (key === '\u0003') {
        clearInterval(renderInterval);
        renderer.stop();
        manager.stop();
        process.exit(0);
      }

      const activePane = manager.getActivePane();

      // Tab or Shift+Tab: Cycle active prompt pane
      if (key === '\t') {
        // If current buffer has text, attempt auto-completion first!
        const cur = manager.inputBuffers[activePane];
        if (cur.trim()) {
          const comps = manager.getCompletions(activePane, cur);
          if (comps.length > 0) {
            manager.inputBuffers[activePane] = comps[0];
            renderer.render();
            return;
          }
        }
        // Otherwise switch pane
        manager.cyclePane(1);
        renderer.render();
        return;
      }

      // Enter / Return: Submit command
      if (key === '\r' || key === '\n') {
        const cmd = manager.inputBuffers[activePane];
        manager.inputBuffers[activePane] = '';
        renderer.render();
        if (cmd.trim()) {
          await manager.executeCommand(activePane, cmd);
          renderer.render();
        }
        return;
      }

      // Backspace
      if (key === '\u0008' || key === '\x7f') {
        manager.inputBuffers[activePane] = manager.inputBuffers[activePane].slice(0, -1);
        renderer.render();
        return;
      }

      // Arrow Up / Down (Command History)
      if (key === '\u001b[A') {
        const hist = manager.history[activePane];
        if (hist.length > 0 && manager.historyIndex[activePane] > 0) {
          manager.historyIndex[activePane]--;
          manager.inputBuffers[activePane] = hist[manager.historyIndex[activePane]];
          renderer.render();
        }
        return;
      }
      if (key === '\u001b[B') {
        const hist = manager.history[activePane];
        if (manager.historyIndex[activePane] < hist.length - 1) {
          manager.historyIndex[activePane]++;
          manager.inputBuffers[activePane] = hist[manager.historyIndex[activePane]];
        } else {
          manager.historyIndex[activePane] = hist.length;
          manager.inputBuffers[activePane] = '';
        }
        renderer.render();
        return;
      }

      // Switch pane via hotkeys F1/F2/F3
      if (key === '\u001bOP') { manager.switchPane(0); renderer.render(); return; }
      if (key === '\u001bOQ') { manager.switchPane(1); renderer.render(); return; }
      if (key === '\u001bOR') { manager.switchPane(2); renderer.render(); return; }

      // Printable character
      if (key.length === 1 && key >= ' ') {
        manager.inputBuffers[activePane] += key;
        renderer.render();
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Direct Execution Entrypoint
// -----------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const manager = new ReplManager();
  manager.initialize().then(() => {
    runInteractive(manager);
  }).catch((err) => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}
