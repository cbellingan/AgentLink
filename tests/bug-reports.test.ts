import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Autonomous Bug Reporting System', () => {
  let server: AgentLinkServer;
  let baseUrl: string;
  let tempDir: string;
  let testBugLogPath: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-link-bug-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    testBugLogPath = path.join(tempDir, 'bug-reports.jsonl');
    process.env.BUG_LOG_PATH = testBugLogPath;
    process.env.NODE_ENV = 'test';

    server = new AgentLinkServer(0);
    const port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. Successfully submits a valid cleartext bug report within 10 KB', async () => {
    const reportData = {
      agentId: 'agent-alice',
      title: 'Failed to negotiate symmetric key ratchet',
      details: 'Error: invalid ECDH curve point received from peer during optical QR scan handshake',
      severity: 'high',
      context: { peerId: 'agent-bob', step: 'key_exchange', code: 504 },
    };

    const res = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportData),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.bugId).toMatch(/^bug_/);
    expect(json.report.title).toBe(reportData.title);
    expect(json.report.severity).toBe('high');
    expect(json.report.agentId).toBe('agent-alice');
    expect(json.report.resolved).toBe(false);

    // Verify written to local JSONL log file
    expect(fs.existsSync(testBugLogPath)).toBe(true);
    const fileContent = fs.readFileSync(testBugLogPath, 'utf8');
    expect(fileContent).toContain(json.bugId);
    expect(fileContent).toContain('Failed to negotiate symmetric key ratchet');
  });

  it('2. Rejects payloads exceeding the strict 10 KB (10,240 bytes) limit with 413', async () => {
    // Generate a payload that exceeds 10,240 bytes
    const largeDetails = 'X'.repeat(10240); // details alone is 10KB, plus JSON keys makes it > 10,240 bytes
    const oversizedPayload = {
      agentId: 'agent-spam',
      title: 'Huge memory dump',
      details: largeDetails,
    };

    const rawBody = JSON.stringify(oversizedPayload);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBeGreaterThan(10240);

    const res = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe('payload_too_large');
    expect(json.message).toContain('10240 bytes');
  });

  it('3. Enforces rate limiting (max 5 submissions per minute per agent/IP) with 429', async () => {
    const agentId = 'rate-test-agent';

    // Submit 4 reports (to hit limit of 5 total for this agent)
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${baseUrl}/api/bugs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          title: `Bug report attempt ${i}`,
          details: `Details for attempt ${i}`,
        }),
      });
      expect(res.status).toBe(201);
    }

    // 5th attempt for this agent
    const res5 = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        title: 'Bug report attempt 5',
        details: 'Details for attempt 5',
      }),
    });
    expect(res5.status).toBe(201);

    // 6th attempt should trigger 429 rate limited
    const res6 = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        title: 'Spam report attempt 6',
        details: 'This should be blocked by the rate limiter',
      }),
    });
    expect(res6.status).toBe(429);
    const json6 = await res6.json();
    expect(json6.error).toBe('rate_limited');
  });

  it('4. Retrieves bug reports via GET /api/bugs and supports resolution', async () => {
    const listRes = await fetch(`${baseUrl}/api/bugs`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.status).toBe('ok');
    expect(Array.isArray(listJson.bugs)).toBe(true);
    expect(listJson.bugs.length).toBeGreaterThanOrEqual(1);

    const firstBug = listJson.bugs[0];
    expect(firstBug.resolved).toBe(false);

    // Mark as resolved
    const resolveRes = await fetch(`${baseUrl}/api/bugs/${firstBug.id}/resolve`, {
      method: 'POST',
    });
    expect(resolveRes.status).toBe(200);
    const resolveJson = await resolveRes.json();
    expect(resolveJson.bug.resolved).toBe(true);

    // Verify updated on next fetch
    const listRes2 = await fetch(`${baseUrl}/api/bugs`);
    const listJson2 = await listRes2.json();
    const updatedBug = listJson2.bugs.find((b: any) => b.id === firstBug.id);
    expect(updatedBug.resolved).toBe(true);
  });

  it('5. Enforces strict submitter privacy: Operator A cannot see Operator B bug reports and vice-versa', async () => {
    // Create Operator A session (Carl / Admin)
    const tokenA = server.createSession({
      id: 'human_admin',
      email: 'carl@test.local',
      name: 'Carl',
      role: 'admin',
    });

    // Create Operator B session (Vijaya / Collaborator)
    const tokenB = server.createSession({
      id: 'human_vijaya_12345',
      email: 'vijaya@test.local',
      name: 'Vijaya',
      role: 'collaborator',
    });

    // Operator A submits a bug report
    const resA = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        title: 'Operator A Private Bug: Database Lock Contention',
        details: 'High concurrency issue during ledger sync',
        severity: 'high',
      }),
    });
    expect(resA.status).toBe(201);
    const jsonA = await resA.json();
    const bugIdA = jsonA.bugId;
    expect(jsonA.report.submitterHumanId).toBe('human_admin');
    expect(jsonA.report.submitterEmail).toBe('carl@test.local');

    // Operator B submits a bug report
    const resB = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        title: 'Operator B Private Bug: WebAuthn Prompt Timeout',
        details: 'Key generation timeout on Safari mobile',
        severity: 'medium',
      }),
    });
    expect(resB.status).toBe(201);
    const jsonB = await resB.json();
    const bugIdB = jsonB.bugId;
    expect(jsonB.report.submitterHumanId).toBe('human_vijaya_12345');
    expect(jsonB.report.submitterEmail).toBe('vijaya@test.local');

    // Query bugs as Operator A
    const listA = await fetch(`${baseUrl}/api/bugs`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    expect(listA.status).toBe(200);
    const listAJson = await listA.json();
    const bugsA = listAJson.bugs;
    // Operator A must see bug A
    expect(bugsA.some((b: any) => b.id === bugIdA)).toBe(true);
    // Operator A must NOT see bug B!
    expect(bugsA.some((b: any) => b.id === bugIdB)).toBe(false);

    // Query bugs as Operator B
    const listB = await fetch(`${baseUrl}/api/bugs`, {
      headers: { 'Authorization': `Bearer ${tokenB}` },
    });
    expect(listB.status).toBe(200);
    const listBJson = await listB.json();
    const bugsB = listBJson.bugs;
    // Operator B must see bug B
    expect(bugsB.some((b: any) => b.id === bugIdB)).toBe(true);
    // Operator B must NOT see bug A!
    expect(bugsB.some((b: any) => b.id === bugIdA)).toBe(false);
  });

  it('6. Blocks cross-account bug resolution: Operator B cannot resolve Operator A bug', async () => {
    const tokenA = server.createSession({
      id: 'human_admin',
      email: 'carl@test.local',
      name: 'Carl',
      role: 'admin',
    });
    const tokenB = server.createSession({
      id: 'human_vijaya_12345',
      email: 'vijaya@test.local',
      name: 'Vijaya',
      role: 'collaborator',
    });

    // Operator A submits a bug
    const postRes = await fetch(`${baseUrl}/api/bugs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        title: 'Confidential Security Bug by Carl',
        details: 'Zero knowledge handshake proof invalidation',
      }),
    });
    const postJson = await postRes.json();
    const carlBugId = postJson.bugId;

    // Operator B attempts to resolve Operator A's bug -> 403 Forbidden
    const unauthResolve = await fetch(`${baseUrl}/api/bugs/${carlBugId}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ resolved: true, note: 'Malicious resolve attempt' }),
    });
    expect(unauthResolve.status).toBe(403);
    const unauthJson = await unauthResolve.json();
    expect(unauthJson.error).toBe('forbidden');

    // Operator A successfully resolves their own bug -> 200 OK
    const authResolve = await fetch(`${baseUrl}/api/bugs/${carlBugId}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ resolved: true, note: 'Legitimately resolved by Carl' }),
    });
    expect(authResolve.status).toBe(200);
    const authJson = await authResolve.json();
    expect(authJson.bug.resolved).toBe(true);
    expect(authJson.bug.resolvedBy).toBe('Carl');
  });

  it('7. Agent API Key queries only return bug reports belonging to the agent owner', async () => {
    // Provision API key for Operator B
    const apiKeyB = 'sec_apk_agent_vijaya_test';
    server.apiKeys.set(apiKeyB, {
      id: apiKeyB,
      key: apiKeyB,
      ownerHumanId: 'human_vijaya_12345',
      createdAt: new Date().toISOString(),
    });

    // Agent owned by B queries bugs via Bearer API key
    const agentList = await fetch(`${baseUrl}/api/bugs`, {
      headers: { 'Authorization': `Bearer ${apiKeyB}` },
    });
    expect(agentList.status).toBe(200);
    const json = await agentList.json();

    // All bugs returned must belong to human_vijaya_12345
    expect(json.bugs.length).toBeGreaterThanOrEqual(1);
    for (const b of json.bugs) {
      expect(b.submitterHumanId).toBe('human_vijaya_12345');
    }
  });
});
