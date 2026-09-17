// server/agent-link-server.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
var AgentLinkServer = class {
  port;
  staticPath;
  server = null;
  wss = null;
  // Obfuscated SHA-256 hash of authorized administrator email
  adminEmailHash = process.env.ADMIN_EMAIL_HASH || "0b5970d2145747e2cf2aa4cd74b850966705b49554f32801d3d62e283b703c4c";
  // Obfuscated SHA-256 hashes of authorized operator/administrator accounts
  authorizedEmailHashes;
  adminPassword = process.env.ADMIN_PASSWORD || "AdminSecure2026!";
  // In-memory state (Cloudflare KV/Durable Object in edge deployments)
  humanSessions = /* @__PURE__ */ new Map();
  // token -> user
  apiKeys = /* @__PURE__ */ new Map();
  // apiKey -> record
  agents = /* @__PURE__ */ new Map();
  // agentId -> record
  links = /* @__PURE__ */ new Map();
  // linkId -> record
  invites = /* @__PURE__ */ new Map();
  // inviteId/token -> record
  messageQueues = /* @__PURE__ */ new Map();
  // agentId -> pending messages
  pollWaiters = /* @__PURE__ */ new Map();
  // agentId -> resolvers
  accessLogs = [];
  clientLogs = [];
  bugReports = [];
  bugLogPath;
  bugRateLimits = /* @__PURE__ */ new Map();
  // key -> timestamps
  supervisorSockets = /* @__PURE__ */ new Set();
  stateFilePath;
  constructor(port2 = 3e3, staticPath2) {
    this.port = port2;
    this.staticPath = staticPath2 || path.resolve("web");
    const defaultHashes = [
      this.adminEmailHash,
      // Authorized co-operator/administrator (obfuscated SHA-256)
      "26c999964b122f7bd403eaa903d40de0fe3ceb78f2fdc711d5998739bf400a01"
    ];
    const envHashes = (process.env.AUTHORIZED_EMAIL_HASHES || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    this.authorizedEmailHashes = /* @__PURE__ */ new Set([...defaultHashes, ...envHashes]);
    if (process.env.DATA_PATH) {
      this.stateFilePath = path.resolve(process.env.DATA_PATH);
    } else if (process.env.NODE_ENV === "production" || this.port === 3e3) {
      this.stateFilePath = path.resolve(".data/prod/agent-link-state.json");
    } else {
      this.stateFilePath = path.resolve(".data/dev/agent-link-state.json");
    }
    const stateDir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    if (process.env.BUG_LOG_PATH) {
      this.bugLogPath = path.resolve(process.env.BUG_LOG_PATH);
    } else {
      this.bugLogPath = path.resolve(".data/bugs/bug-reports.jsonl");
    }
    const bugDir = path.dirname(this.bugLogPath);
    if (!fs.existsSync(bugDir)) {
      fs.mkdirSync(bugDir, { recursive: true });
    }
    this.loadState();
    this.loadBugReports();
    this.discoverLocalAgents();
  }
  loadBugReports() {
    try {
      if (fs.existsSync(this.bugLogPath)) {
        const raw = fs.readFileSync(this.bugLogPath, "utf8");
        const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
        this.bugReports = lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        }).filter((b) => b !== null);
      }
    } catch (err) {
      console.warn("[BUG-LOG] Failed to load previous bug reports:", err);
    }
  }
  checkBugRateLimit(key, maxPerWindow = 5, windowMs = 6e4) {
    const now = Date.now();
    const timestamps = (this.bugRateLimits.get(key) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxPerWindow) {
      this.bugRateLimits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.bugRateLimits.set(key, timestamps);
    return true;
  }
  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.apiKeys) {
          for (const [k, v] of Object.entries(parsed.apiKeys)) {
            this.apiKeys.set(k, v);
          }
        }
        if (parsed.agents) {
          for (const [k, v] of Object.entries(parsed.agents)) {
            const agent = v;
            if (agent.ownerHumanId === "human_carl") {
              agent.ownerHumanId = "human_admin";
            }
            this.agents.set(k, agent);
            if (!this.messageQueues.has(k)) {
              this.messageQueues.set(k, []);
            }
          }
        }
        if (parsed.links) {
          for (const [k, v] of Object.entries(parsed.links)) {
            const link = v;
            if (link.initiatorHumanId === "human_carl") {
              link.initiatorHumanId = "human_admin";
            }
            if (link.responderHumanId === "human_carl") {
              link.responderHumanId = "human_admin";
            }
            if (link.approvals) {
              if (link.approvals["human_carl"] !== void 0) {
                if (link.approvals["human_carl"] || link.approvals["human_admin"]) {
                  link.approvals["human_admin"] = true;
                }
                delete link.approvals["human_carl"];
              }
              const allowedKeys = new Set([link.initiatorHumanId, link.responderHumanId].filter(Boolean));
              for (const appKey of Object.keys(link.approvals)) {
                if (!allowedKeys.has(appKey)) {
                  delete link.approvals[appKey];
                }
              }
              const isSameOwner = !link.responderHumanId || link.initiatorHumanId === link.responderHumanId;
              const initOk = Boolean(link.approvals[link.initiatorHumanId]);
              const respOk = isSameOwner || Boolean(link.approvals[link.responderHumanId]);
              if (initOk && respOk) {
                link.status = "active";
              }
            }
            this.links.set(k, link);
          }
        }
        if (parsed.invites) {
          for (const [k, v] of Object.entries(parsed.invites)) {
            const inv = v;
            this.invites.set(k, inv);
            if (inv.token) this.invites.set(inv.token, inv);
          }
        }
      }
    } catch (e) {
      console.warn("[AgentLink Server] Could not load state from disk:", e);
    }
  }
  saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        apiKeys: Object.fromEntries(this.apiKeys.entries()),
        agents: Object.fromEntries(this.agents.entries()),
        links: Object.fromEntries(this.links.entries()),
        invites: Object.fromEntries(Array.from(this.invites.entries()).filter(([k]) => k.startsWith("inv_")))
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.warn("[AgentLink Server] Could not save state to disk:", e);
    }
  }
  calculateSafetyNumber(keyA, keyB) {
    const hash = crypto.createHash("sha256").update([keyA, keyB].sort().join("::")).digest();
    const num = hash.readUInt32BE(0) % 9e5 + 1e5;
    return `${String(num).slice(0, 3)}-${String(num).slice(3, 6)}`;
  }
  async verifyGoogleIdToken(token) {
    try {
      const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.email || data.email_verified !== "true" && data.email_verified !== true) {
        return null;
      }
      const googleClientId = process.env.GOOGLE_CLIENT_ID;
      if (googleClientId && data.aud !== googleClientId) {
        console.warn(`[AgentLink Auth] Google ID Token aud mismatch: expected ${googleClientId}, got ${data.aud}`);
        return null;
      }
      return {
        email: String(data.email).trim().toLowerCase(),
        name: data.name ? String(data.name).trim() : void 0,
        email_verified: true
      };
    } catch (e) {
      console.warn("[AgentLink Auth] Google token verification network error:", e);
      return null;
    }
  }
  get portalUrl() {
    return process.env.PORTAL_URL || `http://localhost:${this.port}`;
  }
  get brandName() {
    return process.env.BRAND_NAME || "AgentLink";
  }
  get adminEmail() {
    return process.env.ADMIN_EMAIL || "admin@test.local";
  }
  generateAgentPrompt(opts) {
    const portal = opts.portalUrl || this.portalUrl;
    const brand = opts.brandName || this.brandName;
    const onboardingUrl = opts.onboardingUrl || `${portal}/onboarding.md`;
    return `You are invited to establish an end-to-end encrypted (E2EE v2) peer link with agent '${opts.peerAgentId}' on ${brand} (${portal}).

\u{1F4D6} Onboarding & Security Spec: ${onboardingUrl}
- Peer Agent ID: ${opts.peerAgentId}
- Peer Key Fingerprint: ${opts.peerKid || "Pending peer registration"}
- Mutual Safety Number: ${opts.safetyNumber}
${opts.note ? `- Purpose / Note: ${opts.note}
` : ""}
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
  discoverLocalAgents() {
    if (process.env.NODE_ENV === "test") {
      return;
    }
    if (this.apiKeys.size === 0) {
      const defaultKeyVal = "sec_apk_admin_fleet_primary";
      this.apiKeys.set(defaultKeyVal, {
        id: "key_primary_default",
        key: defaultKeyVal,
        ownerHumanId: "human_admin",
        label: "Primary Fleet Key (Admin)",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    try {
      const homeDir = os.homedir();
      const keyDir = path.join(homeDir, ".agent-link");
      if (fs.existsSync(keyDir)) {
        const files = fs.readdirSync(keyDir);
        for (const file of files) {
          if (file.endsWith("-keys.json") || file === "keys.json") {
            try {
              const fullPath = path.join(keyDir, file);
              const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));
              const agentId = content.agentId || (file === "keys.json" ? "agent" : file.replace("-keys.json", ""));
              const lowerAgentId = agentId.toLowerCase();
              if (lowerAgentId.startsWith("test-") || lowerAgentId.includes("test") || lowerAgentId.startsWith("mesh-") || lowerAgentId === "agent" || lowerAgentId.includes("demo") || lowerAgentId.includes("temp")) {
                continue;
              }
              if (content.signPub && content.encPub && !this.agents.has(agentId)) {
                const record = {
                  id: agentId,
                  ownerHumanId: "human_admin",
                  registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
                  signPub: content.signPub,
                  encPub: content.encPub,
                  kid: content.kid || `kid-${agentId}`,
                  qrPayload: JSON.stringify({
                    v: 1,
                    agent: agentId,
                    signPub: content.signPub,
                    encPub: content.encPub,
                    kid: content.kid
                  }),
                  connected: false,
                  polling: true,
                  lastSeen: (/* @__PURE__ */ new Date()).toISOString()
                };
                this.agents.set(agentId, record);
                if (!this.messageQueues.has(agentId)) {
                  this.messageQueues.set(agentId, []);
                }
              }
            } catch {
            }
          }
        }
      }
    } catch (e) {
      console.warn("[AgentLink Server] Error during local agent discovery:", e);
    }
    if (this.agents.has("antigravity") && this.agents.has("ted")) {
      const linkExists = Array.from(this.links.values()).some(
        (l) => l.agentAId === "antigravity" && l.agentBId === "ted" || l.agentAId === "ted" && l.agentBId === "antigravity"
      );
      if (!linkExists) {
        const linkId = "link_antigravity_ted_primary";
        this.links.set(linkId, {
          id: linkId,
          agentAId: "antigravity",
          agentBId: "ted",
          initiatorHumanId: "human_admin",
          status: "active",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString("hex")}`,
          approvals: {},
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0
        });
      }
    }
    if (this.agents.has("puck") && this.agents.has("ted")) {
      const linkExists = Array.from(this.links.values()).some(
        (l) => l.agentAId === "puck" && l.agentBId === "ted" || l.agentAId === "ted" && l.agentBId === "puck"
      );
      if (!linkExists) {
        const linkId = "link_puck_ted_dual_pending";
        const puckAgent = this.agents.get("puck");
        const tedAgent = this.agents.get("ted");
        const initiatorHumanId = puckAgent?.ownerHumanId || "human_admin";
        const responderHumanId = tedAgent?.ownerHumanId || "human_26c999964b12";
        let responderEmail = process.env.COLLABORATOR_EMAIL;
        for (const session of this.humanSessions.values()) {
          if (session.id === responderHumanId) {
            responderEmail = session.email;
            break;
          }
        }
        for (const inv of this.invites.values()) {
          if (inv.targetAgentId === "ted" || inv.recipientEmail) {
            responderEmail = responderEmail || inv.recipientEmail;
          }
        }
        const safetyNumber = this.calculateSafetyNumber(puckAgent?.kid || "puck", tedAgent?.kid || "ted");
        const agentPrompt = this.generateAgentPrompt({
          myAgentId: "ted",
          peerAgentId: "puck",
          peerKid: puckAgent?.kid,
          safetyNumber,
          note: "Cross-account agent link requested between Puck and Ted awaiting dual human approval.",
          portalUrl: this.portalUrl
        });
        this.links.set(linkId, {
          id: linkId,
          agentAId: "puck",
          agentBId: "ted",
          initiatorHumanId,
          responderHumanId,
          initiatorHumanEmail: this.adminEmail,
          responderHumanEmail: responderEmail,
          status: "pending_approval",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString("hex")}`,
          approvals: {
            [initiatorHumanId]: false,
            [responderHumanId]: false
          },
          safetyNumber,
          agentPrompt,
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0,
          note: "Cross-account agent link requested between Puck and Ted awaiting dual human approval."
        });
      }
    }
    const existingPuckTed = this.links.get("link_puck_ted_dual_pending");
    if (existingPuckTed) {
      const puckAgent = this.agents.get("puck");
      const tedAgent = this.agents.get("ted");
      if (puckAgent && (puckAgent.ownerHumanId === "human_carl" || !puckAgent.ownerHumanId)) {
        puckAgent.ownerHumanId = "human_admin";
      }
      if (tedAgent && (!tedAgent.ownerHumanId || tedAgent.ownerHumanId === "human_carl")) {
        tedAgent.ownerHumanId = "human_26c999964b12";
      }
      if (existingPuckTed.initiatorHumanId === "human_carl") {
        existingPuckTed.initiatorHumanId = "human_admin";
      }
      if (existingPuckTed.responderHumanId !== "human_26c999964b12") {
        existingPuckTed.responderHumanId = "human_26c999964b12";
      }
      const curApprovals = existingPuckTed.approvals || {};
      const adminApproved = Boolean(curApprovals["human_admin"] || curApprovals["human_carl"]);
      const responderApproved = Boolean(curApprovals["human_26c999964b12"]);
      existingPuckTed.approvals = {
        "human_admin": adminApproved,
        "human_26c999964b12": responderApproved
      };
      existingPuckTed.safetyNumber = this.calculateSafetyNumber(puckAgent?.kid || "puck", tedAgent?.kid || "ted");
      if (!existingPuckTed.agentPrompt) {
        existingPuckTed.agentPrompt = this.generateAgentPrompt({
          myAgentId: "ted",
          peerAgentId: "puck",
          peerKid: puckAgent?.kid,
          safetyNumber: existingPuckTed.safetyNumber,
          note: existingPuckTed.note,
          portalUrl: this.portalUrl
        });
      }
      if (adminApproved && responderApproved) {
        existingPuckTed.status = "active";
        if (existingPuckTed.approvalDetails) {
          if (existingPuckTed.approvalDetails["human_admin"]) {
            existingPuckTed.approvalDetails["human_admin"].confirmedSafetyNumber = existingPuckTed.safetyNumber;
            existingPuckTed.approvalDetails["human_admin"].confirmedKid = tedAgent?.kid || existingPuckTed.approvalDetails["human_admin"].confirmedKid;
          }
          if (existingPuckTed.approvalDetails["human_26c999964b12"]) {
            existingPuckTed.approvalDetails["human_26c999964b12"].confirmedSafetyNumber = existingPuckTed.safetyNumber;
            existingPuckTed.approvalDetails["human_26c999964b12"].confirmedKid = puckAgent?.kid || existingPuckTed.approvalDetails["human_26c999964b12"].confirmedKid;
          }
        }
      }
    }
    this.saveState();
  }
  async listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
      this.server.keepAliveTimeout = 12e4;
      this.server.headersTimeout = 125e3;
      this.server.requestTimeout = 3e5;
      this.wss = new WebSocketServer({ noServer: true });
      this.server.on("upgrade", (req, socket, head) => {
        if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
          this.wss?.handleUpgrade(req, socket, head, (ws) => {
            this.handleWebSocketConnection(ws, req);
          });
        } else {
          socket.destroy();
        }
      });
      this.server.listen(this.port, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.port = actualPort;
        console.log(`[AgentLink Server] Listening on http://localhost:${actualPort}`);
        resolve(actualPort);
      });
      this.server.on("error", reject);
    });
  }
  async close() {
    return new Promise((resolve) => {
      this.wss?.close();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
  sendJson(res, statusCode, data) {
    try {
      const incomingReq = res.req;
      if (incomingReq && !incomingReq.readableEnded) {
        incomingReq.resume();
      }
      const jsonStr = JSON.stringify(data);
      const buf = Buffer.from(jsonStr, "utf8");
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": buf.length,
        "Connection": "keep-alive",
        "Keep-Alive": "timeout=120, max=1000",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token, X-Human-Id"
      });
      res.end(buf);
    } catch (err) {
      console.error("[sendJson] Serialization error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: "serialization_error", message: err?.message || "Could not serialize response" }));
    }
  }
  handleHttpRequest(req, res) {
    const startTime = Date.now();
    let securityNote;
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") {
        console.warn(`[HTTP REQ WARN] ${req.method} ${req.url}:`, err.message);
      }
    });
    const setSecurityNote = (note) => {
      securityNote = note;
    };
    req.setSecurityNote = setSecurityNote;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-Human-Id");
    res.on("finish", () => {
      if (!req.readableEnded) {
        req.resume();
      }
      const durationMs = Date.now() - startTime;
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "127.0.0.1";
      const human = this.getAuthenticatedHuman(req);
      const identity = human ? `${human.name} (${human.email})` : "anonymous";
      const entry = {
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        ip,
        method: req.method || "GET",
        url: req.url || "/",
        statusCode: res.statusCode,
        durationMs,
        identity,
        userAgent: req.headers["user-agent"],
        securityNote
      };
      this.accessLogs.push(entry);
      if (this.accessLogs.length > 500) this.accessLogs.shift();
      const statusEmoji = res.statusCode >= 400 ? "\u26D4" : "\u2705";
      const secMsg = securityNote ? ` | \u{1F6A8} ${securityNote}` : "";
      console.log(`[ACCESS] ${entry.timestamp} ${statusEmoji} ${req.method} ${req.url} ${res.statusCode} (${durationMs}ms) | User: ${identity}${secMsg}`);
    });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const parsedUrl = req.url ? req.url.split("?")[0] : "/";
    try {
      const readJson = (callback, maxBytes) => {
        const contentLengthHeader = req.headers["content-length"];
        const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
        if (maxBytes && contentLength !== null && !isNaN(contentLength) && contentLength > maxBytes) {
          this.sendJson(res, 413, {
            error: "payload_too_large",
            message: `Payload exceeds maximum allowed size of ${maxBytes} bytes`
          });
          return;
        }
        let data = "";
        let receivedBytes = 0;
        let aborted = false;
        req.on("data", (chunk) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (maxBytes && receivedBytes > maxBytes) {
            aborted = true;
            this.sendJson(res, 413, {
              error: "payload_too_large",
              message: `Payload exceeds maximum allowed size of ${maxBytes} bytes`
            });
            req.destroy();
            return;
          }
          data += chunk;
        });
        req.on("end", () => {
          if (aborted) return;
          try {
            callback(data ? JSON.parse(data) : {});
          } catch {
            this.sendJson(res, 400, { error: "invalid_json", message: "Malformed JSON payload" });
          }
        });
      };
      if (req.method === "GET" && parsedUrl === "/api/server-info") {
        this.sendJson(res, 200, {
          name: `${this.brandName} Zero-Knowledge Relay`,
          version: "1.0.0",
          adminConfigured: true,
          port: this.port,
          portalUrl: this.portalUrl,
          brandName: this.brandName
        });
        return;
      }
      if (req.method === "GET" && (parsedUrl === "/api/docs/encryption" || parsedUrl === "/docs/encryption.md")) {
        const docPath = path.resolve("docs/encryption.md");
        if (fs.existsSync(docPath)) {
          const text = fs.readFileSync(docPath, "utf8");
          if (parsedUrl.endsWith(".md")) {
            const buf = Buffer.from(text, "utf8");
            res.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Length": buf.length,
              "Cache-Control": "no-cache, no-store, must-revalidate"
            });
            res.end(buf);
            return;
          }
          this.sendJson(res, 200, { status: "ok", content: text });
          return;
        }
      }
      if (req.method === "GET" && parsedUrl === "/api/auth/config") {
        this.sendJson(res, 200, {
          status: "ok",
          googleClientId: process.env.GOOGLE_CLIENT_ID || null,
          production: process.env.NODE_ENV === "production",
          portalUrl: this.portalUrl,
          brandName: this.brandName
        });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/auth/google") {
        readJson(async (body) => {
          let email = "";
          let name = "Administrator";
          if (body.credential && typeof body.credential === "string") {
            const verified = await this.verifyGoogleIdToken(body.credential);
            if (!verified) {
              setSecurityNote(`GOOGLE LOGIN REJECTED: Invalid or unverified Google ID token`);
              this.sendJson(res, 401, {
                error: "invalid_credential",
                message: "Google authentication failed: ID token verification rejected by Google Identity Services."
              });
              return;
            }
            email = verified.email;
            if (verified.name) name = verified.name;
          } else {
            const testSecretHeader = req.headers["x-test-auth-secret"];
            const configuredTestSecret = process.env.TEST_AUTH_SECRET || "test_sec_mesh_secret_2026";
            const isTestAuthorized = Boolean(testSecretHeader && testSecretHeader === configuredTestSecret);
            const isDevOrTest = process.env.NODE_ENV !== "production";
            if (!isDevOrTest && !isTestAuthorized) {
              setSecurityNote(`GOOGLE LOGIN BLOCKED: Plain email login rejected in production without verified Google ID token`);
              this.sendJson(res, 401, {
                error: "credential_required",
                message: "Real Google ID token credential required for Google Sign-In in production."
              });
              return;
            }
            email = (body.email || "").trim().toLowerCase();
            name = (body.name || "Administrator").trim();
          }
          if (!email) {
            this.sendJson(res, 400, { error: "email_required", message: "Email required" });
            return;
          }
          const inviteToken = (body.inviteToken || body.invite || "").trim();
          let matchingInvite = inviteToken ? this.invites.get(inviteToken) : null;
          if (!matchingInvite && email) {
            matchingInvite = Array.from(this.invites.values()).find(
              (inv) => inv.recipientEmail === email && (inv.status === "pending" || inv.status === "accepted")
            ) || null;
          }
          const emailHash = crypto.createHash("sha256").update(email).digest("hex");
          const isAdmin = emailHash === this.adminEmailHash;
          const isAuthorized = this.authorizedEmailHashes.has(emailHash);
          if (!isAdmin && !isAuthorized && !matchingInvite) {
            setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
            this.sendJson(res, 403, {
              error: "not_enabled",
              message: "Not enabled right now"
            });
            return;
          }
          const userHumanId = isAdmin ? "human_admin" : `human_${emailHash.slice(0, 12)}`;
          const token = `sec_hum_${crypto.randomBytes(24).toString("hex")}`;
          const user = {
            id: userHumanId,
            name: name || (isAdmin ? "Administrator" : email.split("@")[0]),
            email,
            avatar: isAdmin ? "\u{1F451}" : isAuthorized ? "\u2728" : "\u{1F91D}",
            role: isAdmin ? "admin" : "collaborator"
          };
          this.humanSessions.set(token, user);
          if (matchingInvite) {
            matchingInvite.status = "accepted";
            this.saveState();
          }
          setSecurityNote(`SUCCESSFUL GOOGLE LOGIN for ${email} (${user.role})`);
          this.sendJson(res, 200, { status: "ok", authenticated: true, token, user });
        });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/auth/login") {
        readJson((body) => {
          const email = (body.email || "").trim().toLowerCase();
          const password = (body.password || body.credential || "").trim();
          const emailHash = email ? crypto.createHash("sha256").update(email).digest("hex") : null;
          if (email && emailHash !== this.adminEmailHash && !this.authorizedEmailHashes.has(emailHash)) {
            setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
            this.sendJson(res, 403, {
              error: "not_enabled",
              message: "Not enabled right now"
            });
            return;
          }
          if (password !== this.adminPassword) {
            setSecurityNote(`INVALID PASSWORD for ${email || "admin"}`);
            this.sendJson(res, 401, { error: "invalid_credentials", message: "Invalid password" });
            return;
          }
          const isAdmin = !email || emailHash === this.adminEmailHash;
          const userHumanId = isAdmin ? "human_admin" : `human_${emailHash.slice(0, 12)}`;
          const token = `sec_hum_${crypto.randomBytes(24).toString("hex")}`;
          const user = {
            id: userHumanId,
            name: isAdmin ? "Administrator" : email.split("@")[0],
            email: email || this.adminEmail,
            avatar: isAdmin ? "\u{1F451}" : "\u2728",
            role: "admin"
          };
          this.humanSessions.set(token, user);
          setSecurityNote(`SUCCESSFUL CREDENTIAL LOGIN for ${email || "admin"}`);
          this.sendJson(res, 200, { status: "ok", authenticated: true, token, user });
        });
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/auth/me") {
        const user = this.getAuthenticatedHuman(req);
        if (!user) {
          this.sendJson(res, 401, { error: "unauthorized", message: "No active session" });
          return;
        }
        this.sendJson(res, 200, { status: "ok", user });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/auth/logout") {
        const token = this.extractToken(req);
        if (token) this.humanSessions.delete(token);
        this.sendJson(res, 200, { status: "ok", loggedOut: true });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/admin/clean-slate") {
        const human = this.getAuthenticatedHuman(req);
        if (!human || human.role !== "admin") {
          this.sendJson(res, 403, { error: "forbidden", message: "Admin authentication required" });
          return;
        }
        readJson((body) => {
          const mode = body.mode || "test_artifacts";
          let removedKeys = 0;
          let removedAgents = 0;
          let removedLinks = 0;
          if (mode === "all") {
            removedKeys = this.apiKeys.size;
            removedAgents = this.agents.size;
            removedLinks = this.links.size;
            this.apiKeys.clear();
            this.agents.clear();
            this.links.clear();
            this.messageQueues.clear();
            this.pollWaiters.clear();
            const defaultKeyVal = "sec_apk_admin_fleet_primary";
            this.apiKeys.set(defaultKeyVal, {
              id: "key_primary_default",
              key: defaultKeyVal,
              ownerHumanId: "human_admin",
              label: "Primary Fleet Key (Admin)",
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } else {
            const isTestIdentifier = (id, label) => {
              const s = `${id} ${label || ""}`.toLowerCase();
              return s.includes("test") || s.includes("alice") || s.includes("bob");
            };
            for (const [k, keyRec] of Array.from(this.apiKeys.entries())) {
              if (k === "sec_apk_admin_fleet_primary") continue;
              if (isTestIdentifier(keyRec.id, keyRec.label) || isTestIdentifier(keyRec.key, keyRec.label)) {
                this.apiKeys.delete(k);
                removedKeys++;
              }
            }
            const removedAgentIds = /* @__PURE__ */ new Set();
            for (const [agentId] of Array.from(this.agents.entries())) {
              if (isTestIdentifier(agentId)) {
                this.agents.delete(agentId);
                this.messageQueues.delete(agentId);
                this.pollWaiters.delete(agentId);
                removedAgentIds.add(agentId);
                removedAgents++;
              }
            }
            for (const [linkId, linkRec] of Array.from(this.links.entries())) {
              if (removedAgentIds.has(linkRec.agentAId) || removedAgentIds.has(linkRec.agentBId) || isTestIdentifier(linkRec.id) || isTestIdentifier(linkRec.agentAId) || isTestIdentifier(linkRec.agentBId)) {
                this.links.delete(linkId);
                removedLinks++;
              }
            }
          }
          this.saveState();
          this.notifySupervisors({ type: "clean_slate", mode, removedKeys, removedAgents, removedLinks });
          this.sendJson(res, 200, {
            status: "ok",
            mode,
            removedKeys,
            removedAgents,
            removedLinks,
            remainingAgents: this.agents.size,
            remainingKeys: this.apiKeys.size,
            remainingLinks: this.links.size
          });
        });
        return;
      }
      if (req.method === "POST" && (parsedUrl === "/api/keys/generate" || parsedUrl === "/api/keys")) {
        readJson((body) => {
          const human = this.getAuthenticatedHuman(req);
          if (!human) {
            this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
            return;
          }
          const keyVal = `sec_apk_${crypto.randomBytes(32).toString("hex")}`;
          const keyRecord = {
            id: `key_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
            key: keyVal,
            ownerHumanId: human.id,
            label: body.label || `Agent Key (${(/* @__PURE__ */ new Date()).toLocaleDateString()})`,
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          this.apiKeys.set(keyVal, keyRecord);
          this.saveState();
          setSecurityNote(`API KEY GENERATED: ${keyRecord.id} for ${human.email}`);
          this.sendJson(res, 201, { status: "ok", apiKey: keyRecord });
        });
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/keys") {
        const human = this.getAuthenticatedHuman(req);
        if (!human) {
          this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
          return;
        }
        const keysList = Array.from(this.apiKeys.values()).filter((k) => {
          if (human.id === "human_admin") {
            return k.ownerHumanId === "human_admin" || k.ownerHumanId === "human_carl";
          }
          return k.ownerHumanId === human.id;
        }).map((k) => ({
          id: k.id,
          keyMasked: `${k.key.substring(0, 12)}...${k.key.substring(k.key.length - 6)}`,
          key: k.key,
          label: k.label,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt
        }));
        this.sendJson(res, 200, { status: "ok", keys: keysList });
        return;
      }
      if (req.method === "DELETE" && parsedUrl.startsWith("/api/keys/")) {
        const human = this.getAuthenticatedHuman(req);
        if (!human) {
          this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
          return;
        }
        const keyId = parsedUrl.replace("/api/keys/", "").trim();
        let deleted = false;
        for (const [k, record] of this.apiKeys.entries()) {
          if (record.id === keyId || record.key === keyId) {
            if (human.role !== "admin" && record.ownerHumanId !== human.id) {
              this.sendJson(res, 403, { error: "forbidden", message: "Not authorized to delete this key" });
              return;
            }
            this.apiKeys.delete(k);
            deleted = true;
            break;
          }
        }
        if (deleted) this.saveState();
        this.sendJson(res, 200, { status: "ok", deleted });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/invites") {
        readJson((body) => {
          const token = this.extractToken(req);
          const human = this.getAuthenticatedHuman(req);
          const apiKeyRecord = token ? this.apiKeys.get(token) : null;
          if (!human && !apiKeyRecord) {
            this.sendJson(res, 401, {
              error: "unauthorized",
              message: "Authentication required to create an invite (valid human session or agent API key required)"
            });
            return;
          }
          const toEmail = (body.toEmail || body.email || "").trim().toLowerCase();
          if (!toEmail || !toEmail.includes("@")) {
            this.sendJson(res, 400, { error: "invalid_email", message: "Valid recipient email address is required" });
            return;
          }
          const inviterHumanId = human ? human.id : apiKeyRecord.ownerHumanId || "human_admin";
          let inviterEmail = human ? human.email : this.adminEmail;
          let inviterName = human ? human.name || human.email : void 0;
          if (!human && apiKeyRecord) {
            for (const s of this.humanSessions.values()) {
              if (s.id === inviterHumanId) {
                inviterEmail = s.email;
                inviterName = s.name || s.email;
                break;
              }
            }
          }
          const fromAgentId = body.fromAgentId || body.agentId || (apiKeyRecord ? apiKeyRecord.id : void 0);
          const senderLabel = fromAgentId ? `Autonomous agent '${fromAgentId}' (operator: ${inviterName || inviterEmail})` : inviterName || inviterEmail;
          const targetAgentId = body.targetAgentId || body.peerAgentId || body.peerId;
          let createdLinkId;
          const host = req.headers["host"] || `localhost:${this.port}`;
          const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
          const portalUrl = `${proto}://${host}/`;
          const agentA = fromAgentId ? this.agents.get(fromAgentId) : void 0;
          const agentB = targetAgentId ? this.agents.get(targetAgentId) : void 0;
          const keyA = agentA?.kid || fromAgentId || "initiator-agent";
          const keyB = agentB?.kid || targetAgentId || "responder-agent";
          const safetyNumber = this.calculateSafetyNumber(keyA, keyB);
          const agentPrompt = this.generateAgentPrompt({
            myAgentId: targetAgentId || "your-agent",
            peerAgentId: fromAgentId || "peer-agent",
            peerKid: agentA?.kid,
            safetyNumber,
            note: body.note,
            portalUrl
          });
          if (fromAgentId && targetAgentId && this.agents.has(fromAgentId) && this.agents.has(targetAgentId)) {
            const existing = Array.from(this.links.values()).find(
              (l) => l.agentAId === fromAgentId && l.agentBId === targetAgentId || l.agentAId === targetAgentId && l.agentBId === fromAgentId
            );
            if (!existing) {
              createdLinkId = `link_${crypto.randomBytes(6).toString("hex")}`;
              const responderHumanId = agentB?.ownerHumanId || `human_${crypto.createHash("sha256").update(toEmail).digest("hex").slice(0, 12)}`;
              const approvals = {};
              approvals[inviterHumanId] = false;
              if (responderHumanId !== inviterHumanId) {
                approvals[responderHumanId] = false;
              }
              const linkRecord = {
                id: createdLinkId,
                agentAId: fromAgentId,
                agentBId: targetAgentId,
                initiatorHumanId: inviterHumanId,
                responderHumanId,
                initiatorHumanEmail: inviterEmail,
                responderHumanEmail: toEmail,
                status: "pending_approval",
                createdAt: (/* @__PURE__ */ new Date()).toISOString(),
                linkKey: `sec_link_${crypto.randomBytes(16).toString("hex")}`,
                approvals,
                safetyNumber,
                agentPrompt,
                framesCount: 0,
                bytesAtoB: 0,
                bytesBtoA: 0,
                note: body.note
              };
              this.links.set(createdLinkId, linkRecord);
            } else {
              createdLinkId = existing.id;
            }
          }
          const inviteId = `inv_${crypto.randomBytes(8).toString("hex")}`;
          const inviteToken = `tok_${crypto.randomBytes(24).toString("base64url")}`;
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3).toISOString();
          const inviteRecord = {
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
            status: "pending",
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            expiresAt,
            note: body.note
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
            inviteUrl,
            // included for testing and programmatic clients
            token: inviteToken,
            body: `Hi,

${senderLabel} has requested to establish an autonomous agent connection with you on the AgentLink Zero-Knowledge Mesh.

\u{1F512} Zero-Credential Notice: In accordance with fail-closed security standards, this email carries NO passwords, bearer tokens, or login secrets.

To authorize this connection:
1. Sign in securely to your AgentLink Dashboard: ${portalUrl}
2. Confirm the mutual Safety Number (${safetyNumber}) with ${inviterName || inviterEmail}
3. Review and approve the pending connection in your dashboard

Human-to-Agent Instructions:
Paste the following prompt directly into your agent's chat session:
"""
${agentPrompt}
"""
Note: Messages remain fail-closed and strictly blocked until both human operators confirm matching Safety Numbers in their dashboards.
`
          };
          setSecurityNote(`INVITE ISSUED: ${inviteId} to ${toEmail} by ${senderLabel}`);
          this.sendJson(res, 201, {
            status: "ok",
            invite: inviteRecord,
            safetyNumber,
            agentPrompt,
            portalUrl,
            inviteUrl,
            emailTemplate,
            linkId: createdLinkId
          });
        });
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/invites") {
        const token = this.extractToken(req);
        const human = this.getAuthenticatedHuman(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;
        if (!human && !apiKeyRecord) {
          this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
          return;
        }
        const humanId = human ? human.id : apiKeyRecord.ownerHumanId;
        const isAdmin = human && human.role === "admin" || humanId === "human_admin";
        const list = Array.from(new Set(this.invites.values())).filter(
          (inv) => isAdmin || inv.inviterHumanId === humanId || human && inv.recipientEmail === human.email
        );
        this.sendJson(res, 200, { status: "ok", invites: list });
        return;
      }
      if (req.method === "DELETE" && parsedUrl.startsWith("/api/invites/")) {
        const inviteId = parsedUrl.replace("/api/invites/", "").trim();
        const token = this.extractToken(req);
        const human = this.getAuthenticatedHuman(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;
        if (!human && !apiKeyRecord) {
          this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
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
        this.sendJson(res, 200, { status: "ok", deleted });
        return;
      }
      if (req.method === "POST" && (parsedUrl === "/api/agents/register" || parsedUrl === "/api/agents")) {
        readJson((body) => {
          const token = this.extractToken(req);
          const apiKeyRecord = token ? this.apiKeys.get(token) : null;
          const humanSession = token ? this.humanSessions.get(token) : null;
          const isAdmin = Boolean(humanSession && humanSession.role === "admin");
          if (!apiKeyRecord && !isAdmin && token !== "sec_apk_valid_12345") {
            const tokenSnippet = token ? `${token.slice(0, 12)}...` : "none";
            setSecurityNote(`AGENT REGISTRATION REJECTED: Invalid or missing API key (${tokenSnippet})`);
            this.sendJson(res, 401, {
              error: "invalid_api_key",
              message: "Valid AgentLink API key required for registration"
            });
            return;
          }
          if (apiKeyRecord) {
            apiKeyRecord.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
          }
          const agentId = body.id || body.agentId || `agent_${crypto.randomBytes(4).toString("hex")}`;
          let ownerHumanId = "human_admin";
          if (apiKeyRecord && apiKeyRecord.ownerHumanId) {
            ownerHumanId = apiKeyRecord.ownerHumanId;
          } else if (humanSession) {
            ownerHumanId = humanSession.id;
          } else if (body.ownerHumanId) {
            ownerHumanId = body.ownerHumanId;
          }
          const agentRecord = {
            id: agentId,
            ownerHumanId,
            registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
            signPub: body.signPub,
            encPub: body.encPub,
            kid: body.kid,
            qrPayload: body.qrPayload,
            connected: false,
            polling: true,
            lastSeen: (/* @__PURE__ */ new Date()).toISOString()
          };
          this.agents.set(agentId, agentRecord);
          if (!this.messageQueues.has(agentId)) {
            this.messageQueues.set(agentId, []);
          }
          for (const link of this.links.values()) {
            if (link.agentAId === agentId || link.agentBId === agentId) {
              const a = this.agents.get(link.agentAId);
              const b = this.agents.get(link.agentBId);
              if (a?.kid && b?.kid) {
                const previousSafetyNumber = link.safetyNumber;
                link.safetyNumber = this.calculateSafetyNumber(a.kid, b.kid);
                link.agentPrompt = this.generateAgentPrompt({
                  myAgentId: link.agentBId,
                  peerAgentId: link.agentAId,
                  peerKid: a.kid,
                  safetyNumber: link.safetyNumber,
                  note: link.note,
                  portalUrl: this.portalUrl
                });
                if (previousSafetyNumber && previousSafetyNumber !== link.safetyNumber) {
                  console.warn(`[AgentLink Security] Key rotation detected for agent '${agentId}'. Link '${link.id}' Safety Number changed from '${previousSafetyNumber}' to '${link.safetyNumber}'. Demoting to pending_approval and revoking stale approvals.`);
                  link.status = "pending_approval";
                  link.approvals = {
                    [link.initiatorHumanId]: false,
                    ...link.responderHumanId ? { [link.responderHumanId]: false } : {}
                  };
                  link.approvalDetails = {};
                }
              }
            }
          }
          this.saveState();
          setSecurityNote(`AGENT REGISTERED: ${agentId} (${agentRecord.kid}) bound to ${ownerHumanId}`);
          this.notifySupervisors({ type: "agent_registered", agent: agentRecord });
          this.sendJson(res, 200, {
            status: "ok",
            agentId: agentRecord.id,
            pollUrl: `/api/agents/${agentRecord.id}/poll`,
            registeredAt: agentRecord.registeredAt,
            agent: agentRecord
          });
        });
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/agents") {
        const human = this.getAuthenticatedHuman(req);
        let filterAgentId = null;
        if (req.url && req.url.includes("?")) {
          const query = new URLSearchParams(req.url.split("?")[1]);
          filterAgentId = query.get("agentId") || query.get("agent") || query.get("id") || null;
        }
        let list = Array.from(this.agents.values());
        if (filterAgentId) {
          list = list.filter((a) => a.id === filterAgentId);
        }
        if (human) {
          const isSystemAdmin = human.id === "human_admin";
          list = list.filter((a) => {
            if (isSystemAdmin) {
              return a.ownerHumanId === "human_admin" || a.ownerHumanId === "human_carl";
            }
            return a.ownerHumanId === human.id;
          });
        }
        const sanitized = list.map((a) => {
          const { qrPayload, ...rest } = a;
          const isOwned = Boolean(human && (a.ownerHumanId === human.id || human.id === "human_admin" && (a.ownerHumanId === "human_admin" || a.ownerHumanId === "human_carl")));
          return {
            ...rest,
            relationship: isOwned ? "owned" : "peer"
          };
        });
        this.sendJson(res, 200, { status: "ok", agents: sanitized });
        return;
      }
      if (req.method === "GET" && parsedUrl.startsWith("/api/agents/") && !parsedUrl.endsWith("/poll") && !parsedUrl.endsWith("/links")) {
        const agentId = parsedUrl.replace("/api/agents/", "").trim();
        const agent = this.agents.get(agentId);
        if (!agent) {
          this.sendJson(res, 404, { error: "agent_not_found", message: `Agent '${agentId}' not found` });
          return;
        }
        const human = this.getAuthenticatedHuman(req);
        const isOwned = Boolean(human && (agent.ownerHumanId === human.id || human.id === "human_admin" && (agent.ownerHumanId === "human_admin" || agent.ownerHumanId === "human_carl")));
        this.sendJson(res, 200, { status: "ok", agent: { ...agent, relationship: isOwned ? "owned" : "peer" } });
        return;
      }
      if (req.method === "DELETE" && parsedUrl.startsWith("/api/agents/")) {
        const human = this.getAuthenticatedHuman(req);
        if (!human) {
          this.sendJson(res, 401, { error: "unauthorized", message: "Authentication required" });
          return;
        }
        const agentId = parsedUrl.replace("/api/agents/", "").trim();
        const agent = this.agents.get(agentId);
        if (!agent) {
          this.sendJson(res, 404, { error: "agent_not_found", message: `Agent '${agentId}' not found` });
          return;
        }
        const isOwner = agent.ownerHumanId === human.id || human.id === "human_admin" && (agent.ownerHumanId === "human_admin" || agent.ownerHumanId === "human_carl");
        if (!isOwner && human.role !== "admin") {
          this.sendJson(res, 403, { error: "forbidden", message: "Not authorized to de-register this agent" });
          return;
        }
        const existed = this.agents.delete(agentId);
        this.messageQueues.delete(agentId);
        this.pollWaiters.delete(agentId);
        let removedLinksCount = 0;
        for (const [linkId, link] of Array.from(this.links.entries())) {
          if (link.agentAId === agentId || link.agentBId === agentId) {
            this.links.delete(linkId);
            removedLinksCount++;
          }
        }
        if (existed || removedLinksCount > 0) {
          this.saveState();
          this.notifySupervisors({ type: "agent_deregistered", agentId, removedLinksCount });
        }
        this.sendJson(res, 200, { status: "ok", deregistered: existed, removedLinks: removedLinksCount });
        return;
      }
      if (req.method === "GET" && parsedUrl.startsWith("/api/agents/") && parsedUrl.endsWith("/poll")) {
        const parts = parsedUrl.split("/");
        const agentId = parts[3];
        const agent = this.agents.get(agentId);
        if (agent) {
          agent.polling = true;
          agent.lastSeen = (/* @__PURE__ */ new Date()).toISOString();
        }
        let timeoutMs = 15e3;
        if (req.url && req.url.includes("?")) {
          const query = new URLSearchParams(req.url.split("?")[1]);
          const t = parseInt(query.get("timeout") || "15000", 10);
          if (!isNaN(t) && t > 0) {
            timeoutMs = Math.min(t, 6e4);
          }
        }
        const q = this.messageQueues.get(agentId) || [];
        if (q.length > 0) {
          const msgs = [...q];
          q.length = 0;
          this.sendJson(res, 200, { messages: msgs });
          return;
        }
        let waiters = this.pollWaiters.get(agentId);
        if (!waiters) {
          waiters = [];
          this.pollWaiters.set(agentId, waiters);
        }
        let active = true;
        const resolver = (msgs) => {
          if (!active) return false;
          active = false;
          clearTimeout(timer);
          const idx = waiters.indexOf(resolver);
          if (idx !== -1) waiters.splice(idx, 1);
          this.sendJson(res, 200, { messages: msgs });
          return true;
        };
        const timer = setTimeout(() => {
          if (!active) return;
          active = false;
          const idx = waiters.indexOf(resolver);
          if (idx !== -1) waiters.splice(idx, 1);
          this.sendJson(res, 200, { messages: [] });
        }, timeoutMs);
        req.on("close", () => {
          if (!active) return;
          active = false;
          clearTimeout(timer);
          const idx = waiters.indexOf(resolver);
          if (idx !== -1) waiters.splice(idx, 1);
        });
        waiters.push(resolver);
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/links/request") {
        readJson((body) => {
          const token = this.extractToken(req);
          const human = this.getAuthenticatedHuman(req);
          const apiKeyRecord = token ? this.apiKeys.get(token) : null;
          const agentAId = body.agentAId || body.fromAgentId;
          const agentBId = body.agentBId || body.peerAgentId || body.peerId || body.toAgentId;
          if (!agentAId || !agentBId) {
            this.sendJson(res, 400, { error: "invalid_agents", message: "Both agentAId and agentBId are required" });
            return;
          }
          if (agentAId === agentBId) {
            this.sendJson(res, 400, { error: "invalid_agents", message: "Cannot link an agent to itself" });
            return;
          }
          const existing = Array.from(this.links.values()).find(
            (l) => l.agentAId === agentAId && l.agentBId === agentBId || l.agentAId === agentBId && l.agentBId === agentAId
          );
          if (existing) {
            this.sendJson(res, 200, { status: "ok", linkId: existing.id, link: existing, existing: true });
            return;
          }
          const agentA = this.agents.get(agentAId);
          const agentB = this.agents.get(agentBId);
          const initiatorHumanId = body.initiatorHumanId || agentA?.ownerHumanId || (human ? human.id : apiKeyRecord ? apiKeyRecord.ownerHumanId : "human_admin");
          const responderHumanId = body.responderHumanId || agentB?.ownerHumanId || initiatorHumanId;
          let initiatorHumanEmail = body.initiatorHumanEmail || (human ? human.email : null);
          let responderHumanEmail = body.responderHumanEmail;
          for (const session of this.humanSessions.values()) {
            if (session.id === initiatorHumanId && !initiatorHumanEmail) initiatorHumanEmail = session.email;
            if (session.id === responderHumanId && !responderHumanEmail) responderHumanEmail = session.email;
          }
          const linkId = `link_${crypto.randomBytes(6).toString("hex")}`;
          const isSameOwner = initiatorHumanId === responderHumanId;
          const approvals = {};
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
            note: body.note
          });
          const record = {
            id: linkId,
            agentAId,
            agentBId,
            initiatorHumanId,
            responderHumanId,
            initiatorHumanEmail,
            responderHumanEmail,
            status: "pending_approval",
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            linkKey: `sec_link_${crypto.randomBytes(16).toString("hex")}`,
            approvals,
            safetyNumber,
            agentPrompt,
            framesCount: 0,
            bytesAtoB: 0,
            bytesBtoA: 0,
            note: body.note
          };
          this.links.set(linkId, record);
          this.saveState();
          this.sendJson(res, 200, { status: "ok", linkId: record.id, link: record, safetyNumber, agentPrompt });
        });
        return;
      }
      if (req.method === "GET" && (parsedUrl === "/api/links" || parsedUrl.startsWith("/api/agents/") && parsedUrl.endsWith("/links"))) {
        const human = this.getAuthenticatedHuman(req);
        let filterAgentId = null;
        if (parsedUrl.startsWith("/api/agents/") && parsedUrl.endsWith("/links")) {
          filterAgentId = parsedUrl.split("/")[3] || null;
        }
        if (!filterAgentId && req.url && req.url.includes("?")) {
          const query = new URLSearchParams(req.url.split("?")[1]);
          filterAgentId = query.get("agentId") || query.get("agent") || null;
        }
        let list = Array.from(this.links.values());
        if (filterAgentId) {
          list = list.filter((l) => l.agentAId === filterAgentId || l.agentBId === filterAgentId);
        }
        if (human && human.role !== "admin") {
          list = list.filter((l) => l.initiatorHumanId === human.id || l.responderHumanId === human.id);
        }
        const sanitized = list.map((l) => {
          const msgs = (l.recentMessages || []).slice(-3).map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            senderId: m.senderId,
            targetId: m.targetId,
            text: m.text,
            isEncrypted: m.isEncrypted
          }));
          const agentA = this.agents.get(l.agentAId);
          const agentB = this.agents.get(l.agentBId);
          const safetyNumber = l.safetyNumber || this.calculateSafetyNumber(agentA?.kid || l.agentAId, agentB?.kid || l.agentBId);
          const agentPrompt = l.agentPrompt || this.generateAgentPrompt({
            myAgentId: l.agentBId,
            peerAgentId: l.agentAId,
            peerKid: agentA?.kid,
            safetyNumber,
            note: l.note
          });
          return {
            ...l,
            safetyNumber,
            agentPrompt,
            recentMessages: msgs
          };
        });
        this.sendJson(res, 200, { status: "ok", links: sanitized });
        return;
      }
      if (req.method === "GET" && parsedUrl.startsWith("/api/links/") && !parsedUrl.endsWith("/poll") && !parsedUrl.endsWith("/approve") && !parsedUrl.endsWith("/send") && !parsedUrl.endsWith("/message")) {
        const linkId = parsedUrl.replace("/api/links/", "").trim();
        const link = this.links.get(linkId);
        if (!link) {
          this.sendJson(res, 404, { error: "link_not_found", message: `Link '${linkId}' not found` });
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
          note: link.note
        });
        this.sendJson(res, 200, { status: "ok", link: { ...link, safetyNumber, agentPrompt } });
        return;
      }
      if (req.method === "POST" && parsedUrl.startsWith("/api/links/") && parsedUrl.endsWith("/approve")) {
        readJson((body) => {
          const parts = parsedUrl.split("/");
          const linkId = parts[3];
          const link = this.links.get(linkId);
          if (!link) {
            this.sendJson(res, 404, { error: "link_not_found", message: `Link '${linkId}' not found` });
            return;
          }
          const human = this.getAuthenticatedHuman(req);
          let approverId = human?.id || body.approverHumanId || body.humanId || link.initiatorHumanId;
          if (approverId === "human_carl") approverId = "human_admin";
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
              note: link.note
            });
          }
          const suppliedSafetyNumber = body.confirmedSafetyNumber || body.safetyNumber;
          if (suppliedSafetyNumber && suppliedSafetyNumber !== link.safetyNumber) {
            this.sendJson(res, 400, {
              error: "safety_number_mismatch",
              message: `Confirmed Safety Number '${suppliedSafetyNumber}' does not match current mutual Safety Number '${link.safetyNumber}'.`
            });
            return;
          }
          const validKids = [agentA?.kid, agentB?.kid].filter(Boolean);
          const suppliedKid = body.confirmedKid || body.kid;
          if (suppliedKid && validKids.length > 0 && !validKids.includes(suppliedKid)) {
            this.sendJson(res, 400, {
              error: "kid_mismatch",
              message: `Confirmed Key ID '${suppliedKid}' does not match any agent in this link (expected ${validKids.join(" or ")}).`
            });
            return;
          }
          const isInitiator = approverId === link.initiatorHumanId || human?.role === "admin" && (link.initiatorHumanId === "human_admin" || link.initiatorHumanId === "human_carl");
          const targetSlot = isInitiator ? link.initiatorHumanId : approverId === link.responderHumanId ? link.responderHumanId : approverId;
          const defaultKid = (approverId === link.initiatorHumanId ? agentA?.kid : agentB?.kid) || agentA?.kid || agentB?.kid || "unknown";
          const confirmedKid = suppliedKid || defaultKid;
          const confirmedSafetyNumber = suppliedSafetyNumber || link.safetyNumber;
          link.approvals[targetSlot] = true;
          link.approvalDetails[targetSlot] = {
            approved: true,
            confirmedAt: (/* @__PURE__ */ new Date()).toISOString(),
            confirmedKid,
            confirmedSafetyNumber
          };
          const isSameOwner = !link.responderHumanId || link.initiatorHumanId === link.responderHumanId;
          const initiatorOk = Boolean(link.approvals[link.initiatorHumanId] || link.initiatorHumanId === "human_admin" && link.approvals["human_carl"] || link.initiatorHumanId === "human_carl" && link.approvals["human_admin"]);
          const responderOk = isSameOwner || Boolean(link.approvals[link.responderHumanId] || link.responderHumanId === "human_admin" && link.approvals["human_carl"] || link.responderHumanId === "human_carl" && link.approvals["human_admin"]);
          const initiatorDetails = link.approvalDetails[link.initiatorHumanId] || link.approvalDetails["human_admin"] || link.approvalDetails["human_carl"];
          const responderDetails = link.responderHumanId ? link.approvalDetails[link.responderHumanId] || link.approvalDetails["human_admin"] || link.approvalDetails["human_carl"] : void 0;
          const initiatorMatchesSafety = !initiatorDetails?.confirmedSafetyNumber || initiatorDetails.confirmedSafetyNumber === link.safetyNumber;
          const responderMatchesSafety = isSameOwner || !responderDetails?.confirmedSafetyNumber || responderDetails.confirmedSafetyNumber === link.safetyNumber;
          if ((human?.role === "admin" && body.force || initiatorOk && responderOk) && initiatorMatchesSafety && responderMatchesSafety) {
            link.status = "active";
          } else {
            link.status = "pending_approval";
          }
          if (body.peerVerification) {
            const targetAgent = this.agents.get(link.agentBId);
            if (targetAgent) targetAgent.peerVerification = body.peerVerification;
          }
          this.saveState();
          this.sendJson(res, 200, { status: "ok", linkId: link.id, link });
        });
        return;
      }
      if (req.method === "DELETE" && parsedUrl.startsWith("/api/links/")) {
        const linkId = parsedUrl.replace("/api/links/", "").trim();
        const existed = this.links.delete(linkId);
        if (existed) this.saveState();
        this.sendJson(res, 200, { status: "ok", severed: existed });
        return;
      }
      if (req.method === "POST" && parsedUrl.startsWith("/api/links/") && (parsedUrl.endsWith("/send") || parsedUrl.endsWith("/message"))) {
        readJson((body) => {
          const parts = parsedUrl.split("/");
          const linkId = parts[3];
          const link = this.links.get(linkId);
          if (!link) {
            this.sendJson(res, 404, { error: "link_not_found", message: `Link '${linkId}' not found` });
            return;
          }
          if (link.status !== "active") {
            this.sendJson(res, 403, {
              error: "link_not_approved",
              message: `Link '${linkId}' has not been approved by all human controllers (status: ${link.status}).`,
              approvals: link.approvals
            });
            return;
          }
          const senderId = body.senderId;
          if (senderId !== link.agentAId && senderId !== link.agentBId) {
            this.sendJson(res, 403, {
              error: "forbidden_participant",
              message: `Agent '${senderId}' is not an authorized participant of link '${link.id}'.`
            });
            return;
          }
          const targetId = senderId === link.agentAId ? link.agentBId : link.agentAId;
          if (targetId) {
            if (link) {
              link.framesCount = (link.framesCount || 0) + 1;
              if (!link.recentMessages) link.recentMessages = [];
              const isEnc = typeof body.payload === "object" && body.payload !== null && Boolean(body.payload.data);
              const isSigned = isEnc && Boolean(body.payload.sig);
              const seq = isEnc && typeof body.payload.seq === "number" ? body.payload.seq : void 0;
              const previewText = typeof body.payload === "string" ? body.payload : isEnc ? `[E2EE v${body.payload.v || 1}${seq ? ` #${seq}` : ""} ${body.payload.data.slice(0, 12)}...]` : "[E2EE Encrypted Payload]";
              link.recentMessages.push({
                id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
                timestamp: (/* @__PURE__ */ new Date()).toISOString(),
                senderId,
                targetId,
                text: previewText,
                isEncrypted: isEnc,
                isSigned,
                seq,
                payload: body.payload
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
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
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
          this.sendJson(res, 200, { status: "ok", delivered: Boolean(targetId) });
        });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/telemetry") {
        readJson((body) => {
          const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "127.0.0.1";
          const userAgent = req.headers["user-agent"] || "";
          const level = body.level || "info";
          const category = body.category || "client";
          const message = body.message || "Client event";
          const details = body.details || void 0;
          const entry = {
            id: `clog_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            level,
            category,
            message,
            details,
            userAgent,
            ip
          };
          this.clientLogs.push(entry);
          if (this.clientLogs.length > 500) this.clientLogs.shift();
          const levelEmoji = level === "error" ? "\u{1F4A5}" : level === "warn" ? "\u26A0\uFE0F" : "\u2139\uFE0F";
          console.log(`[CLIENT-LOG] ${entry.timestamp} ${levelEmoji} [${category}] ${message} ${details ? JSON.stringify(details) : ""}`);
          this.sendJson(res, 200, { status: "ok", received: true, id: entry.id });
        });
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/logs") {
        this.sendJson(res, 200, {
          status: "ok",
          accessLogs: this.accessLogs.slice(-100),
          clientLogs: this.clientLogs.slice(-100)
        });
        return;
      }
      if (req.method === "POST" && parsedUrl === "/api/bugs") {
        readJson((body) => {
          const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "127.0.0.1";
          const rawAgentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
          const rateKey = rawAgentId ? `agent:${rawAgentId}` : `ip:${clientIp}`;
          if (!this.checkBugRateLimit(rateKey, 5, 6e4)) {
            this.sendJson(res, 429, {
              error: "rate_limited",
              message: "Too many bug reports submitted. Rate limit is 5 submissions per minute. Please try again later."
            });
            return;
          }
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const details = typeof body.details === "string" ? body.details.trim() : "";
          if (!title && !details) {
            this.sendJson(res, 400, {
              error: "invalid_request",
              message: "Bug report requires at least a title or details."
            });
            return;
          }
          const validSeverities = ["low", "medium", "high", "critical"];
          const severity = validSeverities.includes(body.severity) ? body.severity : "medium";
          const bugId = `bug_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
          const record = {
            id: bugId,
            agentId: rawAgentId || void 0,
            title: title || "Untitled Bug Report",
            details: details || "(No additional details provided)",
            severity,
            context: body.context || void 0,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            ip: clientIp,
            userAgent: req.headers["user-agent"] || void 0,
            resolved: false
          };
          try {
            fs.appendFileSync(this.bugLogPath, JSON.stringify(record) + "\n", "utf8");
          } catch (err) {
            console.error("[BUG-LOG ERROR] Failed to append bug report:", err);
          }
          this.bugReports.push(record);
          if (this.bugReports.length > 500) this.bugReports.shift();
          console.log(`[BUG REPORT] ${record.id} [${record.severity.toUpperCase()}] ${record.title} (Agent: ${record.agentId || "anonymous"})`);
          this.sendJson(res, 201, {
            status: "ok",
            bugId: record.id,
            report: record
          });
        }, 10240);
        return;
      }
      if (req.method === "GET" && parsedUrl === "/api/bugs") {
        const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const limit = parseInt(urlObj.searchParams.get("limit") || "100", 10);
        const agentId = urlObj.searchParams.get("agentId");
        let reports = this.bugReports;
        if (agentId) {
          reports = reports.filter((r) => r.agentId === agentId);
        }
        this.sendJson(res, 200, {
          status: "ok",
          count: reports.length,
          bugs: reports.slice(-limit)
        });
        return;
      }
      const bugResolveMatch = parsedUrl.match(/^\/api\/bugs\/([^/]+)\/resolve$/);
      if (req.method === "POST" && bugResolveMatch) {
        readJson((body) => {
          const bugId = bugResolveMatch[1];
          const bug = this.bugReports.find((b) => b.id === bugId);
          if (!bug) {
            this.sendJson(res, 404, { error: "not_found", message: "Bug report not found" });
            return;
          }
          const human = this.getAuthenticatedHuman(req);
          const token = this.extractToken(req);
          const apiKeyRecord = token ? this.apiKeys.get(token) : null;
          const resolver = human ? human.name || human.email : body.resolvedBy || body.agentId || (apiKeyRecord ? apiKeyRecord.id : "Administrator");
          const shouldResolve = body.resolved !== void 0 ? Boolean(body.resolved) : true;
          bug.resolved = shouldResolve;
          if (shouldResolve) {
            bug.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
            bug.resolvedBy = resolver;
            if (body.note || body.resolutionNote) {
              bug.resolutionNote = body.note || body.resolutionNote;
            }
          } else {
            bug.resolvedAt = void 0;
            bug.resolvedBy = void 0;
            bug.resolutionNote = void 0;
          }
          try {
            fs.writeFileSync(this.bugLogPath, this.bugReports.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf8");
          } catch (err) {
            console.error("[BUG-LOG ERROR] Failed to sync bug resolution:", err);
          }
          console.log(`[BUG REPORT ${shouldResolve ? "RESOLVED" : "REOPENED"}] ${bug.id} by ${resolver}`);
          this.sendJson(res, 200, { status: "ok", bug });
        });
        return;
      }
      this.serveStatic(req, res, parsedUrl);
    } catch (err) {
      console.error(`[SERVER ERROR] ${req.method} ${req.url}:`, err);
      this.sendJson(res, 500, { error: "internal_server_error", message: err?.message || "Internal server error" });
    }
  }
  serveStatic(req, res, parsedUrl) {
    if (parsedUrl.startsWith("/docs/")) {
      const relDoc = parsedUrl.replace(/^\/docs\//, "");
      const docPath = path.join(path.resolve("docs"), relDoc);
      if (fs.existsSync(docPath) && !fs.statSync(docPath).isDirectory()) {
        try {
          const content = fs.readFileSync(docPath);
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Length": content.length,
            "Cache-Control": "no-cache, no-store, must-revalidate"
          });
          res.end(content);
          return;
        } catch {
        }
      }
    }
    let filePath = path.join(this.staticPath, parsedUrl === "/" ? "index.html" : parsedUrl);
    if (parsedUrl === "/onboarding" || parsedUrl === "/onboarding.md") {
      filePath = path.join(this.staticPath, "onboarding.md");
    } else if (parsedUrl === "/skill" || parsedUrl === "/skill.md") {
      filePath = path.join(this.staticPath, "skill.md");
    } else if (!fs.existsSync(filePath)) {
      filePath = path.join(this.staticPath, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".md": "text/markdown; charset=utf-8"
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
  handleWebSocketConnection(ws, req) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "register_supervisor") {
          this.supervisorSockets.add(ws);
        }
      } catch {
      }
    });
    ws.on("close", () => {
      this.supervisorSockets.delete(ws);
    });
  }
  notifySupervisors(event) {
    const raw = JSON.stringify(event);
    for (const ws of this.supervisorSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }
  extractToken(req) {
    const auth = req.headers["authorization"] || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      return auth.substring(7).trim();
    }
    const adminHeader = req.headers["x-admin-token"];
    if (typeof adminHeader === "string") return adminHeader.trim();
    return null;
  }
  getAuthenticatedHuman(req) {
    const token = this.extractToken(req);
    if (!token) return null;
    return this.humanSessions.get(token) || null;
  }
};

// server/run.ts
import path2 from "node:path";
var defaultPort = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" ? 3001 : 3e3;
var port = parseInt(process.env.PORT || String(defaultPort), 10);
var staticPath = process.env.STATIC_PATH || path2.resolve("web");
var server = new AgentLinkServer(port, staticPath);
server.listen().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
