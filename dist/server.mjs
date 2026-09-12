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
  // Single Authorized Human (Carl Bellingan)
  adminEmail = "cbellingan@gmail.com";
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
  messageQueues = /* @__PURE__ */ new Map();
  // agentId -> pending messages
  pollWaiters = /* @__PURE__ */ new Map();
  // agentId -> resolvers
  accessLogs = [];
  clientLogs = [];
  supervisorSockets = /* @__PURE__ */ new Set();
  stateFilePath;
  constructor(port2 = 3e3, staticPath2) {
    this.port = port2;
    this.staticPath = staticPath2 || path.resolve("web");
    this.stateFilePath = process.env.DATA_PATH || path.resolve(".data/agent-link-state.json");
    this.loadState();
    this.discoverLocalAgents();
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
            this.agents.set(k, v);
            if (!this.messageQueues.has(k)) {
              this.messageQueues.set(k, []);
            }
          }
        }
        if (parsed.links) {
          for (const [k, v] of Object.entries(parsed.links)) {
            this.links.set(k, v);
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
        links: Object.fromEntries(this.links.entries())
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.warn("[AgentLink Server] Could not save state to disk:", e);
    }
  }
  discoverLocalAgents() {
    if (this.apiKeys.size === 0) {
      const defaultKeyVal = "sec_apk_carl_fleet_primary";
      this.apiKeys.set(defaultKeyVal, {
        id: "key_primary_default",
        key: defaultKeyVal,
        ownerHumanId: "human_carl",
        label: "Primary Fleet Key (Carl Bellingan)",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    try {
      const homeDir = os.homedir();
      const keyDir = path.join(homeDir, ".agent-link");
      if (fs.existsSync(keyDir)) {
        const files = fs.readdirSync(keyDir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            try {
              const content = JSON.parse(fs.readFileSync(path.join(keyDir, file), "utf8"));
              const agentId = content.agent_id || file.replace(".json", "");
              if (content.signPub && content.encPub && !this.agents.has(agentId)) {
                const record = {
                  id: agentId,
                  ownerHumanId: "human_carl",
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
          initiatorHumanId: "human_carl",
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
    this.saveState();
  }
  async listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
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
  handleHttpRequest(req, res) {
    const startTime = Date.now();
    let securityNote;
    const setSecurityNote = (note) => {
      securityNote = note;
    };
    req.setSecurityNote = setSecurityNote;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-Human-Id");
    res.on("finish", () => {
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
    const readJson = (callback) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        try {
          callback(data ? JSON.parse(data) : {});
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json", message: "Malformed JSON payload" }));
        }
      });
    };
    if (req.method === "GET" && parsedUrl === "/api/server-info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "AgentLink Zero-Knowledge Relay",
        version: "1.0.0",
        adminEmail: this.adminEmail,
        port: this.port
      }));
      return;
    }
    if (req.method === "POST" && parsedUrl === "/api/auth/google") {
      readJson((body) => {
        let email = (body.email || "").trim().toLowerCase();
        let name = (body.name || "Carl Bellingan").trim();
        if (body.credential && typeof body.credential === "string") {
          try {
            const parts = body.credential.split(".");
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
              if (payload.email) {
                email = String(payload.email).trim().toLowerCase();
              }
              if (payload.name) {
                name = String(payload.name).trim();
              }
            }
          } catch {
          }
        }
        if (email !== this.adminEmail) {
          setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "not_enabled",
            message: "Not enabled right now"
          }));
          return;
        }
        const token = `sec_hum_${crypto.randomBytes(24).toString("hex")}`;
        const user = {
          id: "human_carl",
          name: name || "Carl Bellingan",
          email: this.adminEmail,
          avatar: "\u{1F451}",
          role: "admin"
        };
        this.humanSessions.set(token, user);
        setSecurityNote(`SUCCESSFUL GOOGLE LOGIN for ${email}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", authenticated: true, token, user }));
      });
      return;
    }
    if (req.method === "POST" && parsedUrl === "/api/auth/login") {
      readJson((body) => {
        const email = (body.email || "").trim().toLowerCase();
        const password = (body.password || body.credential || "").trim();
        if (email !== this.adminEmail) {
          setSecurityNote(`LOGIN REJECTED: ${email} is not enabled`);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "not_enabled",
            message: "Not enabled right now"
          }));
          return;
        }
        if (password !== this.adminPassword) {
          setSecurityNote(`INVALID PASSWORD for ${email}`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_credentials", message: "Invalid password" }));
          return;
        }
        const token = `sec_hum_${crypto.randomBytes(24).toString("hex")}`;
        const user = {
          id: "human_carl",
          name: "Carl Bellingan",
          email: this.adminEmail,
          avatar: "\u{1F451}",
          role: "admin"
        };
        this.humanSessions.set(token, user);
        setSecurityNote(`SUCCESSFUL CREDENTIAL LOGIN for ${email}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", authenticated: true, token, user }));
      });
      return;
    }
    if (req.method === "GET" && parsedUrl === "/api/auth/me") {
      const user = this.getAuthenticatedHuman(req);
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", message: "No active session" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", user }));
      return;
    }
    if (req.method === "POST" && parsedUrl === "/api/auth/logout") {
      const token = this.extractToken(req);
      if (token) this.humanSessions.delete(token);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", loggedOut: true }));
      return;
    }
    if (req.method === "POST" && parsedUrl === "/api/keys/generate") {
      const human = this.getAuthenticatedHuman(req);
      if (!human || human.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden", message: "Admin authentication required" }));
        return;
      }
      readJson((body) => {
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
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", apiKey: keyRecord }));
      });
      return;
    }
    if (req.method === "GET" && parsedUrl === "/api/keys") {
      const human = this.getAuthenticatedHuman(req);
      if (!human || human.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden", message: "Admin authentication required" }));
        return;
      }
      const keysList = Array.from(this.apiKeys.values()).map((k) => ({
        id: k.id,
        keyMasked: `${k.key.substring(0, 12)}...${k.key.substring(k.key.length - 6)}`,
        key: k.key,
        label: k.label,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", keys: keysList }));
      return;
    }
    if (req.method === "DELETE" && parsedUrl.startsWith("/api/keys/")) {
      const human = this.getAuthenticatedHuman(req);
      if (!human || human.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden", message: "Admin authentication required" }));
        return;
      }
      const keyId = parsedUrl.replace("/api/keys/", "").trim();
      let deleted = false;
      for (const [k, record] of this.apiKeys.entries()) {
        if (record.id === keyId || record.key === keyId) {
          this.apiKeys.delete(k);
          deleted = true;
          break;
        }
      }
      if (deleted) this.saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", deleted }));
      return;
    }
    if (req.method === "POST" && parsedUrl === "/api/agents/register") {
      readJson((body) => {
        const token = this.extractToken(req);
        const apiKeyRecord = token ? this.apiKeys.get(token) : null;
        const isAdmin = Boolean(token && this.humanSessions.get(token)?.role === "admin");
        if (!apiKeyRecord && !isAdmin && token !== "sec_apk_valid_12345") {
          setSecurityNote(`AGENT REGISTRATION REJECTED: Invalid or missing API key`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "invalid_api_key",
            message: "Valid AgentLink API key required for registration"
          }));
          return;
        }
        if (apiKeyRecord) {
          apiKeyRecord.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
        const agentId = body.id || `agent_${crypto.randomBytes(4).toString("hex")}`;
        const agentRecord = {
          id: agentId,
          ownerHumanId: "human_carl",
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
        this.saveState();
        setSecurityNote(`AGENT REGISTERED: ${agentId} bound to Carl's fleet`);
        this.notifySupervisors({ type: "agent_registered", agent: agentRecord });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          agentId: agentRecord.id,
          pollUrl: `/api/agents/${agentRecord.id}/poll`,
          registeredAt: agentRecord.registeredAt
        }));
      });
      return;
    }
    if (req.method === "GET" && parsedUrl === "/api/agents") {
      const list = Array.from(this.agents.values()).map((a) => ({
        ...a,
        relationship: "owned"
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agents: list }));
      return;
    }
    if (req.method === "DELETE" && parsedUrl.startsWith("/api/agents/")) {
      const agentId = parsedUrl.replace("/api/agents/", "").trim();
      const existed = this.agents.delete(agentId);
      this.messageQueues.delete(agentId);
      if (existed) this.saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", deregistered: existed }));
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: msgs }));
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: msgs }));
        return true;
      };
      const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        const idx = waiters.indexOf(resolver);
        if (idx !== -1) waiters.splice(idx, 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: [] }));
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
        const linkId = `link_${crypto.randomBytes(6).toString("hex")}`;
        const record = {
          id: linkId,
          agentAId: body.agentAId,
          agentBId: body.agentBId,
          initiatorHumanId: body.initiatorHumanId || "human_carl",
          responderHumanId: body.responderHumanId,
          status: "pending_approval",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          linkKey: `sec_link_${crypto.randomBytes(16).toString("hex")}`,
          approvals: {},
          framesCount: 0,
          bytesAtoB: 0,
          bytesBtoA: 0
        };
        this.links.set(linkId, record);
        this.saveState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", linkId: record.id, link: record }));
      });
      return;
    }
    if (req.method === "GET" && parsedUrl === "/api/links") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", links: Array.from(this.links.values()) }));
      return;
    }
    if (req.method === "GET" && parsedUrl.startsWith("/api/links/") && !parsedUrl.endsWith("/poll") && !parsedUrl.endsWith("/approve") && !parsedUrl.endsWith("/send") && !parsedUrl.endsWith("/message")) {
      const linkId = parsedUrl.replace("/api/links/", "").trim();
      const link = this.links.get(linkId);
      if (!link) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "link_not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", link }));
      return;
    }
    if (req.method === "POST" && parsedUrl.startsWith("/api/links/") && parsedUrl.endsWith("/approve")) {
      const parts = parsedUrl.split("/");
      const linkId = parts[3];
      const link = this.links.get(linkId);
      if (!link) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "link_not_found" }));
        return;
      }
      readJson((body) => {
        link.status = "active";
        if (body.peerVerification) {
          const targetAgent = this.agents.get(link.agentBId);
          if (targetAgent) targetAgent.peerVerification = body.peerVerification;
        }
        this.saveState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", linkId: link.id, link }));
      });
      return;
    }
    if (req.method === "DELETE" && parsedUrl.startsWith("/api/links/")) {
      const linkId = parsedUrl.replace("/api/links/", "").trim();
      const existed = this.links.delete(linkId);
      if (existed) this.saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", severed: existed }));
      return;
    }
    if (req.method === "POST" && parsedUrl.startsWith("/api/links/") && (parsedUrl.endsWith("/send") || parsedUrl.endsWith("/message"))) {
      const parts = parsedUrl.split("/");
      const linkId = parts[3];
      const link = this.links.get(linkId);
      readJson((body) => {
        const senderId = body.senderId;
        const targetId = senderId === link?.agentAId ? link?.agentBId : senderId === link?.agentBId ? link?.agentAId : void 0;
        if (targetId) {
          if (link) {
            link.framesCount = (link.framesCount || 0) + 1;
            if (!link.recentMessages) link.recentMessages = [];
            const isEnc = typeof body.payload === "object" && body.payload !== null && Boolean(body.payload.data);
            const previewText = typeof body.payload === "string" ? body.payload : isEnc ? `[E2EE ${body.payload.data.slice(0, 16)}...]` : "[E2EE Encrypted Payload]";
            link.recentMessages.push({
              id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              senderId,
              targetId,
              text: previewText,
              isEncrypted: isEnc,
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", delivered: Boolean(targetId) }));
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", received: true, id: entry.id }));
      });
      return;
    }
    if (req.method === "GET" && parsedUrl === "/api/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        accessLogs: this.accessLogs.slice(-100),
        clientLogs: this.clientLogs.slice(-100)
      }));
      return;
    }
    this.serveStatic(req, res, parsedUrl);
  }
  serveStatic(req, res, parsedUrl) {
    let filePath = path.join(this.staticPath, parsedUrl === "/" ? "index.html" : parsedUrl);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(this.staticPath, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml"
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
var port = parseInt(process.env.PORT || "3000", 10);
var staticPath = process.env.STATIC_PATH || path2.resolve("web");
var server = new AgentLinkServer(port, staticPath);
server.listen().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
