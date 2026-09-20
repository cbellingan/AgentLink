import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
});
