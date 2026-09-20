// cloudflare/worker.ts
var memoryState = {
  sessions: /* @__PURE__ */ new Map(),
  apiKeys: /* @__PURE__ */ new Map(),
  agents: /* @__PURE__ */ new Map(),
  links: /* @__PURE__ */ new Map()
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const adminEmail = env.ADMIN_EMAIL || "admin@test.local";
    let adminEmailHash = env.ADMIN_EMAIL_HASH;
    if (!adminEmailHash) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminEmail.toLowerCase()));
      adminEmailHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    const envHashes = (env.AUTHORIZED_EMAIL_HASHES || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    const authorizedHashes = /* @__PURE__ */ new Set([
      adminEmailHash,
      ...envHashes
    ]);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/api/server-info") {
      return new Response(JSON.stringify({
        name: "AgentLink Cloudflare Worker",
        adminConfigured: true,
        version: "1.0.0"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/google") {
      const body = await request.json().catch(() => ({}));
      const email = (body.email || "").trim().toLowerCase();
      const emailBuf = new TextEncoder().encode(email);
      const hashBuf = await crypto.subtle.digest("SHA-256", emailBuf);
      const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!authorizedHashes.has(hashHex)) {
        return new Response(JSON.stringify({
          error: "not_enabled",
          message: "Not enabled right now"
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const isAdmin = hashHex === adminEmailHash;
      const token = `sec_hum_${crypto.randomUUID().replace(/-/g, "")}`;
      const user = {
        id: isAdmin ? "human_admin" : `human_${hashHex.slice(0, 12)}`,
        name: isAdmin ? "Administrator" : email.split("@")[0],
        email,
        avatar: isAdmin ? "\u{1F451}" : "\u2728",
        role: "admin"
      };
      memoryState.sessions.set(token, user);
      return new Response(JSON.stringify({
        status: "ok",
        authenticated: true,
        token,
        user
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/keys/generate") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      const user = memoryState.sessions.get(token);
      if (!user) {
        return new Response(JSON.stringify({ error: "forbidden", message: "Admin session required" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const keyVal = `sec_apk_${crypto.randomUUID().replace(/-/g, "")}`;
      const keyRecord = {
        id: `key_${Date.now()}`,
        key: keyVal,
        ownerHumanId: user.id,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      memoryState.apiKeys.set(keyVal, keyRecord);
      return new Response(JSON.stringify({ status: "ok", apiKey: keyRecord }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/agents/register") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      const validKey = memoryState.apiKeys.has(token);
      if (!validKey) {
        return new Response(JSON.stringify({
          error: "invalid_api_key",
          message: "Valid AgentLink API key required for registration"
        }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const body = await request.json().catch(() => ({}));
      const agentId = body.id || `agent_${crypto.randomUUID().substring(0, 8)}`;
      const agentRecord = {
        id: agentId,
        ownerHumanId: "human_admin",
        registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
        signPub: body.signPub,
        encPub: body.encPub,
        kid: body.kid,
        qrPayload: body.qrPayload
      };
      memoryState.agents.set(agentId, agentRecord);
      return new Response(JSON.stringify({
        status: "ok",
        agentId: agentRecord.id,
        pollUrl: `/api/agents/${agentRecord.id}/poll`
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/agents") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      const validKey = memoryState.apiKeys.has(token) || memoryState.sessions.has(token);
      if (!validKey) {
        return new Response(JSON.stringify({ error: "unauthorized", message: "Authentication required" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        status: "ok",
        agents: Array.from(memoryState.agents.values())
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
};
export {
  worker_default as default
};
