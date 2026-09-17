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

describe('Broader Multi-Agent Mesh Topology & Security Failure Modes', () => {
  let server: AgentLinkServer;
  let port: number;
  let baseUrl: string;
  let tempDir: string;
  let adminToken: string;
  const agents = ['mesh-alice', 'mesh-bob', 'mesh-charlie', 'mesh-dave'];
  const apiKeys: Record<string, string> = {};
  const links: Record<string, string> = {};

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mesh-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');

    server = new AgentLinkServer(0);
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Authenticate Admin
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
    }).then(r => r.json());
    adminToken = authRes.token;

    // 2. Generate API keys for all 4 mesh agents
    for (const agentId of agents) {
      const keyRes = await fetch(`${baseUrl}/api/keys/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ label: `Key for ${agentId}` }),
      }).then(r => r.json());
      apiKeys[agentId] = keyRes.apiKey.key;

      // Register agent via CLI
      const agentKeyDir = path.join(tempDir, agentId);
      await runCli([
        'register',
        '--agent-id', agentId,
        '--api-key', apiKeys[agentId],
        '--server', baseUrl,
        '--key-dir', agentKeyDir,
      ]);
    }

    // 3. Form a 4-node Ring Mesh topology: Alice <-> Bob <-> Charlie <-> Dave <-> Alice
    const pairs = [
      ['mesh-alice', 'mesh-bob', 'link_AB'],
      ['mesh-bob', 'mesh-charlie', 'link_BC'],
      ['mesh-charlie', 'mesh-dave', 'link_CD'],
      ['mesh-dave', 'mesh-alice', 'link_DA'],
    ];

    for (const [a, b, linkKey] of pairs) {
      const linkRes = await fetch(`${baseUrl}/api/links/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentAId: a, agentBId: b }),
      }).then(r => r.json());
      const lId = linkRes.linkId;
      await fetch(`${baseUrl}/api/links/${lId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerVerification: 'optical_qr_verified' }),
      });
      links[linkKey] = lId;
    }
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. Verifies entire 4-agent fleet is registered and linked in ring mesh', async () => {
    const agentsRes = await fetch(`${baseUrl}/api/agents`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }).then(r => r.json());
    for (const agentId of agents) {
      expect(agentsRes.agents.some((a: any) => a.id === agentId)).toBe(true);
    }
    const linksRes = await fetch(`${baseUrl}/api/links`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }).then(r => r.json());
    expect(linksRes.links.length).toBeGreaterThanOrEqual(4);
  });

  it('2. E2EE message exchange across opposite sides of the mesh (Alice -> Bob & Charlie -> Dave)', async () => {
    const pythonMeshScript = `
import json, sys
from pathlib import Path
from agent_link.client import AgentLinkClient
from agent_link.crypto import AgentKeypair

def load_agent(agent_id):
    kp = AgentKeypair.load(agent_id, directory=Path('${tempDir}') / agent_id)
    client = AgentLinkClient(
        server_url='${baseUrl}',
        api_key=json.loads('${JSON.stringify(apiKeys)}')[agent_id],
        keypair=kp,
    )
    return kp, client

alice_kp, alice_client = load_agent('mesh-alice')
bob_kp, bob_client = load_agent('mesh-bob')
charlie_kp, charlie_client = load_agent('mesh-charlie')
dave_kp, dave_client = load_agent('mesh-dave')

# Alice -> Bob
alice_client.send_encrypted(
    link_id='${links['link_AB']}',
    peer_enc_pub_b64=bob_kp.enc_pub_b64,
    plaintext='Alice to Bob secret message',
    recipient_id='mesh-bob',
)
bob_msgs = bob_client.poll_messages(timeout_seconds=2)
assert len(bob_msgs) == 1
bob_text = bob_kp.open_envelope(
    link_id='${links['link_AB']}',
    peer_sign_pub_b64=alice_kp.sign_pub_b64,
    peer_enc_pub_b64=alice_kp.enc_pub_b64,
    envelope=bob_msgs[0]['payload'],
)
assert bob_text == 'Alice to Bob secret message'

# Charlie -> Dave
charlie_client.send_encrypted(
    link_id='${links['link_CD']}',
    peer_enc_pub_b64=dave_kp.enc_pub_b64,
    plaintext='Charlie to Dave secret message',
    recipient_id='mesh-dave',
)
dave_msgs = dave_client.poll_messages(timeout_seconds=2)
assert len(dave_msgs) == 1
dave_text = dave_kp.open_envelope(
    link_id='${links['link_CD']}',
    peer_sign_pub_b64=charlie_kp.sign_pub_b64,
    peer_enc_pub_b64=charlie_kp.enc_pub_b64,
    envelope=dave_msgs[0]['payload'],
)
assert dave_text == 'Charlie to Dave secret message'
print('DUAL_PARALLEL_E2EE_OK')
`;
    const { stdout } = await runPython(['-c', pythonMeshScript]);
    expect(stdout).toContain('DUAL_PARALLEL_E2EE_OK');
  });

  it('3. Security Failure Mode: Context transposition between links is rejected by AAD tag', async () => {
    const transpositionScript = `
import json, sys
from pathlib import Path
from agent_link.client import AgentLinkClient
from agent_link.crypto import AgentKeypair

alice_kp = AgentKeypair.load('mesh-alice', directory=Path('${tempDir}') / 'mesh-alice')
bob_kp = AgentKeypair.load('mesh-bob', directory=Path('${tempDir}') / 'mesh-bob')

# Create envelope intended specifically for link_AB
env_for_ab = alice_kp.create_envelope(
    link_id='${links['link_AB']}',
    recipient_id='mesh-bob',
    peer_enc_pub_b64=bob_kp.enc_pub_b64,
    plaintext='Confidential between Alice and Bob',
    seq=1,
)

# Attacker transposes envelope to link_DA
try:
    bob_kp.open_envelope(
        link_id='${links['link_DA']}',  # Mismatched link ID
        peer_sign_pub_b64=alice_kp.sign_pub_b64,
        peer_enc_pub_b64=alice_kp.enc_pub_b64,
        envelope=env_for_ab,
    )
    sys.exit('VULNERABILITY: Transposed envelope opened successfully!')
except Exception as e:
    assert 'signature' in str(e).lower() or 'failed' in str(e).lower()
    print('TRANSPOSITION_REJECTION_OK')
`;
    const { stdout } = await runPython(['-c', transpositionScript]);
    expect(stdout).toContain('TRANSPOSITION_REJECTION_OK');
  });

  it('4. Security Failure Mode: Replayed ciphertext is rejected by sequence monotonicity', async () => {
    const replayScript = `
import json, sys, time
from pathlib import Path
from agent_link.security import ReplayProtector, AgentLinkSecurityError

protector = ReplayProtector(state_dir=Path('${tempDir}') / 'mesh-bob', agent_id='mesh-bob')
link_id = '${links['link_AB']}'

# Inbound message 1 at seq 1
protector.validate_inbound(link_id=link_id, sender_id='mesh-alice', seq=1, timestamp=time.time())

# Inbound message 2 at seq 2
protector.validate_inbound(link_id=link_id, sender_id='mesh-alice', seq=2, timestamp=time.time())

# Replay attack: Attacker re-transmits message 1 (seq 1)
try:
    protector.validate_inbound(link_id=link_id, sender_id='mesh-alice', seq=1, timestamp=time.time())
    sys.exit('VULNERABILITY: Replay of seq 1 accepted!')
except AgentLinkSecurityError as e:
    assert 'replay' in str(e).lower()
    print('REPLAY_REJECTION_OK')
`;
    const { stdout } = await runPython(['-c', replayScript]);
    expect(stdout).toContain('REPLAY_REJECTION_OK');
  });

  it('5. Security Failure Mode: Forged signature from rogue key is rejected', async () => {
    const forgeryScript = `
import json, sys
from pathlib import Path
from agent_link.crypto import AgentKeypair
from agent_link.security import AgentLinkSecurityError

alice_kp = AgentKeypair.load('mesh-alice', directory=Path('${tempDir}') / 'mesh-alice')
bob_kp = AgentKeypair.load('mesh-bob', directory=Path('${tempDir}') / 'mesh-bob')
rogue_kp = AgentKeypair(agent_id='rogue-attacker')

# Rogue attacker creates an envelope pretending to be Alice
forged_env = rogue_kp.create_envelope(
    link_id='${links['link_AB']}',
    recipient_id='mesh-bob',
    peer_enc_pub_b64=bob_kp.enc_pub_b64,
    plaintext='Forged order: transfer funds',
    seq=1,
)
forged_env['senderId'] = 'mesh-alice'  # Spoof sender ID

# Bob checks against Alice's known public key
try:
    bob_kp.open_envelope(
        link_id='${links['link_AB']}',
        peer_sign_pub_b64=alice_kp.sign_pub_b64,  # Bob knows Alice's real signing key
        peer_enc_pub_b64=alice_kp.enc_pub_b64,
        envelope=forged_env,
    )
    sys.exit('VULNERABILITY: Forged signature was accepted!')
except AgentLinkSecurityError as e:
    assert 'signature' in str(e).lower()
    print('FORGERY_REJECTION_OK')
`;
    const { stdout } = await runPython(['-c', forgeryScript]);
    expect(stdout).toContain('FORGERY_REJECTION_OK');
  });

  it('6. Usability & Agent-Safe CLI: receive --once --json and whoami commands', async () => {
    const aliceKeyDir = path.join(tempDir, 'mesh-alice');
    
    // Test whoami --json
    const { stdout: whoamiOut } = await runCli([
      'whoami',
      '--agent-id', 'mesh-alice',
      '--server', baseUrl,
      '--api-key', apiKeys['mesh-alice'],
      '--key-dir', aliceKeyDir,
      '--json',
    ]);
    const whoamiData = JSON.parse(whoamiOut);
    expect(whoamiData.agentId).toBe('mesh-alice');
    expect(whoamiData.kid).toMatch(/^kid-mesh-alice-/);
    expect(whoamiData.registered).toBe(true);
    expect(whoamiData.activeLinksCount).toBeGreaterThanOrEqual(2); // Alice is connected to Bob and Dave

    // Test receive --once --json (clean empty inbox)
    const { stdout: receiveOut } = await runCli([
      'receive',
      '--agent-id', 'mesh-alice',
      '--server', baseUrl,
      '--api-key', apiKeys['mesh-alice'],
      '--key-dir', aliceKeyDir,
      '--timeout', '1',
      '--json',
    ]);
    const receiveData = JSON.parse(receiveOut);
    expect(receiveData.status).toBe('ok');
    expect(Array.isArray(receiveData.messages)).toBe(true);
  });

  it('7. Link Revocation: Severing Dave <-> Alice preserves remaining mesh links', async () => {
    const daveKeyDir = path.join(tempDir, 'mesh-dave');
    
    // Revoke link_DA
    const { stdout: revokeOut } = await runCli([
      'revoke',
      '--agent-id', 'mesh-dave',
      '--link-id', links['link_DA'],
      '--server', baseUrl,
      '--api-key', apiKeys['mesh-dave'],
      '--key-dir', daveKeyDir,
      '--json',
    ]);
    expect(revokeOut).toContain('"severed": true');

    // Verify link_DA is gone from server
    const getRes = await fetch(`${baseUrl}/api/links/${links['link_DA']}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(getRes.status).toBe(404);

    // Verify remaining links (AB, BC, CD) remain active and functional
    const getAbRes = await fetch(`${baseUrl}/api/links/${links['link_AB']}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(getAbRes.status).toBe(200);
    const abData = await getAbRes.json();
    expect(abData.link.status).toBe('active');
  });
});
