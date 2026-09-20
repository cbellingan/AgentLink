import { describe, it, expect, afterAll } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { IsolatedTestEnvironment } from './harness/isolated-env.js';
import { ProcessSupervisor } from './harness/process-supervisor.js';

describe('Milestone 3: Gate B Acceptance Catalogue (E2E-029 to E2E-035)', () => {
  const supervisor = new ProcessSupervisor();
  const tempDirs: string[] = [];

  afterAll(async () => {
    await supervisor.teardownAll();
    for (const dir of tempDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('E2E-029: Run two isolated harness instances concurrently; verify zero state leak, independent ports, and clean teardown', async () => {
    process.env.AUTHORIZED_EMAIL_HASHES = `${crypto.createHash('sha256').update('admin1@signetmesh.internal').digest('hex')},${crypto.createHash('sha256').update('admin2@signetmesh.internal').digest('hex')}`;
    const env1 = new IsolatedTestEnvironment('agentlink-gate-b-c1-');
    const env2 = new IsolatedTestEnvironment('agentlink-gate-b-c2-');

    process.env.DATA_PATH = env1.paths.serverData;
    process.env.BUG_LOG_PATH = env1.paths.serverBugLog;
    const server1 = new AgentLinkServer(0);
    const port1 = await server1.listen();
    const url1 = `http://127.0.0.1:${port1}`;

    process.env.DATA_PATH = env2.paths.serverData;
    process.env.BUG_LOG_PATH = env2.paths.serverBugLog;
    const server2 = new AgentLinkServer(0);
    const port2 = await server2.listen();
    const url2 = `http://127.0.0.1:${port2}`;

    expect(port1).not.toBe(port2);

    // Setup admin on both
    const login1 = await fetch(`${url1}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin1@signetmesh.internal', name: 'Admin 1' }),
    }).then(r => r.json());
    const token1 = login1.token;

    const login2 = await fetch(`${url2}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin2@signetmesh.internal', name: 'Admin 2' }),
    }).then(r => r.json());
    const token2 = login2.token;

    // Generate keys
    const k1 = await fetch(`${url1}/api/keys/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ label: 'Key 1' }),
    }).then(r => r.json());
    const apiKey1 = k1.apiKey.key;

    const k2 = await fetch(`${url2}/api/keys/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token2}` },
      body: JSON.stringify({ label: 'Key 2' }),
    }).then(r => r.json());
    const apiKey2 = k2.apiKey.key;

    // Run CLI in env1
    await env1.runCli('alice', ['keygen', '--agent-id', 'agent-alpha', '--json']);
    const reg1 = await env1.runCli('alice', [
      'register',
      '--agent-id',
      'agent-alpha',
      '--server',
      url1,
      '--api-key',
      apiKey1,
    ]);
    expect(reg1.exitCode).toBe(0);

    // Run CLI in env2
    await env2.runCli('bob', ['keygen', '--agent-id', 'agent-beta', '--json']);
    const reg2 = await env2.runCli('bob', [
      'register',
      '--agent-id',
      'agent-beta',
      '--server',
      url2,
      '--api-key',
      apiKey2,
    ]);
    expect(reg2.exitCode).toBe(0);

    // Inspect server1: only agent-alpha exists
    const s1Agents = await fetch(`${url1}/api/agents`, {
      headers: { 'Authorization': `Bearer ${token1}` },
    }).then(r => r.json());
    expect(s1Agents.agents.some((a: any) => a.id === 'agent-alpha')).toBe(true);
    expect(s1Agents.agents.some((a: any) => a.id === 'agent-beta')).toBe(false);

    // Inspect server2: only agent-beta exists
    const s2Agents = await fetch(`${url2}/api/agents`, {
      headers: { 'Authorization': `Bearer ${token2}` },
    }).then(r => r.json());
    expect(s2Agents.agents.some((a: any) => a.id === 'agent-beta')).toBe(true);
    expect(s2Agents.agents.some((a: any) => a.id === 'agent-alpha')).toBe(false);

    // Inspect files: no cross-contamination
    const env1Files = fs.readdirSync(env1.paths.actors['alice'].keys);
    expect(env1Files).toContain('agent-alpha.json');
    expect(env1Files).not.toContain('agent-beta.json');

    const env2Files = fs.readdirSync(env2.paths.actors['bob'].keys);
    expect(env2Files).toContain('agent-beta.json');
    expect(env2Files).not.toContain('agent-alpha.json');

    // Teardown
    await server1.close();
    await server2.close();
    env1.cleanup();
    env2.cleanup();
  });

  it('E2E-030: Launch SignetMesh fixture from another directory with selected configuration', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signetmesh-fixture-'));
    tempDirs.push(fixtureDir);

    const fixtureDataPath = path.join(fixtureDir, 'state.json');
    const fixtureBugPath = path.join(fixtureDir, 'bugs.jsonl');

    process.env.DATA_PATH = fixtureDataPath;
    process.env.BUG_LOG_PATH = fixtureBugPath;
    process.env.BRAND_NAME = 'SignetMesh Acceptance Fixture';

    const fixtureServer = new AgentLinkServer(0);
    const port = await fixtureServer.listen();
    const url = `http://127.0.0.1:${port}`;

    const infoRes = await fetch(`${url}/api/server-info`);
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.brandName).toBe('SignetMesh Acceptance Fixture');
    expect(info.version).toBeTruthy();

    await fixtureServer.close();
  });

  it('E2E-031: Occupy requested port with unrelated fixture process; deployment fails clearly without terminating unrelated process', async () => {
    // 1. Start an unrelated HTTP listener on an ephemeral port
    const blockerServer = http.createServer((_, res) => res.end('blocker'));
    const occupiedPort = await new Promise<number>((resolve) => {
      blockerServer.listen(0, () => {
        const addr = blockerServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    // 2. Attempt to start AgentLinkServer on that exact port
    const conflictingServer = new AgentLinkServer(occupiedPort);
    let failed = false;
    try {
      await conflictingServer.listen();
    } catch (err: any) {
      failed = true;
      expect(err.code || err.message).toContain('EADDRINUSE');
    }
    expect(failed).toBe(true);

    // 3. Verify unrelated blocker process is still alive and listening
    const probe = await fetch(`http://127.0.0.1:${occupiedPort}`);
    expect(probe.status).toBe(200);
    const body = await probe.text();
    expect(body).toBe('blocker');

    // Clean up blocker
    await new Promise<void>((resolve) => blockerServer.close(() => resolve()));
  });

  it('E2E-032: Missing production authentication configuration rejects invalid bypasses in production mode', async () => {
    const prodServer = new AgentLinkServer(0);
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const port = await prodServer.listen();
    const url = `http://127.0.0.1:${port}`;

    // Plain email login without valid Google token in production mode must be rejected
    const unauthLogin = await fetch(`${url}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@prod.test' }),
    });
    expect(unauthLogin.status).toBe(401);

    await prodServer.close();
    process.env.NODE_ENV = origEnv;
  });

  it('E2E-034: Exercise staged-bad vs unstaged-good content in disposable git repository', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-e2e034-'));
    tempDirs.push(repoDir);

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test Committer"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "committer@test.local"', { cwd: repoDir, stdio: 'pipe' });

    // Copy .githooks from AgentLink
    const hooksSource = path.resolve(process.cwd(), '.githooks');
    const hooksDest = path.join(repoDir, '.githooks');
    fs.cpSync(hooksSource, hooksDest, { recursive: true });
    execSync('chmod +x .githooks/*', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config core.hooksPath .githooks', { cwd: repoDir, stdio: 'pipe' });

    // Initial clean commit
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Initial Repository\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: repoDir, stdio: 'pipe' });

    // Stage a file containing conflict markers
    fs.writeFileSync(path.join(repoDir, 'conflict.js'), 'const a = 1;\n<<<<<<< HEAD\nconst conflict = true;\n=======\nconst conflict = false;\n>>>>>>> branch\n');
    execSync('git add conflict.js', { cwd: repoDir, stdio: 'pipe' });

    // Attempt commit: must be rejected by pre-commit hook
    let commitFailed = false;
    try {
      execSync('git commit -m "commit bad conflict"', { cwd: repoDir, stdio: 'pipe' });
    } catch {
      commitFailed = true;
    }
    expect(commitFailed).toBe(true);

    // Replace staged content with clean content
    fs.writeFileSync(path.join(repoDir, 'conflict.js'), 'const a = 1;\nconst resolved = true;\n');
    execSync('git add conflict.js', { cwd: repoDir, stdio: 'pipe' });

    // Now commit succeeds
    execSync('git commit -m "commit resolved code"', { cwd: repoDir, stdio: 'pipe' });
    const log = execSync('git log -n 1 --oneline', { cwd: repoDir, encoding: 'utf8' });
    expect(log).toContain('commit resolved code');
  });

  it('E2E-035: Doctor verification script rejects broken repository configurations', () => {
    const brokenRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-repo-'));
    tempDirs.push(brokenRepoDir);

    execSync('git init', { cwd: brokenRepoDir, stdio: 'pipe' });
    // Run doctor script from inside brokenRepoDir without hooks configured
    const doctorScript = path.resolve(process.cwd(), 'scripts', 'doctor.mjs');
    let doctorFailed = false;
    try {
      execSync(`node ${doctorScript}`, {
        cwd: brokenRepoDir,
        stdio: 'pipe',
        env: { ...process.env, AGENT_LINK_DOCTOR_RUNNING: '1' },
      });
    } catch {
      doctorFailed = true;
    }
    expect(doctorFailed).toBe(true);
  });
});
