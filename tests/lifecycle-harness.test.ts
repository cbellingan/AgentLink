import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { IsolatedTestEnvironment } from './harness/isolated-env.js';
import { ProcessSupervisor } from './harness/process-supervisor.js';
import { FaultProxy } from './harness/fault-proxy.js';

const TEST_ADMIN_EMAIL = 'admin@signetmesh.internal';

describe('Milestone 1: Isolated Lifecycle and Failure-Injection Test Harness', () => {
  let isolatedEnv: IsolatedTestEnvironment;
  let supervisor: ProcessSupervisor;
  let server: AgentLinkServer;
  let serverPort: number;
  let serverUrl: string;
  let faultProxy: FaultProxy;
  let proxyPort: number;
  let proxyUrl: string;

  let adminToken: string;
  let aliceApiKey: string;
  let bobApiKey: string;
  let eveApiKey: string;

  beforeAll(async () => {
    // 1. Initialize isolated scenario environments
    isolatedEnv = new IsolatedTestEnvironment('agentlink-m1-');
    supervisor = new ProcessSupervisor();

    // 2. Set test environment paths to isolated directories
    process.env.DATA_PATH = isolatedEnv.paths.serverData;
    process.env.BUG_LOG_PATH = isolatedEnv.paths.serverBugLog;
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');

    // 3. Start AgentLink server on ephemeral port (0)
    server = new AgentLinkServer(0);
    serverPort = await server.listen();
    serverUrl = `http://127.0.0.1:${serverPort}`;

    // 4. Start FaultProxy forwarding to the AgentLink server
    faultProxy = new FaultProxy(serverUrl);
    proxyPort = await faultProxy.start();
    proxyUrl = `http://127.0.0.1:${proxyPort}`;

    // 5. Admin logs in and provisions test credentials
    const authRes = await fetch(`${serverUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    });
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    adminToken = authData.token;

    // Provision API keys for Alice, Bob, and Eve
    const genKey = async (label: string) => {
      const res = await fetch(`${serverUrl}/api/keys/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      return data.apiKey?.key || data.key;
    };

    aliceApiKey = await genKey('Alice Key');
    bobApiKey = await genKey('Bob Key');
    eveApiKey = await genKey('Eve Key');
  });

  afterAll(async () => {
    await supervisor.teardownAll();
    await faultProxy.close();
    await server.close();
    isolatedEnv.cleanup();
  });

  it('E2E-001: Clean onboarding from isolated CLI home against non-default URL exposes zero secrets', async () => {
    // Keygen inside Alice's isolated environment
    const keygenRes = await isolatedEnv.runCli('alice', [
      'keygen',
      '--agent-id',
      'agent-alice',
      '--json',
    ]);
    expect(keygenRes.exitCode).toBe(0);
    const keygenData = JSON.parse(keygenRes.stdout);
    expect(keygenData.status).toBe('ok');
    expect(keygenData.agentId).toBe('agent-alice');

    // Verify key file was saved in Alice's isolated keys directory
    const aliceKeyFile = path.join(isolatedEnv.paths.actors['alice'].keys, 'agent-alice.json');
    expect(fs.existsSync(aliceKeyFile)).toBe(true);

    // Register with server
    const regRes = await isolatedEnv.runCli('alice', [
      'register',
      '--agent-id',
      'agent-alice',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
    ]);
    expect(regRes.exitCode).toBe(0);

    // Assert no private keys or secrets leaked in output
    expect(regRes.stdout).not.toContain('ed25519_priv');
    expect(regRes.stdout).not.toContain('x25519_priv');
    expect(regRes.stderr).not.toContain('ed25519_priv');

    // Confirm server state reflects exactly one agent for Alice
    const agentRes = await fetch(`${serverUrl}/api/agents/agent-alice`, {
      headers: { 'Authorization': `Bearer ${aliceApiKey}` },
    });
    expect(agentRes.status).toBe(200);
    const agentData = await agentRes.json();
    expect(agentData.agent?.id || agentData.id).toBe('agent-alice');
  });

  it('E2E-002: Rejection of absent, invalid, and unauthorized credentials with zero state leakage', async () => {
    // Keygen for Bob
    await isolatedEnv.runCli('bob', ['keygen', '--agent-id', 'agent-bob', '--json']);

    // Attempt register with missing API key
    const missingKeyRes = await isolatedEnv.runCli('bob', [
      'register',
      '--agent-id',
      'agent-bob',
      '--server',
      serverUrl,
      '--api-key',
      '',
    ]);
    expect(missingKeyRes.exitCode).not.toBe(0);

    // Attempt register with invalid API key
    const invalidKeyRes = await isolatedEnv.runCli('bob', [
      'register',
      '--agent-id',
      'agent-bob',
      '--server',
      serverUrl,
      '--api-key',
      'sec_invalid_key_xyz999',
    ]);
    expect(invalidKeyRes.exitCode).not.toBe(0);

    // Verify Bob was not registered
    const checkRes = await fetch(`${serverUrl}/api/agents/agent-bob`, {
      headers: { 'Authorization': `Bearer ${aliceApiKey}` },
    });
    expect(checkRes.status).toBe(404);
  });

  it('E2E-003: Idempotent registration retry when response is lost after server commit', async () => {
    // Inject fault: drop connection immediately after server commits registration
    faultProxy.setFault({
      mode: 'drop_after_commit',
      targetPathPrefix: '/api/agents/register',
    });

    // Bob registers through fault proxy: server commits, but client receives aborted socket
    const attempt1 = await isolatedEnv.runCli('bob', [
      'register',
      '--agent-id',
      'agent-bob',
      '--server',
      proxyUrl,
      '--api-key',
      bobApiKey,
    ]);
    // Client observes connection failure
    expect(attempt1.exitCode).not.toBe(0);

    // Reset proxy fault to normal forwarding
    faultProxy.resetFault();

    // Client retries registration
    const attempt2 = await isolatedEnv.runCli('bob', [
      'register',
      '--agent-id',
      'agent-bob',
      '--server',
      proxyUrl,
      '--api-key',
      bobApiKey,
    ]);
    expect(attempt2.exitCode).toBe(0);

    // Verify Bob is registered idempotently without duplicate records
    const checkRes = await fetch(`${serverUrl}/api/agents/agent-bob`, {
      headers: { 'Authorization': `Bearer ${bobApiKey}` },
    });
    expect(checkRes.status).toBe(200);
    const bobRecord = await checkRes.json();
    expect(bobRecord.agent?.id || bobRecord.id).toBe('agent-bob');
  });

  it('E2E-004: Ownership collision & path traversal injection defense', async () => {
    // Eve generates her own key for 'agent-alice' to attempt identity takeover
    await isolatedEnv.runCli('eve', ['keygen', '--agent-id', 'agent-alice', '--json']);

    // Eve attempts to register under Alice's agent ID with Eve's API key
    const hijackRes = await isolatedEnv.runCli('eve', [
      'register',
      '--agent-id',
      'agent-alice',
      '--server',
      serverUrl,
      '--api-key',
      eveApiKey,
    ]);
    // Must be rejected
    expect(hijackRes.exitCode).not.toBe(0);

    // Eve attempts path traversal in agent ID
    const traversalRes = await isolatedEnv.runCli('eve', [
      'keygen',
      '--agent-id',
      '../../traversal-agent',
      '--json',
    ]);
    // Either fails validation or creates strictly inside isolated directory
    const outsideFile = path.resolve(isolatedEnv.paths.root, '../traversal-agent.json');
    expect(fs.existsSync(outsideFile)).toBe(false);
  });

  it('E2E-005: connect --once exits cleanly without claiming persistent listener; active listener supervises cleanly', async () => {
    // 1. connect --once registers and exits within deadline
    const connectOnceRes = await isolatedEnv.runCli('alice', [
      'connect',
      '--agent-id',
      'agent-alice',
      '--server',
      serverUrl,
      '--api-key',
      aliceApiKey,
      '--once',
    ]);
    expect(connectOnceRes.exitCode).toBe(0);

    // 2. Start a real supervised watcher/listener process
    const inboxPath = isolatedEnv.paths.actors['alice'].inbox;
    const aliceEnv = isolatedEnv.getActorEnv('alice');

    const listenerProc = supervisor.spawn(
      'alice-watcher',
      'python3',
      [
        '-m',
        'agent_link.cli',
        'receive',
        '--agent-id',
        'agent-alice',
        '--server',
        serverUrl,
        '--api-key',
        aliceApiKey,
        '--watch',
        '--inbox',
        inboxPath,
        '--interval',
        '0.5',
      ],
      { cwd: isolatedEnv.paths.actors['alice'].root, env: aliceEnv }
    );

    // Wait until listener is observed actively polling
    await supervisor.waitForCondition(
      () => listenerProc.stderr.some((line) => line.includes('watching') || line.includes('polling')),
      'Alice listener starts watching queue',
      4000
    );

    expect(listenerProc.exited).toBe(false);

    // Teardown the listener and verify clean exit
    listenerProc.process.kill('SIGTERM');
    await supervisor.waitForCondition(() => listenerProc.exited, 'Alice listener terminates gracefully', 2000);
    expect(listenerProc.exited).toBe(true);
  });

  it('Fault Proxy: Mid-body truncation and network delays are handled safely without server crash', async () => {
    // Set truncation fault on message poll endpoint
    faultProxy.setFault({
      mode: 'truncate_body',
      targetPathPrefix: '/api/agents/agent-alice/poll',
    });

    // Alice polls through fault proxy
    const pollRes = await isolatedEnv.runCli('alice', [
      'receive',
      '--agent-id',
      'agent-alice',
      '--server',
      proxyUrl,
      '--api-key',
      aliceApiKey,
      '--timeout',
      '1',
    ]);

    // CLI reports network/truncation error safely without crashing
    expect(pollRes.exitCode).not.toBe(0);

    // Reset proxy and verify server remains healthy and responsive
    faultProxy.resetFault();
    const healthRes = await fetch(`${serverUrl}/health`);
    expect(healthRes.status).toBe(200);
  });
});
