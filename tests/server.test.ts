import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ADMIN_EMAIL = 'admin@test.local';

describe('AgentLink Server Test Suite', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;
  let adminToken: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-server-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');
    process.env.AUTHORIZED_EMAIL_HASHES = crypto.createHash('sha256').update('coop@test.local').digest('hex');

    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. Rejects Google sign-in for any unlisted account with "Not enabled right now"', async () => {
    const res = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@example.com' }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('not_enabled');
    expect(data.message).toBe('Not enabled right now');
  });

  it('2. Authenticates authorized administrator email and issues admin session token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.authenticated).toBe(true);
    expect(data.token).toMatch(/^sec_hum_/);
    expect(data.user.email).toBe(TEST_ADMIN_EMAIL);
    expect(data.user.role).toBe('admin');
    adminToken = data.token;
  });

  it('2b. Authenticates authorized co-operator email (via authorized hash) and issues session', async () => {
    const COOP_HASH = crypto.createHash('sha256').update('coop@test.local').digest('hex');
    expect(server.authorizedEmailHashes.has(COOP_HASH)).toBe(true);

    // Any account whose hash matches the authorized set is permitted
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'AdminSecure2026!' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authenticated).toBe(true);
    expect(data.token).toMatch(/^sec_hum_/);
  });

  it('3. Generates API key for agent provisioning', async () => {
    // Authenticate Admin
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    }).then(r => r.json());

    const token = authRes.token;

    // Generate API key
    const genRes = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ label: 'Test Agent Key' }),
    });

    expect(genRes.status).toBe(201);
    const genData = await genRes.json();
    expect(genData.status).toBe('ok');
    expect(genData.apiKey.key).toMatch(/^sec_apk_/);

    // List API keys
    const listRes = await fetch(`${baseUrl}/api/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).then(r => r.json());

    expect(listRes.keys.length).toBeGreaterThanOrEqual(1);
    expect(listRes.keys.some((k: any) => k.id === genData.apiKey.id)).toBe(true);
  });

  it('4. Rejects agent registration when invalid API key is provided', async () => {
    const regRes = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid_api_key',
      },
      body: JSON.stringify({ id: 'bad-agent' }),
    });

    expect(regRes.status).toBe(401);
    const err = await regRes.json();
    expect(err.error).toBe('invalid_api_key');
  });

  it('5. Successfully registers agent when valid API key is presented', async () => {
    // 1. Generate key as Admin
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    }).then(r => r.json());

    const keyRes = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authRes.token}`,
      },
      body: JSON.stringify({ label: 'Ted Key' }),
    }).then(r => r.json());

    expect(keyRes.apiKey.lastUsedAt).toBeFalsy();
    const apiKey = keyRes.apiKey.key;

    // 2. Register agent
    const regRes = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        id: 'ted-agent',
        signPub: 'sample_sign_pubkey',
        encPub: 'sample_enc_pubkey',
        kid: 'kid-ted-001',
        qrPayload: JSON.stringify({ v: 1, agent: 'ted-agent' }),
      }),
    });

    expect(regRes.status).toBe(200);
    const regData = await regRes.json();
    expect(regData.status).toBe('ok');
    expect(regData.agentId).toBe('ted-agent');
    expect(regData.pollUrl).toBe('/api/agents/ted-agent/poll');

    // 3. Confirm agent appears in fleet listing
    const agentsRes = await fetch(`${baseUrl}/api/agents`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }).then(r => r.json());
    expect(agentsRes.agents.some((a: any) => a.id === 'ted-agent')).toBe(true);

    // 4. Confirm lastUsedAt was recorded and returned in /api/keys
    const keysAfterReg = await fetch(`${baseUrl}/api/keys`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }).then(r => r.json());
    const tedKey = keysAfterReg.keys.find((k: any) => k.id === keyRes.apiKey.id);
    expect(tedKey).toBeDefined();
    expect(tedKey.lastUsedAt).toBeDefined();
    expect(new Date(tedKey.lastUsedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('6. Creates link, dispatches conversation frames, and returns flow via GET /api/links/:linkId', async () => {
    // 1. Establish link
    const linkRes = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ agentAId: 'antigravity', agentBId: 'ted-agent' }),
    }).then(r => r.json());

    expect(linkRes.status).toBe('ok');
    const linkId = linkRes.linkId;

    // Approve link
    await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({}),
    });

    // 2. Dispatch a message into conversation
    const msgRes = await fetch(`${baseUrl}/api/links/${linkId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ senderId: 'antigravity', payload: 'Hello Ted from the UI!' }),
    }).then(r => r.json());

    expect(msgRes.status).toBe('ok');

    // 3. Retrieve link conversation flow
    const getRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.status).toBe('ok');
    expect(getData.link.id).toBe(linkId);
    expect(getData.link.framesCount).toBe(1);
    expect(getData.link.recentMessages.length).toBe(1);
    expect(getData.link.recentMessages[0].senderId).toBe('antigravity');
    expect(getData.link.recentMessages[0].targetId).toBe('ted-agent');
    expect(getData.link.recentMessages[0].text).toBe('Hello Ted from the UI!');
  });

  it('7. Regression: Server configures keepAliveTimeout >= 120s and sets Keep-Alive response header', async () => {
    // Reverse proxy keep-alive alignment with cloudflared (90s idle timeout)
    expect(server.server.keepAliveTimeout).toBeGreaterThanOrEqual(120000);
    expect(server.server.headersTimeout).toBeGreaterThanOrEqual(125000);

    const res = await fetch(`${baseUrl}/api/server-info`);
    expect(res.status).toBe(200);
    expect(res.headers.get('keep-alive')).toBe('timeout=120, max=1000');
    expect(res.headers.get('content-length')).toBeTruthy();
  });

  it('8. Regression: GET /api/agents strips heavy qrPayload to prevent chunked response truncation', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.agents.length).toBeGreaterThan(0);

    // Every agent in the fleet listing MUST NOT have qrPayload to maintain compact payloads
    for (const agent of data.agents) {
      expect(agent.qrPayload).toBeUndefined();
      expect(agent.id).toBeTruthy();
      expect(agent.signPub).toBeTruthy();
      expect(agent.encPub).toBeTruthy();
    }
  });

  it('9. Regression: Direct lookup and filtered query preserve single agent details', async () => {
    // Single agent lookup by ID
    const singleRes = await fetch(`${baseUrl}/api/agents/ted-agent`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(singleRes.status).toBe(200);
    const singleData = await singleRes.json();
    expect(singleData.agent.id).toBe('ted-agent');

    // Filtered query via ?agentId=ted-agent
    const filterRes = await fetch(`${baseUrl}/api/agents?agentId=ted-agent`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(filterRes.status).toBe(200);
    const filterData = await filterRes.json();
    expect(filterData.agents.length).toBe(1);
    expect(filterData.agents[0].id).toBe('ted-agent');
  });

  it('10. Telemetry & Metrics: Accurate tracking of message counts, payload sizes, reliability, and dedicated metrics endpoint', async () => {
    const agentAId = 'metrics-agent-a';
    const agentBId = 'metrics-agent-b';

    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ id: agentAId, signPub: 'signA==', encPub: 'encA==', kid: 'kid-metrics-a' }),
    });
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ id: agentBId, signPub: 'signB==', encPub: 'encB==', kid: 'kid-metrics-b' }),
    });

    // 1. Establish and approve a fresh link between metrics-agent-a and metrics-agent-b
    const linkRes = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ agentAId, agentBId }),
    }).then(r => r.json());
    const linkId = linkRes.linkId;

    await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({}),
    });

    // 2. Transmit frame from agentA -> agentB
    const payloadA = { v: 2, seq: 101, data: 'ciphertext_payload_abcdef123456', sig: 'valid_sig_xyz' };
    const sendResA = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ senderId: agentAId, payload: payloadA }),
    }).then(r => r.json());
    expect(sendResA.status).toBe('ok');

    // 3. Inspect metrics before polling (1 message in flight/pending)
    const metricsBeforeRes = await fetch(`${baseUrl}/api/links/${linkId}/metrics`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(metricsBeforeRes.status).toBe(200);
    const { metrics: mBefore } = await metricsBeforeRes.json();
    expect(mBefore.totalMessages).toBe(1);
    expect(mBefore.messagesAtoB).toBe(1);
    expect(mBefore.messagesBtoA).toBe(0);
    expect(mBefore.pendingMessages).toBe(1);
    expect(mBefore.totalBytes).toBeGreaterThan(0);
    expect(mBefore.bytesAtoB).toBe(mBefore.totalBytes);
    expect(mBefore.lastSequenceA).toBe(101);

    // 4. Recipient agent polls and receives the frame
    const pollRes = await fetch(`${baseUrl}/api/agents/${agentBId}/poll?timeout=1000`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();
    expect(pollData.messages.length).toBe(1);

    // 5. Inspect metrics after delivery (0 pending, 1 delivered, 100% reliability)
    const metricsAfterRes = await fetch(`${baseUrl}/api/links/${linkId}/metrics`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    const { metrics: mAfter } = await metricsAfterRes.json();
    expect(mAfter.pendingMessages).toBe(0);
    expect(mAfter.deliveredMessages).toBe(1);
    expect(mAfter.reliabilityPercent).toBe(100);
    expect(mAfter.status).toBe('optimal');
    expect(mAfter.lastDeliveredAt).toBeTruthy();

    // 6. Transmit return frame from agentB -> agentA
    const payloadB = { v: 2, seq: 42, data: 'reply_payload_987654321', sig: 'sig_b' };
    await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ senderId: agentBId, payload: payloadB }),
    });

    // 7. Verify full link representation includes metrics
    const fullLinkRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    const fullLinkData = await fullLinkRes.json();
    const finalMetrics = fullLinkData.link.metrics;
    expect(finalMetrics.totalMessages).toBe(2);
    expect(finalMetrics.messagesAtoB).toBe(1);
    expect(finalMetrics.messagesBtoA).toBe(1);
    expect(finalMetrics.bytesAtoB).toBeGreaterThan(0);
    expect(finalMetrics.bytesBtoA).toBeGreaterThan(0);
    expect(finalMetrics.totalBytes).toBe(finalMetrics.bytesAtoB + finalMetrics.bytesBtoA);
    expect(finalMetrics.avgPayloadBytes).toBe(Math.round(finalMetrics.totalBytes / 2));
    expect(finalMetrics.maxPayloadBytes).toBe(Math.max(finalMetrics.bytesAtoB, finalMetrics.bytesBtoA));
    expect(finalMetrics.lastSequenceB).toBe(42);
  });
});

