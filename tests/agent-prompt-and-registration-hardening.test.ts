import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import http from 'node:http';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Agent Prompt Spec & Registration Identity Hardening', () => {
  let server: AgentLinkServer;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-hardening-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.BUG_LOG_PATH = path.join(tempDir, 'bugs.jsonl');
    process.env.NODE_ENV = 'test';

    server = new AgentLinkServer(0);
    const port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. generateAgentPrompt includes Step 0 API key prerequisite, clean Step 4 send, and Step 5 receive instructions', () => {
    const prompt = server.generateAgentPrompt({
      myAgentId: 'agent-bob',
      peerAgentId: 'agent-alice',
      peerKid: 'kid-alice-12345',
      safetyNumber: '123456',
      note: 'Operational mesh link',
      portalUrl: 'https://agent.signetmesh.com',
    });

    // Step 0 must instruct setting AGENTLINK_API_KEY
    expect(prompt).toContain('0. Prerequisites & Credentials:');
    expect(prompt).toContain('export AGENTLINK_API_KEY="<YOUR_API_KEY>"');

    // Step 4 must include --server and not contain trailing backtick-semicolon typo
    expect(prompt).toContain('send --agent-id "agent-bob" --server "https://agent.signetmesh.com" --to "agent-alice" --message "Hello from agent-bob" --json');
    expect(prompt).not.toContain('--json`;');

    // Step 5 must instruct how to listen and poll with --server
    expect(prompt).toContain('5. Receive messages / listen for replies:');
    expect(prompt).toContain('receive --agent-id "agent-bob" --server "https://agent.signetmesh.com" --once --json');
    expect(prompt).toContain('receive --agent-id "agent-bob" --server "https://agent.signetmesh.com" --watch --inbox ~/.agent-link/inbox.jsonl');
  });

  it('2. Cross-Owner Agent Hijacking Prevention: Cannot re-register another owner\'s agent ID', async () => {
    // 1. Provision two different human users and API keys
    const adminKey = 'sec_apk_admin_fleet_primary';
    server.apiKeys.set(adminKey, {
      id: 'key_admin_test',
      key: adminKey,
      ownerHumanId: 'human_alice',
      label: 'Alice Fleet Key',
      createdAt: new Date().toISOString(),
    });

    const bobApiKey = 'sec_apk_bob_test_key_999';
    server.apiKeys.set(bobApiKey, {
      id: 'key_bob_test',
      key: bobApiKey,
      ownerHumanId: 'human_bob',
      label: 'Bob Fleet Key',
      createdAt: new Date().toISOString(),
    });

    // 2. Alice registers agent-alice-1
    const regAlice = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`,
      },
      body: JSON.stringify({
        id: 'agent-alice-1',
        signPub: 'alice_sign_pub_base64_val',
        encPub: 'alice_enc_pub_base64_val',
        kid: 'kid-alice-1',
      }),
    });
    expect(regAlice.status).toBe(200);

    // 3. Bob attempts to register under Alice's agent ID (Cross-owner hijack)
    const hijackRes = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bobApiKey}`,
      },
      body: JSON.stringify({
        id: 'agent-alice-1',
        signPub: 'bob_sign_pub_base64_val',
        encPub: 'bob_enc_pub_base64_val',
        kid: 'kid-bob-hijack',
      }),
    });
    expect(hijackRes.status).toBe(409);
    const hijackJson = await hijackRes.json();
    expect(hijackJson.error).toBe('agent_id_taken');
  });

  it('3. Key Rotation Authorization & Audit Trail: Silent overwrite rejected, authorized rotation logged', async () => {
    const aliceKey = 'sec_apk_admin_fleet_primary';

    // 1. Silent key rotation attempt by Alice's key without authorization flag returns 409
    const silentRotation = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceKey}`,
      },
      body: JSON.stringify({
        id: 'agent-alice-1',
        signPub: 'alice_NEW_sign_pub_val',
        encPub: 'alice_NEW_enc_pub_val',
        kid: 'kid-alice-rotated-2',
      }),
    });
    expect(silentRotation.status).toBe(409);
    const silentJson = await silentRotation.json();
    expect(silentJson.error).toBe('key_rotation_requires_authorization');

    // 2. Explicit authorized key rotation succeeds and records audit trail
    const authorizedRotation = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aliceKey}`,
      },
      body: JSON.stringify({
        id: 'agent-alice-1',
        signPub: 'alice_NEW_sign_pub_val',
        encPub: 'alice_NEW_enc_pub_val',
        kid: 'kid-alice-rotated-2',
        allowRotation: true,
      }),
    });
    expect(authorizedRotation.status).toBe(200);

    // Verify agent record was updated and rotations array was populated
    const agent = server.agents.get('agent-alice-1');
    expect(agent).toBeDefined();
    expect(agent?.kid).toBe('kid-alice-rotated-2');
    expect(agent?.signPub).toBe('alice_NEW_sign_pub_val');
    expect(agent?.rotations).toHaveLength(1);
    expect(agent?.rotations?.[0].previousKid).toBe('kid-alice-1');
    expect(agent?.rotations?.[0].newKid).toBe('kid-alice-rotated-2');
  });
});
