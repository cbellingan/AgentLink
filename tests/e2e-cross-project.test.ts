import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentLinkServer } from '../server/agent-link-server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TEST_ADMIN_EMAIL = 'admin@mesh.local';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_DIR = process.env.AGENT_LINK_CLI_DIR ||
  (fs.existsSync(path.resolve(__dirname, '../../agent-link-cli'))
    ? path.resolve(__dirname, '../../agent-link-cli')
    : path.resolve(process.cwd(), '../agent-link-cli'));

async function runCli(args: string[], options: any = {}) {
  const env = { ...process.env, PYTHONPATH: `${CLI_DIR}:${process.env.PYTHONPATH || ''}`, ...options.env };
  try {
    return await execFileAsync('agent-link', args, { ...options, env });
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return await execFileAsync('python3', ['-m', 'agent_link.cli', ...args], { ...options, env, cwd: CLI_DIR });
    }
    throw err;
  }
}

function runPython(args: string[], options: any = {}) {
  const env = { ...process.env, PYTHONPATH: `${CLI_DIR}:${process.env.PYTHONPATH || ''}`, ...options.env };
  return execFileAsync('python3', args, { ...options, env });
}

describe('Cross-Project End-to-End Integration Suite (AgentLink Server + agent-link-cli)', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;
  let adminToken: string;
  let apiKeyAlice: string;
  let apiKeyBob: string;

  beforeAll(async () => {
    // 1. Create temporary directory for isolated agent keyrings and state
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-link-e2e-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');

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

  it('Step 2: Human Operator logs in via Google and provisions API keys', async () => {
    // Admin Google sign-in
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    });
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(authData.authenticated).toBe(true);
    adminToken = authData.token;
    expect(adminToken).toMatch(/^sec_hum_/);

    // Provision API key for Alice
    const keyResAlice = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
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
        'Authorization': `Bearer ${adminToken}`,
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
    const { stdout } = await runCli([
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
    const { stdout } = await runCli([
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
    const { stdout } = await runCli([
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
    const { stdout } = await runCli([
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
        initiatorHumanId: 'human_admin',
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

# Bob verifies signature and decrypts payload using open_envelope
payload = received_frame["payload"]
assert payload.get("v") == 2, f"Expected v2 envelope, got {payload}"
assert "sig" in payload, "Missing Ed25519 signature in envelope"
assert "nonce" in payload, "Missing nonce in envelope"

decrypted_text = bob_kp.open_envelope(
    link_id='${linkId}',
    peer_sign_pub_b64=alice_kp.sign_pub_b64,
    peer_enc_pub_b64=alice_kp.enc_pub_b64,
    envelope=payload,
)
decrypted_json = json.loads(decrypted_text)

assert decrypted_json["challenge"] == "alice_challenges_bob_092026"
assert decrypted_json["command"] == "verify_peer_handshake"

# Verify failure mode: tampered signature is rejected
tampered_payload = dict(payload)
tampered_payload["sig"] = "A" * len(payload["sig"])
try:
    bob_kp.open_envelope(
        link_id='${linkId}',
        peer_sign_pub_b64=alice_kp.sign_pub_b64,
        peer_enc_pub_b64=alice_kp.enc_pub_b64,
        envelope=tampered_payload,
    )
    assert False, "Should have rejected tampered signature"
except Exception as e:
    assert "signature" in str(e).lower(), f"Unexpected error: {e}"

print("E2EE_VERIFICATION_SUCCESS")
`;

    const { stdout } = await runPython(['-c', testScript]);
    expect(stdout).toContain("E2EE_VERIFICATION_SUCCESS");
  });

  it('Step 7b: Cross-Runtime Client List Retrieval & Explicit Content-Length Header Invariant', async () => {
    // 1. Verify HTTP Response Headers strictly comply with Explicit Headers Invariant
    const linksRes = await fetch(`${baseUrl}/api/links`);
    expect(linksRes.status).toBe(200);
    const linksContentType = linksRes.headers.get('content-type') || '';
    expect(linksContentType).toContain('application/json');
    const linksContentLength = linksRes.headers.get('content-length');
    expect(linksContentLength).toBeTruthy();
    const linksText = await linksRes.text();
    expect(parseInt(linksContentLength!, 10)).toBe(Buffer.byteLength(linksText, 'utf8'));

    const agentsRes = await fetch(`${baseUrl}/api/agents`);
    expect(agentsRes.status).toBe(200);
    const agentsContentLength = agentsRes.headers.get('content-length');
    expect(agentsContentLength).toBeTruthy();
    const agentsText = await agentsRes.text();
    expect(parseInt(agentsContentLength!, 10)).toBe(Buffer.byteLength(agentsText, 'utf8'));

    // 2. Python Client queries links and agents using standard urllib/http.client
    const aliceKeysDir = path.join(tempDir, 'alice_keys');
    const listTestScript = `
import json, sys
from pathlib import Path
from agent_link.client import AgentLinkClient
from agent_link.crypto import AgentKeypair

alice_kp = AgentKeypair.load(agent_id='agent-alice', directory=Path('${aliceKeysDir}'))
client = AgentLinkClient(
    server_url='${baseUrl}',
    api_key='${apiKeyAlice}',
    keypair=alice_kp,
)

# Fetch links
links = client.get_links()
assert len(links) >= 1, f"Expected at least 1 link, got {len(links)}"
link = links[0]
assert link["agentAId"] == "agent-alice"
assert link["agentBId"] == "agent-bob"

# Fetch single peer agent
bob_agents = client.get_agents("agent-bob")
assert len(bob_agents) == 1, f"Expected 1 agent, got {len(bob_agents)}"
bob_agent = bob_agents[0]
assert bob_agent["id"] == "agent-bob"
assert "encPub" in bob_agent

print("PYTHON_LIST_AND_HEADERS_OK")
`;

    const { stdout } = await runPython(['-c', listTestScript]);
    expect(stdout).toContain("PYTHON_LIST_AND_HEADERS_OK");
  });

  it('Step 8: Skill file validation for autonomous agents', () => {
    // Check that SKILL.md exists in CLI repo and specifies clear protocol
    const cliSkillPath = path.join(CLI_DIR, 'SKILL.md');
    expect(fs.existsSync(cliSkillPath)).toBe(true);
    const skillContent = fs.readFileSync(cliSkillPath, 'utf8');

    expect(skillContent).toContain("agent-link");
    expect(skillContent).toContain("keygen");
    expect(skillContent).toContain("register");
    expect(skillContent).toContain("ASCII QR");
    expect(skillContent).toContain("human administrator");
    expect(skillContent).toContain("Autonomous Bug Reporting System");
    expect(skillContent).toContain("10 KB");
  });

  it('Step 9: Autonomous bug report submission via CLI subprocess to server', async () => {
    const cliPath = CLI_DIR;
    const aliceKeysDir = path.join(tempDir, 'alice_keys');

    const { stdout } = await runPython([
      '-m', 'agent_link.cli',
      'bug-report',
      '--title', 'E2E Cross-Project Test Anomaly Report',
      '--details', 'Simulated autonomous agent operational fault telemetry for e2e validation',
      '--severity', 'medium',
      '--agent-id', 'agent-alice',
      '--server', baseUrl,
      '--key-dir', aliceKeysDir,
      '--json',
    ], { cwd: cliPath });

    const bugResult = JSON.parse(stdout.trim());
    expect(bugResult.status).toBe('ok');
    expect(bugResult.bugId).toMatch(/^bug_/);
    expect(bugResult.report.title).toBe('E2E Cross-Project Test Anomaly Report');
    expect(bugResult.report.agentId).toBe('agent-alice');
  });
});
