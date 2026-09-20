import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { WebSocket } from 'ws';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ADMIN_EMAIL = 'admin@test.local';

describe('Real-Time WebSocket Event Bus Test Suite', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let wsUrl: string;
  let tempDir: string;
  let adminToken: string;
  let apiKey: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-ws-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.BUG_LOG_PATH = path.join(tempDir, 'bugs.jsonl');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');

    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;

    // Authenticate admin session
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-auth-secret': 'test_sec_mesh_secret_2026',
      },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    });
    const authData = await authRes.json();
    adminToken = authData.token;

    // Create an API key
    const keyRes = await fetch(`${baseUrl}/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ label: 'WS Test Key' }),
    });
    const keyData = await keyRes.json();
    apiKey = keyData.apiKey.key;
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. Connects to /ws, registers supervisor, and responds to ping/pong', async () => {
    const ws = new WebSocket(wsUrl);

    const received: any[] = [];
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register_supervisor', token: adminToken }));
        ws.send(JSON.stringify({ type: 'ping' }));
      });
      ws.on('error', reject);

      const check = setInterval(() => {
        const hasRegistered = received.some(m => m.type === 'registered' && m.status === 'ok');
        const hasPong = received.some(m => m.type === 'pong');
        if (hasRegistered && hasPong) {
          clearInterval(check);
          ws.close();
          resolve();
        }
      }, 50);

      setTimeout(() => {
        clearInterval(check);
        ws.close();
        if (!received.some(m => m.type === 'registered')) {
          reject(new Error('Timeout waiting for supervisor registration ack'));
        } else {
          resolve();
        }
      }, 2000);
    });

    expect(received.some(m => m.type === 'registered')).toBe(true);
    expect(received.some(m => m.type === 'pong')).toBe(true);
  });

  it('2. Receives agent_registered event when an agent registers', async () => {
    const ws = new WebSocket(wsUrl);
    const received: any[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register_supervisor', token: adminToken }));
        setTimeout(resolve, 50);
      });
    });

    // Register agent
    const regRes = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        id: 'ws-agent-alpha',
        signPub: 'dGVzdFNpZ25QdWJBbHBoYTEyMzQ1Njc4OTAxMjM0NTY=',
        encPub: 'dGVzdEVuY1B1YkFscGhhMTIzNDU2Nzg5MDEyMzQ1Ng==',
        kid: 'kid-ws-alpha-001',
      }),
    });
    expect(regRes.status).toBe(200);

    // Wait for event on WS
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'agent_registered' && m.agent?.id === 'ws-agent-alpha');
        if (evt) {
          clearInterval(check);
          ws.close();
          resolve();
        }
      }, 30);

      setTimeout(() => {
        clearInterval(check);
        ws.close();
        reject(new Error(`Timeout waiting for agent_registered event. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });
  });

  it('3. Receives link_requested, link_approved, and link_revoked events', async () => {
    // Register agent beta
    await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        id: 'ws-agent-beta',
        signPub: 'dGVzdFNpZ25QdWJCZXRhMTIzNDU2Nzg5MDEyMzQ1Njc=',
        encPub: 'dGVzdEVuY1B1YkJldGExMjM0NTY3ODkwMTIzNDU2Nw==',
        kid: 'kid-ws-beta-002',
      }),
    });

    const ws = new WebSocket(wsUrl);
    const received: any[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register_supervisor', token: adminToken }));
        setTimeout(resolve, 50);
      });
    });

    // Step A: Request Link
    const reqRes = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        agentAId: 'ws-agent-alpha',
        agentBId: 'ws-agent-beta',
        note: 'WS Link Test',
      }),
    });
    expect(reqRes.status).toBe(200);
    const linkData = await reqRes.json();
    const linkId = linkData.linkId;

    // Verify link_requested event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'link_requested' && m.linkId === linkId);
        if (evt) {
          clearInterval(check);
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for link_requested. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });

    // Step B: Approve Link
    const appRes = await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        confirmedSafetyNumber: linkData.safetyNumber,
        force: true,
      }),
    });
    expect(appRes.status).toBe(200);

    // Verify link_approved event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'link_approved' && m.linkId === linkId);
        if (evt) {
          clearInterval(check);
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for link_approved. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });

    // Step C: Send Message across Link
    const sendRes = await fetch(`${baseUrl}/api/links/${linkId}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        senderId: 'ws-agent-alpha',
        payload: { v: 2, data: 'hello over websocket', iv: 'abc', tag: 'def' },
      }),
    });
    expect(sendRes.status).toBe(200);

    // Verify message_sent event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'message_sent' && m.linkId === linkId);
        if (evt) {
          clearInterval(check);
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for message_sent. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });

    // Step D: Revoke Link
    const delRes = await fetch(`${baseUrl}/api/links/${linkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);

    // Verify link_revoked event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'link_revoked' && m.linkId === linkId);
        if (evt) {
          clearInterval(check);
          ws.close();
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        ws.close();
        reject(new Error(`Timeout waiting for link_revoked. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });
  });

  it('4. Receives bug_reported and bug_resolved events', async () => {
    const ws = new WebSocket(wsUrl);
    const received: any[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register_supervisor', token: adminToken }));
        setTimeout(resolve, 50);
      });
    });

    // Submit a bug report
    const bugRes = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        title: 'WS Live Event Anomaly',
        details: 'Testing live bug event notification over WebSocket',
        severity: 'low',
        agentId: 'ws-agent-alpha',
      }),
    });
    expect(bugRes.status).toBe(201);
    const bugData = await bugRes.json();
    const bugId = bugData.bugId;

    // Verify bug_reported event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'bug_reported' && m.bugId === bugId);
        if (evt) {
          clearInterval(check);
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for bug_reported. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });

    // Resolve the bug
    const resolveRes = await fetch(`${baseUrl}/api/bugs/${bugId}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        resolved: true,
        note: 'Resolved live via test',
      }),
    });
    expect(resolveRes.status).toBe(200);

    // Verify bug_resolved event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const evt = received.find(m => m.type === 'bug_resolved' && m.bugId === bugId);
        if (evt) {
          clearInterval(check);
          ws.close();
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        ws.close();
        reject(new Error(`Timeout waiting for bug_resolved. Received: ${JSON.stringify(received)}`));
      }, 2000);
    });
  });

  it('5. Broadcasts to multiple clients and safely prunes dead sockets', async () => {
    const ws1 = new WebSocket(wsUrl);
    const ws2 = new WebSocket(wsUrl);
    const wsDead = new WebSocket(wsUrl);

    const received1: any[] = [];
    const received2: any[] = [];

    ws1.on('message', (d) => received1.push(JSON.parse(d.toString())));
    ws2.on('message', (d) => received2.push(JSON.parse(d.toString())));

    await Promise.all([
      new Promise<void>((res) => ws1.on('open', () => { ws1.send(JSON.stringify({ type: 'register_supervisor', token: adminToken })); res(); })),
      new Promise<void>((res) => ws2.on('open', () => { ws2.send(JSON.stringify({ type: 'register_supervisor', token: adminToken })); res(); })),
      new Promise<void>((res) => wsDead.on('open', () => { wsDead.send(JSON.stringify({ type: 'register_supervisor', token: adminToken })); res(); })),
    ]);

    // Forcefully destroy wsDead abruptly without standard handshake
    wsDead.terminate();
    await new Promise(r => setTimeout(r, 50));

    // Trigger an event
    server.notifySupervisors({ type: 'multi_client_test', payload: 'broadcast_123' });

    // Verify both live sockets receive the event
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const ok1 = received1.some(m => m.type === 'multi_client_test');
        const ok2 = received2.some(m => m.type === 'multi_client_test');
        if (ok1 && ok2) {
          clearInterval(check);
          ws1.close();
          ws2.close();
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(check);
        ws1.close();
        ws2.close();
        reject(new Error('Timeout waiting for multi-client broadcast'));
      }, 2000);
    });
  });
});
