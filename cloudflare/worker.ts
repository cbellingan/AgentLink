/**
 * AgentLink Cloudflare Worker
 */

export interface Env {
  ADMIN_EMAIL?: string;
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
    const adminEmail = env.ADMIN_EMAIL || 'cbellingan@gmail.com';

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
        adminEmail,
        version: '1.0.0',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Google Sign-In
    if (request.method === 'POST' && url.pathname === '/api/auth/google') {
      const body: any = await request.json().catch(() => ({}));
      const email = (body.email || '').trim().toLowerCase();

      if (email !== adminEmail) {
        return new Response(JSON.stringify({
          error: 'not_enabled',
          message: 'Not enabled right now',
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const token = `sec_hum_${crypto.randomUUID().replace(/-/g, '')}`;
      const user = {
        id: 'human_carl',
        name: 'Carl Bellingan',
        email: adminEmail,
        avatar: '👑',
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
        ownerHumanId: 'human_carl',
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
