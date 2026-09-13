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
});
