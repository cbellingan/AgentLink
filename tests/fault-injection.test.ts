import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { AgentLinkServer } from '../server/agent-link-server.js';

describe('Feature 8.2: Fault Injection & Resilience Test Suite', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-fault-test-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('handles corrupt JSON state on startup safely without crash or bypass', async () => {
    const corruptStatePath = path.join(tmpDir, 'corrupt-state.json');
    fs.writeFileSync(corruptStatePath, '{"apiKeys": { INVALID JSON SYNTAX ...', 'utf8');

    const origDataPath = process.env.DATA_PATH;
    process.env.DATA_PATH = corruptStatePath;

    try {
      // Server must instantiate and load without throwing uncaught syntax errors
      const server = new AgentLinkServer(0);
      const port = await server.listen('127.0.0.1');

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/server-info`);
        expect(res.status).toBe(200);
        const info = await res.json();
        expect(info.name).toBeDefined();

        // Server state must remain clean/safe, not permissive
        expect(server.agents.size).toBe(0);
      } finally {
        await server.close();
      }
    } finally {
      if (origDataPath === undefined) {
        delete process.env.DATA_PATH;
      } else {
        process.env.DATA_PATH = origDataPath;
      }
    }
  });

  it('handles disk write failures in saveState safely without terminating process', async () => {
    const readOnlyDir = path.join(tmpDir, 'readonly-storage');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    const unwritablePath = path.join(readOnlyDir, 'state.json');

    // Create a directory where state.json would be so writeFileSync fails (EISDIR)
    fs.mkdirSync(unwritablePath, { recursive: true });

    const origDataPath = process.env.DATA_PATH;
    process.env.DATA_PATH = unwritablePath;

    try {
      const server = new AgentLinkServer(0);
      const port = await server.listen('127.0.0.1');

      try {
        // Attempt a mutating action that triggers saveState()
        // Register an agent using valid key
        server.apiKeys.set('sec_apk_test_fault', {
          key: 'sec_apk_test_fault',
          label: 'Test Fault Key',
          createdAt: Date.now(),
        });

        const regRes = await fetch(`http://127.0.0.1:${port}/api/agents/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sec_apk_test_fault',
          },
          body: JSON.stringify({
            agentId: 'agent-fault-test',
            signPub: 'test_sign_pub',
            encPub: 'test_enc_pub',
          }),
        });

        // Feature 10: A failed write produces a failure response rather than a false durable-acceptance claim
        expect(regRes.status).toBe(500);
        const errJson = await regRes.json();
        expect(errJson.error).toBe('persistence_error');

        // Verify server is still alive and handling requests despite write error
        const pingRes = await fetch(`http://127.0.0.1:${port}/api/server-info`);
        expect(pingRes.status).toBe(200);
      } finally {
        await server.close();
      }
    } finally {
      if (origDataPath === undefined) {
        delete process.env.DATA_PATH;
      } else {
        process.env.DATA_PATH = origDataPath;
      }
    }
  });

  it('rejects expired human operator sessions fail-closed', async () => {
    const server = new AgentLinkServer(0);
    const port = await server.listen('127.0.0.1');

    try {
      const expiredToken = 'sess_expired_12345';
      server.humanSessions.set(expiredToken, {
        email: 'operator@signetmesh.internal',
        name: 'Expired Operator',
        token: expiredToken,
        createdAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
      });

      const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        headers: { 'Authorization': `Bearer ${expiredToken}` },
      });

      // Must be rejected
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('purges in-flight message queue immediately upon link revocation and rejects subsequent sends', async () => {
    const server = new AgentLinkServer(0);
    const port = await server.listen('127.0.0.1');

    try {
      const linkId = 'link_revocation_test';
      const adminToken = 'sess_admin_revocation';
      server.humanSessions.set(adminToken, {
        email: 'admin@signetmesh.internal',
        name: 'Admin',
        token: adminToken,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      });

      server.agents.set('alice', {
        agentId: 'alice',
        signPub: 'pub_a',
        encPub: 'enc_a',
        kid: 'kid-alice-1',
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
        ownerEmail: 'admin@signetmesh.internal',
      });
      server.agents.set('bob', {
        agentId: 'bob',
        signPub: 'pub_b',
        encPub: 'enc_b',
        kid: 'kid-bob-1',
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
        ownerEmail: 'admin@signetmesh.internal',
      });

      server.apiKeys.set('sec_apk_alice', { key: 'sec_apk_alice', label: 'Alice Key', createdAt: Date.now() });

      // Establish link in approved state
      server.links.set(linkId, {
        linkId,
        agentA: 'alice',
        agentB: 'bob',
        status: 'approved',
        initiator: 'alice',
        approvals: { 'admin@signetmesh.internal': true },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Buffer an in-flight message for Bob
      server.messageQueues.set('bob', [
        {
          id: 'msg_pre_revocation',
          linkId,
          senderId: 'alice',
          recipientId: 'bob',
          data: 'buffered_secret_payload',
          timestamp: Date.now(),
        } as any,
      ]);

      expect(server.messageQueues.get('bob')?.length).toBe(1);

      // Unlink / Revoke link
      const unlinkRes = await fetch(`http://127.0.0.1:${port}/api/links/${linkId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      expect(unlinkRes.status).toBe(200);

      // Verify in-flight message for this link is purged from Bob's queue
      const bobQueue = server.messageQueues.get('bob') || [];
      const linkMessages = bobQueue.filter(m => m.linkId === linkId);
      expect(linkMessages.length).toBe(0);

      // Subsequent send across revoked link is rejected
      const sendRes = await fetch(`http://127.0.0.1:${port}/api/links/${linkId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_alice',
        },
        body: JSON.stringify({
          senderId: 'alice',
          recipientId: 'bob',
          data: 'new_attempt_after_revocation',
        }),
      });

      expect([403, 404]).toContain(sendRes.status);
    } finally {
      await server.close();
    }
  });

  it('handles truncated / prematurely closed HTTP streams gracefully without crashing', async () => {
    const server = new AgentLinkServer(0);
    const port = await server.listen('127.0.0.1');

    try {
      // Connect raw TCP client and send half of an HTTP request
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
          client.write('POST /api/agents/register HTTP/1.1\r\n');
          client.write('Host: 127.0.0.1\r\n');
          client.write('Content-Length: 500\r\n');
          client.write('Content-Type: application/json\r\n\r\n');
          client.write('{"truncated_json": true');
          // Abruptly terminate socket connection mid-transfer
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 50);
        });
        client.on('error', reject);
      });

      // Small delay to let Node server process socket termination
      await new Promise(r => setTimeout(r, 100));

      // Verify server remains completely responsive
      const checkRes = await fetch(`http://127.0.0.1:${port}/api/server-info`);
      expect(checkRes.status).toBe(200);
      const info = await checkRes.json();
      expect(info.version).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
