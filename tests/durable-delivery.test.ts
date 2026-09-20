import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { MessageSpool } from '../server/message-spool.js';

describe('Feature 9: Durable Delivery, Leasing, Idempotency, and Spool Resilience', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;
  let spoolFile: string;
  let adminToken: string;
  let linkId: string;
  let agentAliceId = 'agent-alice-durable';
  let agentBobId = 'agent-bob-durable';
  let aliceApiKey = 'sec_apk_alice_durable';
  let bobApiKey = 'sec_apk_bob_durable';

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-durable-test-'));
    spoolFile = path.join(tempDir, 'messages-spool.json');
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.SPOOL_PATH = spoolFile;

    // Use ephemeral port 0
    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;

    // Admin login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: server.adminPassword }),
    });
    const loginData = await loginRes.json();
    adminToken = loginData.token;

    // Provision API keys
    server.apiKeys.set(aliceApiKey, {
      id: 'key_alice',
      key: aliceApiKey,
      ownerHumanId: 'human_admin',
      createdAt: new Date().toISOString(),
    });
    server.apiKeys.set(bobApiKey, {
      id: 'key_bob',
      key: bobApiKey,
      ownerHumanId: 'human_admin',
      createdAt: new Date().toISOString(),
    });

    // Register agents
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({ id: agentAliceId, encPub: 'alice_enc_pub', signPub: 'alice_sign_pub', kid: 'kid_alice' }),
    });
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bobApiKey}` },
      body: JSON.stringify({ id: agentBobId, encPub: 'bob_enc_pub', signPub: 'bob_sign_pub', kid: 'kid_bob' }),
    });

    // Establish and approve link
    const linkRes = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ agentAId: agentAliceId, agentBId: agentBobId }),
    });
    const linkData = await linkRes.json();
    linkId = linkData.linkId;

    await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ force: true }),
    });
  });

  afterAll(async () => {
    await server.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('9.1 & 9.2: Acceptance is distinct from delivery, assign stable client msgId with idempotency', async () => {
    const msgId = 'msg_test_idempotent_001';
    const payload = { data: 'encrypted_payload_alpha', sig: 'sig_alpha', seq: 1 };

    // First send
    const res1 = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({ senderId: agentAliceId, payload, msgId }),
    });
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    // Must clearly report accepted, not delivered
    expect(data1.status).toBe('ok');
    expect(data1.state).toBe('accepted');
    expect(data1.accepted).toBe(true);
    expect(data1.delivered).toBe(false);
    expect(data1.msgId).toBe(msgId);
    expect(data1.duplicate).toBe(false);

    // Retry sending exact same envelope and msgId -> Idempotent success (no duplicate enqueue)
    const res2 = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({ senderId: agentAliceId, payload, msgId }),
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.status).toBe('ok');
    expect(data2.msgId).toBe(msgId);
    expect(data2.duplicate).toBe(true);

    // Queue count must still be exactly 1 message
    expect(server.messageSpool.getAvailableCount(agentBobId)).toBe(1);
  });

  it('9.2: Reusing existing msgId with conflicting payload is rejected with 409 Conflict', async () => {
    const msgId = 'msg_test_idempotent_001'; // Same msgId used above
    const conflictingPayload = { data: 'totally_different_conflicting_content', sig: 'sig_x', seq: 2 };

    const conflictRes = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({ senderId: agentAliceId, payload: conflictingPayload, msgId }),
    });

    expect(conflictRes.status).toBe(409);
    const body = await conflictRes.json();
    expect(body.error).toBe('idempotency_conflict');
    expect(body.message).toContain('Conflicting msgId reuse');
  });

  it('9.3: Durable Spool survives process/server restart without losing accepted messages', async () => {
    // Send a new unique message
    const durableMsgId = 'msg_durable_across_restarts';
    const durablePayload = { data: 'retained_after_kill', sig: 'sig_durable', seq: 2 };

    const sendRes = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({ senderId: agentAliceId, payload: durablePayload, msgId: durableMsgId }),
    });
    expect(sendRes.status).toBe(200);

    // Verify spool file exists on disk
    expect(fs.existsSync(spoolFile)).toBe(true);

    // Stop current server
    await server.close();

    // Spin up a new server instance pointing to the same DATA_PATH and SPOOL_PATH
    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;

    // Re-authenticate admin session after server restart
    const reloginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: server.adminPassword }),
    });
    const reloginData = await reloginRes.json();
    adminToken = reloginData.token;

    // Bob polls the new server instance -> durable messages survive!
    const pollRes = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=1000`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();

    expect(pollData.messages.length).toBeGreaterThanOrEqual(2);
    const found = pollData.messages.find((m: any) => m.msgId === durableMsgId);
    expect(found).toBeDefined();
    expect(found.payload.data).toBe('retained_after_kill');
    expect(pollData.leaseId).toBeTruthy();
  });

  it('9.4 & 9.5: Lease-based polling, at-least-once redelivery on timeout, and explicit recipient ACK', async () => {
    // Clean queue
    server.messageSpool.clear();

    const leaseMsgId = 'msg_lease_lifecycle_test';
    await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({
        senderId: agentAliceId,
        payload: { data: 'lease_test_data', sig: 'sig_lease', seq: 3 },
        msgId: leaseMsgId,
      }),
    });

    // 1. First poll leases the message with a short lease (simulate 200ms lease duration)
    const leaseRes = server.messageSpool.lease(agentBobId, 50, 200);
    expect(leaseRes.messages.length).toBe(1);
    expect(leaseRes.messages[0].msgId).toBe(leaseMsgId);
    expect(leaseRes.messages[0].state).toBe('in_flight');
    const firstLeaseId = leaseRes.leaseId;

    // While in flight, available count is 0
    expect(server.messageSpool.getAvailableCount(agentBobId)).toBe(0);

    // 2. Wait 250ms for lease to expire without ACK
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 3. Next poll re-leases the message (redelivery)
    const poll2Res = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=1000`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const poll2Data = await poll2Res.json();
    expect(poll2Data.messages.length).toBe(1);
    expect(poll2Data.messages[0].msgId).toBe(leaseMsgId);
    const newLeaseId = poll2Data.leaseId;
    expect(newLeaseId).not.toBe(firstLeaseId);

    // 4. Bob explicitly acknowledges receipt via POST /api/agents/:id/ack
    const ackRes = await fetch(`${baseUrl}/api/agents/${agentBobId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bobApiKey}` },
      body: JSON.stringify({ messageIds: [leaseMsgId], leaseId: newLeaseId }),
    });
    expect(ackRes.status).toBe(200);
    const ackData = await ackRes.json();
    expect(ackData.acknowledged).toContain(leaseMsgId);

    // 5. Subsequent poll yields no redelivery
    const poll3Res = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const poll3Data = await poll3Res.json();
    expect(poll3Data.messages.length).toBe(0);
  });

  it('9.5: Poison message rejection via NACK quarantines message without redelivery loop', async () => {
    const poisonMsgId = 'msg_poison_payload';
    await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({
        senderId: agentAliceId,
        payload: { data: 'corrupted_undecryptable_frame', sig: 'invalid_sig' },
        msgId: poisonMsgId,
      }),
    });

    // Poll message
    const pollRes = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=500`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const pollData = await pollRes.json();
    expect(pollData.messages.some((m: any) => m.msgId === poisonMsgId)).toBe(true);

    // Client rejects corrupted envelope via NACK with action 'reject'
    const nackRes = await fetch(`${baseUrl}/api/agents/${agentBobId}/nack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bobApiKey}` },
      body: JSON.stringify({ messageIds: [poisonMsgId], action: 'reject' }),
    });
    expect(nackRes.status).toBe(200);
    const nackData = await nackRes.json();
    expect(nackData.nacked).toContain(poisonMsgId);
    expect(nackData.action).toBe('reject');

    // Message is purged/quarantined and does NOT redeliver
    const checkPoll = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const checkData = await checkPoll.json();
    expect(checkData.messages.some((m: any) => m.msgId === poisonMsgId)).toBe(false);
  });

  it('9.6: Link revocation immediately purges pending and in-flight messages for that link', async () => {
    // Send message on active link
    const revokeMsgId = 'msg_to_be_revoked';
    await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceApiKey}` },
      body: JSON.stringify({
        senderId: agentAliceId,
        payload: { data: 'should_not_deliver_after_revoke' },
        msgId: revokeMsgId,
      }),
    });

    expect(server.messageSpool.getAvailableCount(agentBobId, linkId)).toBe(1);

    // Sever/revoke the link
    const deleteRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(deleteRes.status).toBe(200);

    // In-flight / pending messages for revoked link are purged
    expect(server.messageSpool.getAvailableCount(agentBobId, linkId)).toBe(0);

    // Polling receives zero messages from revoked link
    const pollRes = await fetch(`${baseUrl}/api/agents/${agentBobId}/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const pollData = await pollRes.json();
    expect(pollData.messages.some((m: any) => m.linkId === linkId)).toBe(false);
  });

  it('9.6: Backpressure handling rejects incoming messages when queue depth limit is exceeded', () => {
    // Test queue depth limit using an isolated spool instance with maxQueueDepth = 3
    const restrictedSpool = new MessageSpool({
      spoolFilePath: path.join(tempDir, 'restricted-spool.json'),
      maxQueueDepth: 3,
    });

    // Enqueue 3 messages (should succeed)
    restrictedSpool.enqueue({ linkId: 'link_bp', senderId: 'alice', targetId: 'charlie', payload: '1' });
    restrictedSpool.enqueue({ linkId: 'link_bp', senderId: 'alice', targetId: 'charlie', payload: '2' });
    restrictedSpool.enqueue({ linkId: 'link_bp', senderId: 'alice', targetId: 'charlie', payload: '3' });

    // 4th enqueue must throw 429
    let threw = false;
    try {
      restrictedSpool.enqueue({ linkId: 'link_bp', senderId: 'alice', targetId: 'charlie', payload: '4' });
    } catch (err: any) {
      threw = true;
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe('queue_full');
      expect(err.retryAfter).toBe(10);
    }
    expect(threw).toBe(true);
  });
});
