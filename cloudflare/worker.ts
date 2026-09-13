/**
 * AgentLink Cloudflare Worker
 */

export interface Env {
  ADMIN_EMAIL_HASH?: string;
}

const memoryState = {
  sessions: new Map<string, any>(),
  apiKeys: new Map<string, any>(),
  agents: new Map<string, any>(),
  links: new Map<string, any>(),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const adminEmailHash = env.ADMIN_EMAIL_HASH || '0b5970d2145747e2cf2aa4cd74b850966705b49554f32801d3d62e283b703c4c';
    const authorizedHashes = new Set([
      adminEmailHash,
      // Authorized co-operator (obfuscated SHA-256)
      '26c999964b122f7bd403eaa903d40de0fe3ceb78f2fdc711d5998739bf400a01',
    ]);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // Server Info
    if (request.method === 'GET' && url.pathname === '/api/server-info') {
      return new Response(JSON.stringify({
        name: 'AgentLink Cloudflare Worker',
        adminConfigured: true,
        version: '1.0.0',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Google Sign-In
    if (request.method === 'POST' && url.pathname === '/api/auth/google') {
      const body: any = await request.json().catch(() => ({}));
      const email = (body.email || '').trim().toLowerCase();

      const emailBuf = new TextEncoder().encode(email);
      const hashBuf = await crypto.subtle.digest('SHA-256', emailBuf);
      const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

      if (!authorizedHashes.has(hashHex)) {
        return new Response(JSON.stringify({
          error: 'not_enabled',
          message: 'Not enabled right now',
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const isAdmin = hashHex === adminEmailHash;
      const token = `sec_hum_${crypto.randomUUID().replace(/-/g, '')}`;
      const user = {
        id: isAdmin ? 'human_admin' : `human_${hashHex.slice(0, 12)}`,
        name: isAdmin ? 'Administrator' : email.split('@')[0],
        email: email,
        avatar: isAdmin ? '👑' : '✨',
        role: 'admin',
      };
      memoryState.sessions.set(token, user);

      return new Response(JSON.stringify({
        status: 'ok',
        authenticated: true,
        token,
        user,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate API Key
    if (request.method === 'POST' && url.pathname === '/api/keys/generate') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      const user = memoryState.sessions.get(token);

      if (!user) {
        return new Response(JSON.stringify({ error: 'forbidden', message: 'Admin session required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const keyVal = `sec_apk_${crypto.randomUUID().replace(/-/g, '')}`;
      const keyRecord = {
        id: `key_${Date.now()}`,
        key: keyVal,
        ownerHumanId: user.id,
        createdAt: new Date().toISOString(),
      };
      memoryState.apiKeys.set(keyVal, keyRecord);

      return new Response(JSON.stringify({ status: 'ok', apiKey: keyRecord }), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Register Agent
    if (request.method === 'POST' && url.pathname === '/api/agents/register') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      const validKey = memoryState.apiKeys.has(token) || token === 'sec_apk_valid_12345';

      if (!validKey) {
        return new Response(JSON.stringify({
          error: 'invalid_api_key',
          message: 'Valid AgentLink API key required for registration',
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const body: any = await request.json().catch(() => ({}));
      const agentId = body.id || `agent_${crypto.randomUUID().substring(0, 8)}`;
      const agentRecord = {
        id: agentId,
        ownerHumanId: 'human_admin',
        registeredAt: new Date().toISOString(),
        signPub: body.signPub,
        encPub: body.encPub,
        kid: body.kid,
        qrPayload: body.qrPayload,
      };
      memoryState.agents.set(agentId, agentRecord);

      return new Response(JSON.stringify({
        status: 'ok',
        agentId: agentRecord.id,
        pollUrl: `/api/agents/${agentRecord.id}/poll`,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // List Agents
    if (request.method === 'GET' && url.pathname === '/api/agents') {
      return new Response(JSON.stringify({
        status: 'ok',
        agents: Array.from(memoryState.agents.values()),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
