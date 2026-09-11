import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

describe('Cross-Project End-to-End Integration Suite (AgentLink Server + agent-link-cli)', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;
  let carlToken: string;
  let apiKeyAlice: string;
  let apiKeyBob: string;

  beforeAll(async () => {
    // 1. Create temporary directory for isolated agent keyrings
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-link-e2e-'));

    // 2. Start AgentLink Server on ephemeral port
    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Step 1: Gatekeeper correctly blocks non-whitelisted Google sign-ins with "Not enabled right now"', async () => {
    const res = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@acme.org' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('not_enabled');
    expect(body.message).toBe('Not enabled right now');
  });

  it('Step 2: Human Operator (Carl) logs in via Google and provisions API keys', async () => {
    // Carl Google sign-in
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cbellingan@gmail.com' }),
    });
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(authData.authenticated).toBe(true);
    carlToken = authData.token;
    expect(carlToken).toMatch(/^sec_hum_/);

    // Provision API key for Alice
    const keyResAlice = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${carlToken}`,
      },
      body: JSON.stringify({ label: 'Alice Agent Production Key' }),
    });
    expect(keyResAlice.status).toBe(201);
    const keyAliceData = await keyResAlice.json();
    apiKeyAlice = keyAliceData.apiKey.key;
    expect(apiKeyAlice).toMatch(/^sec_apk_/);

    // Provision API key for Bob
    const keyResBob = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${carlToken}`,
      },
      body: JSON.stringify({ label: 'Bob Agent Production Key' }),
    });
    expect(keyResBob.status).toBe(201);
    const keyBobData = await keyResBob.json();
    apiKeyBob = keyBobData.apiKey.key;
    expect(apiKeyBob).toMatch(/^sec_apk_/);
  });

  it('Step 3: CLI generates Ed25519/X25519 keypair and renders ASCII QR Code', async () => {
    const aliceKeyDir = path.join(tempDir, 'alice_keys');
    const { stdout } = await execFileAsync('agent-link', [
      'keygen',
      '--agent-id', 'agent-alice',
      '--key-dir', aliceKeyDir,
    ]);

    expect(stdout).toContain("AgentLink Public Identity Anchor: agent-alice");
    expect(stdout).toContain("Compact JSON Payload");
    // Verify terminal QR unicode/ascii elements rendered
    expect(stdout).toMatch(/[█▀▄]/);

    // Verify key files created with proper permissions
    const keyFile = path.join(aliceKeyDir, 'agent-alice.json');
    expect(fs.existsSync(keyFile)).toBe(true);
    const keyData = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    expect(keyData.agent_id).toBe('agent-alice');
    expect(keyData.signPub).toBeTruthy();
    expect(keyData.encPub).toBeTruthy();
    expect(keyData.ed25519_priv_b64).toBeTruthy();
    expect(keyData.x25519_priv_b64).toBeTruthy();
    expect(keyData.kid).toMatch(/^kid-agent-alice-/);

    // Check file permissions are strict (0600) on POSIX
    if (process.platform !== 'win32') {
      const stat = fs.statSync(keyFile);
      expect((stat.mode & 0o777)).toBe(0o600);
    }
  });

  it('Step 4: CLI registers Agent Alice with AgentLink server using the provisioned API Key', async () => {
    const aliceKeyDir = path.join(tempDir, 'alice_keys');
    const { stdout } = await execFileAsync('agent-link', [
      'register',
      '--agent-id', 'agent-alice',
      '--api-key', apiKeyAlice,
      '--server', baseUrl,
      '--key-dir', aliceKeyDir,
    ]);

    expect(stdout).toContain("Registering agent 'agent-alice'");
    expect(stdout).toContain("Successfully registered! Status: ok");

    // Verify registration reflects on server fleet
    const agentsRes = await fetch(`${baseUrl}/api/agents`).then(r => r.json());
    const aliceAgent = agentsRes.agents.find((a: any) => a.id === 'agent-alice');
    expect(aliceAgent).toBeDefined();
    expect(aliceAgent.kid).toMatch(/^kid-agent-alice-/);
    expect(aliceAgent.signPub).toBeTruthy();
    expect(aliceAgent.encPub).toBeTruthy();
  });

  it('Step 5: CLI registers Agent Bob with AgentLink server using provisioned API key', async () => {
    const bobKeyDir = path.join(tempDir, 'bob_keys');
    const { stdout } = await execFileAsync('agent-link', [
      'register',
      '--agent-id', 'agent-bob',
      '--api-key', apiKeyBob,
      '--server', baseUrl,
      '--key-dir', bobKeyDir,
    ]);

    expect(stdout).toContain("Registering agent 'agent-bob'");
    expect(stdout).toContain("Successfully registered! Status: ok");

    // Verify both agents exist in server fleet
    const agentsRes = await fetch(`${baseUrl}/api/agents`).then(r => r.json());
    expect(agentsRes.agents.some((a: any) => a.id === 'agent-alice')).toBe(true);
    expect(agentsRes.agents.some((a: any) => a.id === 'agent-bob')).toBe(true);
  });

  it('Step 6: CLI status command reports active registration', async () => {
    const aliceKeyDir = path.join(tempDir, 'alice_keys');
    const { stdout } = await execFileAsync('agent-link', [
      'status',
      '--agent-id', 'agent-alice',
      '--key-dir', aliceKeyDir,
    ]);

    expect(stdout).toContain("Agent ID:       agent-alice");
    expect(stdout).toContain("Key ID (kid):   kid-agent-alice-");
    expect(stdout).toContain("Signing Pub:");
    expect(stdout).toContain("Encryption Pub:");
  });

  it('Step 7: Autonomous End-to-End Encrypted Message Exchange between Alice and Bob', async () => {
    // 1. Establish an approved Link between Alice and Bob
    const linkRes = await fetch(`${baseUrl}/api/links/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentAId: 'agent-alice',
        agentBId: 'agent-bob',
        initiatorHumanId: 'human_carl',
      }),
    }).then(r => r.json());
    const linkId = linkRes.linkId;
    expect(linkId).toBeTruthy();

    const approveRes = await fetch(`${baseUrl}/api/links/${linkId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerVerification: 'optical_qr_verified' }),
    }).then(r => r.json());
    expect(approveRes.status).toBe('ok');

    // 2. Execute encrypted dispatch in Python and poll decryption
    const aliceKeysDir = path.join(tempDir, 'alice_keys');
    const bobKeysDir = path.join(tempDir, 'bob_keys');

    const testScript = `
import json, sys
from pathlib import Path
from agent_link.client import AgentLinkClient
from agent_link.crypto import AgentKeypair

# Load Alice & Bob keypairs from isolated test directories
alice_kp = AgentKeypair.load(agent_id='agent-alice', directory=Path('${aliceKeysDir}'))
bob_kp = AgentKeypair.load(agent_id='agent-bob', directory=Path('${bobKeysDir}'))

alice_client = AgentLinkClient(
    server_url='${baseUrl}',
    api_key='${apiKeyAlice}',
    keypair=alice_kp,
)
bob_client = AgentLinkClient(
    server_url='${baseUrl}',
    api_key='${apiKeyBob}',
    keypair=bob_kp,
)

# Alice sends E2EE payload encrypted with Bob's public key
secret_plaintext = json.dumps({
    "command": "verify_peer_handshake",
    "challenge": "alice_challenges_bob_092026",
    "instructions": "Confirm human optical authorization complete"
})

send_result = alice_client.send_encrypted(
    link_id='${linkId}',
    peer_enc_pub_b64=bob_kp.enc_pub_b64,
    plaintext=secret_plaintext,
)
assert send_result.get("status") == "ok", f"Send failed: {send_result}"

# Bob polls for incoming messages
messages = bob_client.poll_messages(timeout_seconds=2)
assert len(messages) == 1, f"Expected 1 message, got {len(messages)}"

received_frame = messages[0]
assert received_frame["senderId"] == "agent-alice"
assert received_frame["linkId"] == "${linkId}"

# Bob decrypts payload using his private key and Alice's public key
payload = received_frame["payload"]
decrypted_bytes = bob_kp.decrypt(
    peer_enc_pub_b64=alice_kp.enc_pub_b64,
    iv_b64=payload["iv"],
    data_b64=payload["data"],
)
decrypted_json = json.loads(decrypted_bytes.decode("utf-8"))

assert decrypted_json["challenge"] == "alice_challenges_bob_092026"
assert decrypted_json["command"] == "verify_peer_handshake"
print("E2EE_VERIFICATION_SUCCESS")
`;

    const { stdout } = await execFileAsync('python3', ['-c', testScript]);
    expect(stdout).toContain("E2EE_VERIFICATION_SUCCESS");
  });

  it('Step 8: Skill file validation for autonomous agents', () => {
    // Check that SKILL.md exists in CLI repo and specifies clear protocol
    const cliSkillPath = '/Users/cb/Documents/antigravity/agent-link-cli/SKILL.md';
    expect(fs.existsSync(cliSkillPath)).toBe(true);
    const skillContent = fs.readFileSync(cliSkillPath, 'utf8');

    expect(skillContent).toContain("agent-link");
    expect(skillContent).toContain("keygen");
    expect(skillContent).toContain("register");
    expect(skillContent).toContain("ASCII QR");
    expect(skillContent).toContain("cbellingan@gmail.com");
  });
});
