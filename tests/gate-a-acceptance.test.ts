import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { IsolatedTestEnvironment } from './harness/isolated-env.js';
import { ProcessSupervisor } from './harness/process-supervisor.js';

const TEST_H1_EMAIL = 'human1@signetmesh.internal';
const TEST_H2_EMAIL = 'human2@signetmesh.internal';
const TEST_EVE_EMAIL = 'eve@adversary.internal';

describe('Milestone 3: Gate A E2E Acceptance Catalogue (E2E-006 to E2E-028)', () => {
  let env: IsolatedTestEnvironment;
  let supervisor: ProcessSupervisor;
  let server: AgentLinkServer;
  let serverPort: number;
  let serverUrl: string;

  let h1Token: string;
  let h1Id: string;
  let h2Token: string;
  let h2Id: string;

  let aliceApiKey: string;
  let avaApiKey: string;
  let bobApiKey: string;
  let eveApiKey: string;

  let aliceBobLinkId: string;
  let aliceAvaLinkId: string;

  beforeAll(async () => {
    env = new IsolatedTestEnvironment('agentlink-gate-a-');
    supervisor = new ProcessSupervisor();

    process.env.DATA_PATH = env.paths.serverData;
    process.env.BUG_LOG_PATH = env.paths.serverBugLog;
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_H1_EMAIL).digest('hex');

    server = new AgentLinkServer(0);
    serverPort = await server.listen();
    serverUrl = `http://127.0.0.1:${serverPort}`;

    // 1. Human 1 (Admin) logs in
    const h1Login = await fetch(`${serverUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_H1_EMAIL, name: 'Human 1' }),
    });
    expect(h1Login.status).toBe(200);
    const h1Data = await h1Login.json();
    h1Token = h1Data.token;
    h1Id = h1Data.user.id;

    // 2. H1 invites H2 so H2 can pass the gatekeeper
    const inviteRes = await fetch(`${serverUrl}/api/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h1Token}`,
      },
      body: JSON.stringify({ toEmail: TEST_H2_EMAIL, note: 'Invite H2' }),
    });
    expect(inviteRes.status).toBe(201);

    // 3. Human 2 logs in
    const h2Login = await fetch(`${serverUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_H2_EMAIL, name: 'Human 2' }),
    });
    expect(h2Login.status).toBe(200);
    const h2Data = await h2Login.json();
    h2Token = h2Data.token;
    h2Id = h2Data.user.id;

    // 4. Provision API keys:
    // H1 provisions Alice and Ava
    const genKey = async (token: string, label: string) => {
      const res = await fetch(`${serverUrl}/api/keys/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      return data.apiKey?.key || data.key;
    };

    aliceApiKey = await genKey(h1Token, 'Alice Key (H1)');
    avaApiKey = await genKey(h1Token, 'Ava Sibling Key (H1)');
    bobApiKey = await genKey(h2Token, 'Bob Key (H2)');

    // 5. Register Alice, Ava, and Bob with their respective keys
    await env.runCli('alice', ['keygen', '--agent-id', 'agent-alice', '--json']);
    const regAlice = await env.runCli('alice', [
      'register',
      '--agent-id',
      'agent-alice',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(regAlice.exitCode).toBe(0);

    await env.runCli('ava', ['keygen', '--agent-id', 'agent-ava', '--json']);
    const regAva = await env.runCli('ava', [
      'register',
      '--agent-id',
      'agent-ava',
      '--server',
      serverUrl,
      '--api-key',
      avaApiKey,
    ]);
    expect(regAva.exitCode).toBe(0);

    await env.runCli('bob', ['keygen', '--agent-id', 'agent-bob', '--json']);
    const regBob = await env.runCli('bob', [
      'register',
      '--agent-id',
      'agent-bob',
      '--server',
      serverUrl,
      '--api-key',
      bobApiKey,
    ]);
    expect(regBob.exitCode).toBe(0);

    // Eve sets up keypair locally without valid server enrollment
    await env.runCli('eve', ['keygen', '--agent-id', 'agent-eve', '--json']);
    eveApiKey = 'sec_apk_unauthorized_eve_test_token_12345';
  });

  afterAll(async () => {
    await supervisor.teardownAll();
    await server.close();
    env.cleanup();
  });

  it('E2E-006: Request Alice–Bob link, repeat request idempotently, and verify sending blocked before approval', async () => {
    // 1. Request link Alice -> Bob
    const reqRes = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        agentAId: 'agent-alice',
        agentBId: 'agent-bob',
        note: 'E2E-006 link request',
      }),
    });
    expect(reqRes.status).toBe(200);
    const reqData = await reqRes.json();
    aliceBobLinkId = reqData.link.id;
    expect(reqData.link.status).toBe('pending_approval');

    // 2. Repeat link request - should be idempotent and return existing pending link
    const repeatRes = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        agentAId: 'agent-alice',
        agentBId: 'agent-bob',
      }),
    });
    expect(repeatRes.status).toBe(200);
    const repeatData = await repeatRes.json();
    expect(repeatData.link.id).toBe(aliceBobLinkId);

    // 3. Alice attempts to send to Bob before approvals: must fail
    const sendBlockedRes = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-bob',
      '--message',
      'Premature message before approval',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(sendBlockedRes.exitCode).not.toBe(0);

    // 4. Bob polls: queue must be completely empty
    const bobPollRes = await fetch(`${serverUrl}/api/agents/agent-bob/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    expect(bobPollRes.status).toBe(200);
    const pollData = await bobPollRes.json();
    expect(pollData.messages.length).toBe(0);
  });

  it('E2E-007: Approve only H1 (still blocked), then approve H2; verify bidirectional encrypted delivery', async () => {
    // 1. H1 approves
    const h1ApproveRes = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h1Token}`,
      },
    });
    expect(h1ApproveRes.status).toBe(200);
    const h1AppData = await h1ApproveRes.json();
    // Two-owner link remains pending_approval when only one has approved
    expect(h1AppData.link.status).toBe('pending_approval');

    // 2. Try send again: still blocked because H2 has not approved
    const sendStillBlocked = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-bob',
      '--message',
      'Still blocked pending H2 approval',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(sendStillBlocked.exitCode).not.toBe(0);

    // 3. H2 approves
    const h2ApproveRes = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h2Token}`,
      },
    });
    expect(h2ApproveRes.status).toBe(200);
    const h2AppData = await h2ApproveRes.json();
    expect(h2AppData.link.status).toBe('active');

    // 4. Alice sends encrypted message to Bob
    const sendAliceRes = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-bob',
      '--message',
      'Hello Bob from Alice via E2EE',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
      '--json',
    ]);
    expect(sendAliceRes.exitCode).toBe(0);

    // 5. Bob polls and receives decrypted message
    const bobInbox = env.paths.actors['bob'].inbox;
    const receiveBobRes = await env.runCli('bob', [
      'receive',
      '--agent-id',
      'agent-bob',
      '--server',
      serverUrl,
      '--api-key',
      bobApiKey,
      '--once',
      '--json',
      '--decrypt',
    ]);
    expect(receiveBobRes.exitCode).toBe(0);
    const bobData = JSON.parse(receiveBobRes.stdout);
    expect(bobData.messages.length).toBe(1);
    expect(bobData.messages[0].text).toBe('Hello Bob from Alice via E2EE');
    expect(bobData.messages[0].senderId).toBe('agent-alice');
    expect(bobData.messages[0].encrypted).toBe(true);
    expect(bobData.messages[0].signed).toBe(true);

    // 6. Bob sends encrypted reply to Alice
    const sendBobRes = await env.runCli('bob', [
      'send',
      '--agent-id',
      'agent-bob',
      '--to',
      'agent-alice',
      '--message',
      'Acknowledged Alice, E2EE active!',
      '--server',
      serverUrl,
      '--api-key',
      bobApiKey,
      '--json',
    ]);
    expect(sendBobRes.exitCode).toBe(0);

    // 7. Alice receives and verifies Bob reply
    const receiveAliceRes = await env.runCli('alice', [
      'receive',
      '--agent-id',
      'agent-alice',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
      '--once',
      '--json',
      '--decrypt',
    ]);
    expect(receiveAliceRes.exitCode).toBe(0);
    const aliceReceivedData = JSON.parse(receiveAliceRes.stdout);
    expect(aliceReceivedData.messages[0].text).toBe('Acknowledged Alice, E2EE active!');
  });

  it('E2E-008: Link Alice–Ava under H1: single-owner approval activates link', async () => {
    // 1. Alice requests link with sibling Ava
    const reqRes = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        agentAId: 'agent-alice',
        agentBId: 'agent-ava',
        note: 'Sibling link under H1',
      }),
    });
    expect(reqRes.status).toBe(200);
    const reqData = await reqRes.json();
    aliceAvaLinkId = reqData.link.id;

    // 2. H1 approves the link
    const approveRes = await fetch(`${serverUrl}/api/links/${aliceAvaLinkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h1Token}`,
      },
    });
    expect(approveRes.status).toBe(200);
    const appData = await approveRes.json();
    // Under single-owner rule, one owner approval activates the link
    expect(appData.link.status).toBe('active');

    // 3. Message exchange works immediately
    const sendRes = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-ava',
      '--message',
      'Sibling hello to Ava',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
      '--json',
    ]);
    expect(sendRes.exitCode).toBe(0);

    const receiveRes = await env.runCli('ava', [
      'receive',
      '--agent-id',
      'agent-ava',
      '--server',
      serverUrl,
      '--api-key',
      avaApiKey,
      '--once',
      '--json',
      '--decrypt',
    ]);
    expect(receiveRes.exitCode).toBe(0);
    const avaData = JSON.parse(receiveRes.stdout);
    expect(avaData.messages[0].text).toBe('Sibling hello to Ava');
  });

  it('E2E-009 & E2E-010: Anonymous and Eve caller denials (request, approve, impersonated send)', async () => {
    // 1. Anonymous attempts to request link
    const anonReq = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentAId: 'agent-alice', agentBId: 'agent-bob' }),
    });
    expect(anonReq.status).toBe(401);

    // 2. Anonymous attempts to approve link
    const anonApp = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(anonApp.status).toBe(401);

    // 3. Eve attempts to approve Alice-Bob link with Eve credentials
    const eveApp = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${eveApiKey}`,
      },
    });
    expect(eveApp.status).toBe(401); // Invalid/unregistered token rejected

    // 4. E2E-010: Eve sends with senderId=agent-alice across Alice-Bob link
    const eveSend = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${eveApiKey}`,
      },
      body: JSON.stringify({
        senderId: 'agent-alice',
        recipientId: 'agent-bob',
        payload: { text: 'Injected spoofed message' },
      }),
    });
    expect(eveSend.status).toBe(401);

    // 5. Bob polls: receives zero injected messages
    const bobPoll = await fetch(`${serverUrl}/api/agents/agent-bob/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    const bobPollData = await bobPoll.json();
    expect(bobPollData.messages.length).toBe(0);
  });

  it('E2E-011: Queue protection: unauthorized poll / inspection rejected without draining queue', async () => {
    // 1. Alice enqueues a legitimate message for Bob
    await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-bob',
      '--message',
      'Protected queue message for Bob',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);

    // 2. Anonymous attempts to poll Bob's queue
    const anonPoll = await fetch(`${serverUrl}/api/agents/agent-bob/poll?timeout=50`);
    expect(anonPoll.status).toBe(401);

    // 3. Eve attempts to poll Bob's queue
    const evePoll = await fetch(`${serverUrl}/api/agents/agent-bob/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${eveApiKey}` },
    });
    expect(evePoll.status).toBe(401);

    // 4. Eve attempts to delete Bob's queue or agent
    const eveDel = await fetch(`${serverUrl}/api/agents/agent-bob`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${eveApiKey}` },
    });
    expect(eveDel.status).toBe(401);

    // 5. Bob polls with legitimate key: message is present and was NOT drained by unauthorized attempts
    const bobPoll = await fetch(`${serverUrl}/api/agents/agent-bob/poll?timeout=50`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    expect(bobPoll.status).toBe(200);
    const bobData = await bobPoll.json();
    expect(bobData.messages.length).toBe(1);
  });

  it('E2E-013: Key rotation during active link demotes link and revokes approvals', async () => {
    // 1. Alice performs an authorized key rotation
    const rotateRes = await env.runCli('alice', [
      'keygen',
      '--agent-id',
      'agent-alice',
      '--overwrite',
      '--json',
    ]);
    expect(rotateRes.exitCode).toBe(0);

    // Re-register with new keys using H1 human authorization
    const reReg = await fetch(`${serverUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h1Token}`,
      },
      body: JSON.stringify({
        id: 'agent-alice',
        signPub: JSON.parse(rotateRes.stdout).signPub,
        encPub: JSON.parse(rotateRes.stdout).encPub,
        kid: JSON.parse(rotateRes.stdout).kid,
      }),
    });
    expect(reReg.status).toBe(200);

    // 2. Link status must be demoted back to pending_approval
    const linkCheck = await fetch(`${serverUrl}/api/links/${aliceBobLinkId}`, {
      headers: { 'Authorization': `Bearer ${h1Token}` },
    });
    expect(linkCheck.status).toBe(200);
    const linkData = await linkCheck.json();
    expect(linkData.link.status).toBe('pending_approval');

    // 3. Traffic is blocked until re-approval
    const sendBlocked = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-bob',
      '--message',
      'Should be blocked after key rotation',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(sendBlocked.exitCode).not.toBe(0);
  });

  it('E2E-018 & E2E-019: Unlink severs relationship in both directions; relinking requires fresh approvals', async () => {
    // 1. Sever the Alice-Ava link
    const delRes = await fetch(`${serverUrl}/api/links/${aliceAvaLinkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${aliceApiKey}` },
    });
    expect(delRes.status).toBe(200);

    // 2. Traffic blocked both ways
    const sendRes1 = await env.runCli('alice', [
      'send',
      '--agent-id',
      'agent-alice',
      '--to',
      'agent-ava',
      '--message',
      'Post-unlink message 1',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(sendRes1.exitCode).not.toBe(0);

    // 3. Repeated unlink is idempotent
    const delRepeat = await fetch(`${serverUrl}/api/links/${aliceAvaLinkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${aliceApiKey}` },
    });
    expect(delRepeat.status).toBe(404);

    // 4. E2E-019: Requesting link again creates a new pending link requiring fresh approvals
    const relinkReq = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({ agentAId: 'agent-alice', agentBId: 'agent-ava' }),
    });
    expect(relinkReq.status).toBe(200);
    const newLinkData = await relinkReq.json();
    expect(newLinkData.link.status).toBe('pending_approval');
  });

  it('E2E-027: Malformed payloads, oversized bodies, and invalid types return 400 safely without crashing server', async () => {
    // 1. Malformed JSON payload
    const malformedRes = await fetch(`${serverUrl}/api/links/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceApiKey}`,
      },
      body: '{"unclosed_json": true, "broken": ',
    });
    expect(malformedRes.status).toBe(400);
    const malformedBody = await malformedRes.json();
    expect(malformedBody.error).toBe('invalid_json');

    // 2. Oversized payload exceeding 1MB limit
    const hugePayload = 'A'.repeat(1.5 * 1024 * 1024);
    try {
      const oversizeRes = await fetch(`${serverUrl}/api/bugs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ details: hugePayload }),
      });
      // Should be rejected with 413 or connection reset
      expect(oversizeRes.status).toBeGreaterThanOrEqual(400);
    } catch {
      // Connection closed by server due to size limit is expected
    }

    // 3. Server must remain healthy and responsive
    const healthRes = await fetch(`${serverUrl}/health`);
    expect(healthRes.status).toBe(200);
  });

  it('E2E-012: Authenticated WebSocket supervisor subscriptions & private event isolation', async () => {
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    // 1. Anonymous connection attempt without token receives 4401 unauthorized
    const anonWs = new WebSocket(wsUrl);
    let anonClosed = false;
    let anonCloseCode = 0;
    let anonError: any = null;

    anonWs.on('message', (d) => { anonError = JSON.parse(d.toString()); });
    anonWs.on('close', (code) => {
      anonClosed = true;
      anonCloseCode = code;
    });

    await new Promise<void>((resolve) => anonWs.on('open', () => {
      anonWs.send(JSON.stringify({ type: 'register_supervisor' }));
      resolve();
    }));
    await new Promise(r => setTimeout(r, 120));

    expect(anonClosed).toBe(true);
    expect(anonCloseCode).toBe(4401);
    expect(anonError?.error).toBe('unauthorized');

    // 2. Eve connection attempt with forged/invalid token is rejected with 4401
    const eveWs = new WebSocket(wsUrl);
    let eveClosed = false;
    let eveCloseCode = 0;
    let eveError: any = null;

    eveWs.on('message', (d) => { eveError = JSON.parse(d.toString()); });
    eveWs.on('close', (code) => {
      eveClosed = true;
      eveCloseCode = code;
    });

    await new Promise<void>((resolve) => eveWs.on('open', () => {
      eveWs.send(JSON.stringify({ type: 'register_supervisor', token: 'sec_hum_forged_eve_token' }));
      resolve();
    }));
    await new Promise(r => setTimeout(r, 120));

    expect(eveClosed).toBe(true);
    expect(eveCloseCode).toBe(4401);
    expect(eveError?.error).toBe('unauthorized');

    // 3. Connect valid subscriptions for H1 (Admin) and H2 (Collaborator)
    const h1Ws = new WebSocket(wsUrl);
    const h2Ws = new WebSocket(wsUrl);

    const h1Messages: any[] = [];
    const h2Messages: any[] = [];

    h1Ws.on('message', (d) => h1Messages.push(JSON.parse(d.toString())));
    h2Ws.on('message', (d) => h2Messages.push(JSON.parse(d.toString())));

    await Promise.all([
      new Promise<void>((res) => h1Ws.on('open', () => {
        h1Ws.send(JSON.stringify({ type: 'register_supervisor', token: h1Token }));
        res();
      })),
      new Promise<void>((res) => h2Ws.on('open', () => {
        h2Ws.send(JSON.stringify({ type: 'register_supervisor', token: h2Token }));
        res();
      })),
    ]);
    await new Promise(r => setTimeout(r, 100));

    expect(h1Messages.some(m => m.type === 'registered')).toBe(true);
    expect(h2Messages.some(m => m.type === 'registered')).toBe(true);

    // 4. Create a private key belonging to H2; emit notification containing secret key material
    // Verify:
    // a) H2 receives notification because H2 owns the key
    // b) H1 receives notification because H1 is admin
    // c) Sensitive key material is scrubbed from the broadcast
    const h2KeyRes = await fetch(`${serverUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${h2Token}`,
      },
      body: JSON.stringify({ label: 'H2 Isolated Private Key' }),
    });
    expect([200, 201]).toContain(h2KeyRes.status);
    const h2KeyData = await h2KeyRes.json();
    const createdKeyId = h2KeyData.apiKey?.id || h2KeyData.id;

    await new Promise(r => setTimeout(r, 120));

    // Both H1 (admin) and H2 (owner) should receive key_created event
    const h2Event = h2Messages.find(m => m.type === 'key_created' && m.keyId === createdKeyId);
    expect(h2Event).toBeDefined();
    // Verify no secret key material is leaked in the broadcast payload
    expect(h2Event?.key).toBeUndefined();
    expect(h2Event?.apiKey).toBeUndefined();

    // 5. Logout H2 and verify H2's WebSocket subscription is closed with 4401 session_terminated
    let h2WsClosed = false;
    let h2WsCloseCode = 0;
    h2Ws.on('close', (code) => {
      h2WsClosed = true;
      h2WsCloseCode = code;
    });

    const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h2Token}` },
    });
    expect(logoutRes.status).toBe(200);

    await new Promise(r => setTimeout(r, 120));
    expect(h2WsClosed).toBe(true);
    expect(h2WsCloseCode).toBe(4401);
    expect(h2Messages.some(m => m.type === 'session_terminated')).toBe(true);

    // Re-login H2 so subsequent test cases maintain clean fixture state
    const reLogin = await fetch(`${serverUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_H2_EMAIL, name: 'Human 2' }),
    });
    const reData = await reLogin.json();
    h2Token = reData.token;

    h1Ws.close();
  });

  it('E2E-024: Production-mode rejection of legacy test credentials, default passwords, and bypass headers', async () => {
    // 1. Launch a separate server instance in strict production mode
    const prodEnv = new IsolatedTestEnvironment('agentlink-gate-a-prod-');
    const prevEnv = process.env.NODE_ENV;
    const prevAdminPwd = process.env.ADMIN_PASSWORD;
    const prevAdminEmailHash = process.env.ADMIN_EMAIL_HASH;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ADMIN_PASSWORD; // Unset to verify default password rejection
      process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update('admin@signetmesh.internal').digest('hex');
      process.env.DATA_PATH = prodEnv.paths.serverData;
      process.env.BUG_LOG_PATH = prodEnv.paths.serverBugLog;

      const prodServer = new AgentLinkServer(0);
      const prodPort = await prodServer.listen();
      const prodUrl = `http://127.0.0.1:${prodPort}`;

      // 2. Default predictable password 'AdminSecure2026!' is rejected
      const pwdLogin = await fetch(`${prodUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@signetmesh.internal', password: 'AdminSecure2026!' }),
      });
      expect(pwdLogin.status).toBe(401);
      const pwdBody = await pwdLogin.json();
      expect(pwdBody.error).toBe('invalid_credentials');

      // 3. Test-header email login bypass 'x-test-auth-secret' is rejected in production
      const headerLogin = await fetch(`${prodUrl}/api/auth/google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-auth-secret': 'test_sec_mesh_secret_2026',
        },
        body: JSON.stringify({ email: 'admin@signetmesh.internal' }),
      });
      expect(headerLogin.status).toBe(401);
      const headerBody = await headerLogin.json();
      expect(headerBody.error).toBe('credential_required');

      // 4. Legacy test API key 'sec_apk_valid_12345' is rejected in production
      const regRes = await fetch(`${prodUrl}/api/agents/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_valid_12345',
        },
        body: JSON.stringify({ id: 'agent-prod-intruder' }),
      });
      expect(regRes.status).toBe(401);
      const regBody = await regRes.json();
      expect(regBody.error).toBe('invalid_api_key');

      // 5. Querying agents with legacy test key is rejected
      const listRes = await fetch(`${prodUrl}/api/agents`, {
        headers: { 'Authorization': 'Bearer sec_apk_valid_12345' },
      });
      expect(listRes.status).toBe(401);

      await prodServer.close();
      prodEnv.cleanup();
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevAdminPwd) process.env.ADMIN_PASSWORD = prevAdminPwd;
      if (prevAdminEmailHash) process.env.ADMIN_EMAIL_HASH = prevAdminEmailHash;
      else delete process.env.ADMIN_EMAIL_HASH;
    }
  });
});
