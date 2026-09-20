import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ADMIN_EMAIL = 'admin@secops.local';
const BOB_EMAIL = 'bob@secops.local';

describe('Queue Protection & Read Endpoint Authorization Security Suite', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;

  let adminToken: string;
  let bobToken: string;
  let apiKeyAlpha: string;
  let apiKeyBeta: string;
  let linkId: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-queue-sec-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(ADMIN_EMAIL).digest('hex');

    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Authenticate Admin
    const adminLogin = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    }).then(r => r.json());
    adminToken = adminLogin.token;

    // 2. Invite and Authenticate Operator Bob
    const inviteRes = await fetch(`${baseUrl}/api/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ toEmail: BOB_EMAIL }),
    }).then(r => r.json());
    const inviteToken = inviteRes.invite.token;

    const bobLogin = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: BOB_EMAIL, name: 'Bob Collaborator', inviteToken }),
    }).then(r => r.json());
    bobToken = bobLogin.token;

    // 3. Generate API Key for Operator A (Admin)
    const keyResAlpha = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ label: 'Key for Agent Alpha' }),
    }).then(r => r.json());
    apiKeyAlpha = keyResAlpha.apiKey.key;

    // 4. Generate API Key for Operator B (Bob)
    const keyResBeta = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bobToken}`,
      },
      body: JSON.stringify({ label: 'Key for Agent Beta' }),
    }).then(r => r.json());
    apiKeyBeta = keyResBeta.apiKey.key;

    // 5. Register Agent Alpha (owned by Admin)
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyAlpha}`,
      },
      body: JSON.stringify({
        id: 'agent-alpha',
        signPub: 'pub_alpha_sign_123',
        encPub: 'pub_alpha_enc_123',
        kid: 'kid-alpha-001',
      }),
    });

    // 6. Register Agent Beta (owned by Bob)
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyBeta}`,
      },
      body: JSON.stringify({
        id: 'agent-beta',
        signPub: 'pub_beta_sign_456',
        encPub: 'pub_beta_enc_456',
        kid: 'kid-beta-002',
      }),
    });

    // 7. Request and activate mutual link between Alpha and Beta
    const linkReq = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ agentAId: 'agent-alpha', agentBId: 'agent-beta' }),
    }).then(r => r.json());
    linkId = linkReq.linkId;

    // Approve link by Admin
    await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ force: true }),
    });

    // 8. Queue 3 confidential messages for Agent Alpha (dispatched by Beta across link)
    for (let i = 1; i <= 3; i++) {
      const sendRes = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeyBeta}` },
        body: JSON.stringify({
          senderId: 'agent-beta',
          payload: { data: `secret_payload_${i}`, sig: `sig_${i}`, seq: i },
        }),
      });
      expect(sendRes.status).toBe(200);
    }
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Failure Path 1: Anonymous GET /poll is rejected with 401 and DOES NOT drain the queue', async () => {
    // Attempt anonymous poll without any Authorization header
    const pollRes = await fetch(`${baseUrl}/api/agents/agent-alpha/poll?timeout=50`);
    expect(pollRes.status).toBe(401);
    const body = await pollRes.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toContain('Authentication required');

    // Invariant: The message queue for Agent Alpha MUST still contain all 3 messages!
    const internalQueue = server.messageQueues.get('agent-alpha');
    expect(internalQueue).toBeDefined();
    expect(internalQueue!.length).toBe(3);
    expect(internalQueue![0].payload.data).toBe('secret_payload_1');
    expect(internalQueue![1].payload.data).toBe('secret_payload_2');
    expect(internalQueue![2].payload.data).toBe('secret_payload_3');
  });

  it('Failure Path 2: Rogue agent polling another agent queue is rejected with 403 and DOES NOT drain the queue', async () => {
    // Agent Beta attempts to poll Agent Alpha's queue using Beta's API key
    const roguePollRes = await fetch(`${baseUrl}/api/agents/agent-alpha/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${apiKeyBeta}` },
    });
    expect(roguePollRes.status).toBe(403);
    const body = await roguePollRes.json();
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('Not authorized to poll messages for this agent');

    // Invariant: Queue remains completely untouched
    const internalQueue = server.messageQueues.get('agent-alpha');
    expect(internalQueue!.length).toBe(3);
  });

  it('Failure Path 3: Anonymous GET /api/agents is rejected with 401 without dumping fleet', async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.agents).toBeUndefined();
  });

  it('Failure Path 4: Anonymous GET /api/links is rejected with 401 without leaking topologies', async () => {
    const res = await fetch(`${baseUrl}/api/links`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.links).toBeUndefined();
  });

  it('Failure Path 5: Anonymous GET /api/agents/:id and GET /api/links/:id are rejected with 401', async () => {
    const agentRes = await fetch(`${baseUrl}/api/agents/agent-alpha`);
    expect(agentRes.status).toBe(401);

    const linkRes = await fetch(`${baseUrl}/api/links/${linkId}`);
    expect(linkRes.status).toBe(401);
  });

  it('Failure Path 6: Anonymous DELETE /api/links/:id is rejected with 401 and link is preserved', async () => {
    const deleteRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(401);

    // Verify link is still present on server
    const checkLink = await fetch(`${baseUrl}/api/links/${linkId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(checkLink.status).toBe(200);
  });

  it('Happy Path 1: Legitimate Agent Alpha polls with its API key and receives all 3 messages', async () => {
    const pollRes = await fetch(`${baseUrl}/api/agents/agent-alpha/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${apiKeyAlpha}` },
    });
    expect(pollRes.status).toBe(200);
    const data = await pollRes.json();
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBe(3);
    expect(data.messages[0].payload.data).toBe('secret_payload_1');
    expect(data.messages[1].payload.data).toBe('secret_payload_2');
    expect(data.messages[2].payload.data).toBe('secret_payload_3');

    // Invariant: Now that the legitimate owner polled, the queue is drained
    const secondPollRes = await fetch(`${baseUrl}/api/agents/agent-alpha/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${apiKeyAlpha}` },
    });
    expect(secondPollRes.status).toBe(200);
    const secondData = await secondPollRes.json();
    expect(secondData.messages.length).toBe(0);
  });

  it('Happy Path 2: Operator Bob lists agents and sees scoped relationship tags', async () => {
    const agentsRes = await fetch(`${baseUrl}/api/agents`, {
      headers: { 'Authorization': `Bearer ${bobToken}` },
    }).then(r => r.json());

    expect(agentsRes.status).toBe('ok');
    const betaRecord = agentsRes.agents.find((a: any) => a.id === 'agent-beta');
    expect(betaRecord).toBeDefined();
    expect(betaRecord.relationship).toBe('owned');

    const alphaRecord = agentsRes.agents.find((a: any) => a.id === 'agent-alpha');
    expect(alphaRecord).toBeDefined();
    expect(alphaRecord.relationship).toBe('peer');
  });

  it('Happy Path 3: Authorized link severance via DELETE /api/links/:id by participant', async () => {
    const deleteRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKeyAlpha}` },
    });
    expect(deleteRes.status).toBe(200);
    const deleteData = await deleteRes.json();
    expect(deleteData.severed).toBe(true);

    // Verify lookup now returns 404
    const getRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(getRes.status).toBe(404);
  });
});
