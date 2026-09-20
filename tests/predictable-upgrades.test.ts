import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AgentLinkServer } from '../server/agent-link-server.js';

describe('Feature 10: Predictable Upgrades, Persistence Failures & Graceful Shutdown', () => {
  let tmpDir: string;
  let server: AgentLinkServer | null = null;
  let port: number = 0;
  let baseUrl: string = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-upgrade-test-'));
    process.env.DATA_PATH = path.join(tmpDir, 'portal-state.json');
    process.env.SPOOL_PATH = path.join(tmpDir, 'message-spool.json');
  });

  afterEach(async () => {
    delete process.env.DATA_PATH;
    delete process.env.SPOOL_PATH;
    if (server) {
      await server.close();
      server = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('10.1: Propagates persistence errors as HTTP 500 persistence_error instead of false success', async () => {
    const readOnlyDir = path.join(tmpDir, 'readonly-storage');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    const unwritablePath = path.join(readOnlyDir, 'state.json');

    // Make state.json a directory to force EISDIR write failure
    fs.mkdirSync(unwritablePath, { recursive: true });

    const origDataPath = process.env.DATA_PATH;
    process.env.DATA_PATH = unwritablePath;

    try {
      server = new AgentLinkServer(0);
      port = await server.listen('127.0.0.1');
      baseUrl = `http://127.0.0.1:${port}`;

      server.apiKeys.set('sec_apk_test_persistence', {
        id: 'test_key',
        key: 'sec_apk_test_persistence',
        label: 'Test Key',
        ownerHumanId: 'human_admin',
        createdAt: new Date().toISOString(),
      });

      const regRes = await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_test_persistence',
        },
        body: JSON.stringify({
          agentId: 'agent-persist-fail',
          signPub: 'test_sign_pub',
          encPub: 'test_enc_pub',
        }),
      });

      expect(regRes.status).toBe(500);
      const regJson = await regRes.json();
      expect(regJson.error).toBe('persistence_error');
      expect(regJson.message).toContain('Failed to persist');
    } finally {
      if (origDataPath === undefined) {
        delete process.env.DATA_PATH;
      } else {
        process.env.DATA_PATH = origDataPath;
      }
    }
  });

  it('10.1: Data plane message forwarding does not trigger synchronous portal-state.json rewrite', async () => {
    const dataPath = path.join(tmpDir, 'portal-state.json');
    const spoolPath = path.join(tmpDir, 'messages-spool.json');
    process.env.DATA_PATH = dataPath;
    process.env.SPOOL_PATH = spoolPath;

    try {
      server = new AgentLinkServer(0);
      port = await server.listen('127.0.0.1');
      baseUrl = `http://127.0.0.1:${port}`;

      // Register key and agents
      server.apiKeys.set('sec_apk_test', {
        id: 'key1',
        key: 'sec_apk_test',
        label: 'Test Key',
        ownerHumanId: 'human_admin',
        createdAt: new Date().toISOString(),
      });
      server.agents.set('alice', {
        id: 'alice',
        ownerHumanId: 'human_admin',
        signPub: 'sign_a',
        encPub: 'enc_a',
        kid: 'kid_a',
        createdAt: new Date().toISOString(),
      });
      server.agents.set('bob', {
        id: 'bob',
        ownerHumanId: 'human_admin',
        signPub: 'sign_b',
        encPub: 'enc_b',
        kid: 'kid_b',
        createdAt: new Date().toISOString(),
      });
      (server as any).links.set('link_123', {
        id: 'link_123',
        agentAId: 'alice',
        agentBId: 'bob',
        status: 'active',
        initiatorHumanId: 'human_admin',
        responderHumanId: 'human_admin',
        approvals: { human_admin: true },
        createdAt: new Date().toISOString(),
      });

      // Save initial state to disk
      server.saveState();
      const stateMtimeBefore = fs.statSync(dataPath).mtimeMs;

      // Small delay to ensure timestamp difference if modified
      await new Promise(r => setTimeout(r, 50));

      // Send message
      const sendRes = await fetch(`${baseUrl}/api/links/link_123/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_test',
        },
        body: JSON.stringify({
          senderId: 'alice',
          payload: { text: 'high-throughput-message' },
          msgId: 'msg_decouple_1',
        }),
      });

      expect(sendRes.status).toBe(200);

      // Spool must be written to disk immediately
      expect(fs.existsSync(spoolPath)).toBe(true);

      // portal-state.json mtime should NOT have been synchronously updated during send
      const stateMtimeAfter = fs.statSync(dataPath).mtimeMs;
      expect(stateMtimeAfter).toBe(stateMtimeBefore);
    } finally {
      delete process.env.DATA_PATH;
      delete process.env.SPOOL_PATH;
    }
  });

  it('10.2: Graceful shutdown marks /health unready (503), rejects new mutations, and drains poll waiters', async () => {
    server = new AgentLinkServer(0);
    port = await server.listen('127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;

    server.apiKeys.set('sec_apk_test', {
      id: 'key1',
      key: 'sec_apk_test',
      label: 'Test Key',
      ownerHumanId: 'human_admin',
      createdAt: new Date().toISOString(),
    });
    server.agents.set('bob', {
      id: 'bob',
      ownerHumanId: 'human_admin',
      signPub: 'sign_b',
      encPub: 'enc_b',
      kid: 'kid_b',
      createdAt: new Date().toISOString(),
    });

    // 1. Initial health is 200 ready
    const h1 = await fetch(`${baseUrl}/health`);
    expect(h1.status).toBe(200);
    const h1Json = await h1.json();
    expect(h1Json.ready).toBe(true);

    // 2. Start a long-poll waiter in background
    let waiterCompleted = false;
    let waiterMessages: any = null;
    const pollPromise = fetch(`${baseUrl}/api/agents/bob/poll?timeout=10000`, {
      headers: { 'Authorization': 'Bearer sec_apk_test' },
    }).then(async res => {
      waiterCompleted = true;
      waiterMessages = await res.json();
    });

    // Let the poll request attach
    await new Promise(r => setTimeout(r, 100));
    expect(waiterCompleted).toBe(false);

    // 3. Initiate graceful shutdown
    server.initiateShutdown();

    // 4. Poll waiter must have been awakened cleanly
    await pollPromise;
    expect(waiterCompleted).toBe(true);
    expect(waiterMessages.messages).toEqual([]);

    // 5. /health must now return 503 shutting_down
    const h2 = await fetch(`${baseUrl}/health`);
    expect(h2.status).toBe(503);
    const h2Json = await h2.json();
    expect(h2Json.ready).toBe(false);
    expect(h2Json.status).toBe('shutting_down');

    // 6. Mutating requests return 503 server_shutting_down with Retry-After header
    const postRes = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sec_apk_test',
      },
      body: JSON.stringify({ agentId: 'test-shutting' }),
    });
    expect(postRes.status).toBe(503);
    expect(postRes.headers.get('retry-after')).toBe('1');
    const postJson = await postRes.json();
    expect(postJson.error).toBe('server_shutting_down');

    await server.gracefulShutdown(500);
    server = null;
  });

  it('10.2 & 10.4: Leased in-flight messages are released on graceful shutdown and recovered immediately on successor server', async () => {
    const stateDir = path.join(tmpDir, 'shared-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const spoolPath = path.join(stateDir, 'messages-spool.json');
    const dataPath = path.join(stateDir, 'portal-state.json');

    process.env.DATA_PATH = dataPath;
    process.env.SPOOL_PATH = spoolPath;

    try {
      // Step 1: Start initial server (v1)
      const server1 = new AgentLinkServer(0);
      const port1 = await server1.listen('127.0.0.1');

      server1.apiKeys.set('sec_apk_test', {
        id: 'key1',
        key: 'sec_apk_test',
        label: 'Test Key',
        ownerHumanId: 'human_admin',
        createdAt: new Date().toISOString(),
      });
      server1.agents.set('alice', {
        id: 'alice',
        ownerHumanId: 'human_admin',
        signPub: 'sign_a',
        encPub: 'enc_a',
        kid: 'kid_a',
        createdAt: new Date().toISOString(),
      });
      server1.agents.set('bob', {
        id: 'bob',
        ownerHumanId: 'human_admin',
        signPub: 'sign_b',
        encPub: 'enc_b',
        kid: 'kid_b',
        createdAt: new Date().toISOString(),
      });
      (server1 as any).links.set('link_1', {
        id: 'link_1',
        agentAId: 'alice',
        agentBId: 'bob',
        status: 'active',
        initiatorHumanId: 'human_admin',
        responderHumanId: 'human_admin',
        approvals: { human_admin: true },
        createdAt: new Date().toISOString(),
      });

      // Save control-plane state
      server1.saveState();

      // Alice sends a message
      const sendRes = await fetch(`http://127.0.0.1:${port1}/api/links/link_1/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_test',
        },
        body: JSON.stringify({
          senderId: 'alice',
          payload: 'critical-payload-surviving-upgrade',
          msgId: 'msg_upgrade_001',
        }),
      });
      expect(sendRes.status).toBe(200);

      // Bob polls and acquires a 30s lease
      const pollRes = await fetch(`http://127.0.0.1:${port1}/api/agents/bob/poll?timeout=1000`, {
        headers: { 'Authorization': 'Bearer sec_apk_test' },
      });
      const pollJson = await pollRes.json();
      expect(pollJson.messages.length).toBe(1);
      expect(pollJson.messages[0].msgId).toBe('msg_upgrade_001');
      expect(pollJson.leaseId).toBeDefined();

      // Message is currently 'in_flight' under lease
      const spoolMetrics1 = server1.messageSpool.getMetrics();
      expect(spoolMetrics1.inFlightCount).toBe(1);
      expect(spoolMetrics1.availableCount).toBe(0);

      // Step 2: Gracefully shutdown server1 (releases leases back to available)
      await server1.gracefulShutdown(2000);

      // Step 3: Successor server (v2) starts immediately using the same storage
      const server2 = new AgentLinkServer(0);
      const port2 = await server2.listen('127.0.0.1');

      // Successor server loads spool: message must be immediately 'available', NOT trapped in an expired lease wait
      const spoolMetrics2 = server2.messageSpool.getMetrics();
      expect(spoolMetrics2.availableCount).toBe(1);
      expect(spoolMetrics2.inFlightCount).toBe(0);

      // Bob polls server2 immediately: gets the message without waiting 30 seconds!
      const poll2Res = await fetch(`http://127.0.0.1:${port2}/api/agents/bob/poll?timeout=1000`, {
        headers: { 'Authorization': 'Bearer sec_apk_test' },
      });
      const poll2Json = await poll2Res.json();
      expect(poll2Json.messages.length).toBe(1);
      expect(poll2Json.messages[0].msgId).toBe('msg_upgrade_001');

      // Bob acknowledges on server2
      const ackRes = await fetch(`http://127.0.0.1:${port2}/api/agents/bob/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_test',
        },
        body: JSON.stringify({
          messageIds: ['msg_upgrade_001'],
          leaseId: poll2Json.leaseId,
        }),
      });
      expect(ackRes.status).toBe(200);

      await server2.close();
    } finally {
      delete process.env.DATA_PATH;
      delete process.env.SPOOL_PATH;
    }
  });

  it('10.5: Operational metrics accurately track accepted, delivered, active leases, and rejections', async () => {
    server = new AgentLinkServer(0);
    port = await server.listen('127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;

    server.apiKeys.set('sec_apk_test', {
      id: 'key1',
      key: 'sec_apk_test',
      label: 'Test Key',
      ownerHumanId: 'human_admin',
      createdAt: new Date().toISOString(),
    });
    server.agents.set('alice', {
      id: 'alice',
      ownerHumanId: 'human_admin',
      signPub: 'sign_a',
      encPub: 'enc_a',
      kid: 'kid_a',
      createdAt: new Date().toISOString(),
    });
    server.agents.set('bob', {
      id: 'bob',
      ownerHumanId: 'human_admin',
      signPub: 'sign_b',
      encPub: 'enc_b',
      kid: 'kid_b',
      createdAt: new Date().toISOString(),
    });
    (server as any).links.set('link_metrics', {
      id: 'link_metrics',
      agentAId: 'alice',
      agentBId: 'bob',
      status: 'active',
      initiatorHumanId: 'human_admin',
      responderHumanId: 'human_admin',
      approvals: { human_admin: true },
      createdAt: new Date().toISOString(),
    });

    // 1. Check initial metrics
    const m1Res = await fetch(`${baseUrl}/api/metrics`);
    expect(m1Res.status).toBe(200);
    const m1 = await m1Res.json();
    expect(m1.metrics.messagesAccepted).toBe(0);
    expect(m1.metrics.messagesDelivered).toBe(0);
    expect(m1.metrics.rejections).toBe(0);

    // 2. Trigger a rejection (e.g. 401 unauthorized)
    await fetch(`${baseUrl}/api/keys`);
    const m2Res = await fetch(`${baseUrl}/api/metrics`);
    const m2 = await m2Res.json();
    expect(m2.metrics.rejections).toBeGreaterThanOrEqual(1);

    // 3. Send 2 messages
    await fetch(`${baseUrl}/api/links/link_metrics/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sec_apk_test',
      },
      body: JSON.stringify({ senderId: 'alice', payload: 'm1', msgId: 'msg_m1' }),
    });
    await fetch(`${baseUrl}/api/links/link_metrics/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sec_apk_test',
      },
      body: JSON.stringify({ senderId: 'alice', payload: 'm2', msgId: 'msg_m2' }),
    });

    const m3Res = await fetch(`${baseUrl}/api/metrics`);
    const m3 = await m3Res.json();
    expect(m3.metrics.messagesAccepted).toBe(2);
    expect(m3.metrics.queueDepth).toBe(2);
    expect(m3.metrics.activeLeases).toBe(0);

    // 4. Poll and lease messages
    const pollRes = await fetch(`${baseUrl}/api/agents/bob/poll?timeout=1000`, {
      headers: { 'Authorization': 'Bearer sec_apk_test' },
    });
    const pollJson = await pollRes.json();
    expect(pollJson.messages.length).toBe(2);

    const m4Res = await fetch(`${baseUrl}/api/metrics`);
    const m4 = await m4Res.json();
    expect(m4.metrics.activeLeases).toBe(2);
    expect(m4.metrics.queueDepth).toBe(0);

    // 5. Acknowledge 1 message
    await fetch(`${baseUrl}/api/agents/bob/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sec_apk_test',
      },
      body: JSON.stringify({ messageIds: ['msg_m1'], leaseId: pollJson.leaseId }),
    });

    const m5Res = await fetch(`${baseUrl}/api/metrics`);
    const m5 = await m5Res.json();
    expect(m5.metrics.messagesDelivered).toBe(1);
    expect(m5.metrics.activeLeases).toBe(1);

    // Verify /api/server-info also includes metrics summary
    const infoRes = await fetch(`${baseUrl}/api/server-info`);
    const infoJson = await infoRes.json();
    expect(infoJson.ready).toBe(true);
    expect(infoJson.metrics.messagesAccepted).toBe(2);
    expect(infoJson.metrics.messagesDelivered).toBe(1);
  });
});
