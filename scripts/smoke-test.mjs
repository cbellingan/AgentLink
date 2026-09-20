#!/usr/bin/env node
/**
 * AgentLink Synthetic Smoke Test Suite
 * Used by CI/CD pipeline to verify server health, gatekeeper security,
 * endpoint serialization, Content-Length header invariants, and Python cross-runtime stability.
 */

import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';

const target = (process.argv[2] || process.env.TARGET_URL || 'http://localhost:3000').replace(/\/$/, '');
const wsTarget = `${target.replace(/^http/, 'ws')}/ws`;

console.log(`🩺 ========================================================`);
console.log(`🩺 Running Synthetic Smoke Tests against ${target}`);
console.log(`🩺 ========================================================`);

const defaultHeaders = {
  'Accept-Encoding': 'identity',
  'User-Agent': 'AgentLink-SmokeTest/1.0',
};

async function safeFetch(url, options = {}) {
  const headers = { ...defaultHeaders, ...(options.headers || {}) };
  return fetch(url, { ...options, headers });
}

function verifyHeaders(res, rawText) {
  const cType = res.headers.get('content-type') || '';
  if (!cType.includes('application/json')) {
    throw new Error(`Expected Content-Type to contain application/json, got "${cType}"`);
  }
  const encoding = res.headers.get('content-encoding');
  const cLen = res.headers.get('content-length');
  const expectedBytes = Buffer.byteLength(rawText, 'utf8');

  // When uncompressed (or when requesting Accept-Encoding: identity), Content-Length must be exact
  if (!encoding) {
    if (!cLen) {
      throw new Error('Missing explicit Content-Length header on uncompressed response');
    }
    if (parseInt(cLen, 10) !== expectedBytes) {
      throw new Error(`Content-Length mismatch: header=${cLen}, actual byteLength=${expectedBytes}`);
    }
  } else if (cLen) {
    if (parseInt(cLen, 10) <= 0) {
      throw new Error(`Invalid Content-Length on compressed stream: ${cLen}`);
    }
  }
}

async function testEndpoint(name, fn) {
  try {
    process.stdout.write(`  ▶ ${name}... `);
    await fn();
    console.log(`✅ OK`);
  } catch (err) {
    console.log(`❌ FAILED`);
    console.error(`    Error: ${err.message}`);
    throw err;
  }
}

async function run() {
  let adminToken = '';
  let sampleAgentId = '';

  // 1. Server info check & header invariant validation
  await testEndpoint('1. Server Info Endpoint & Headers (/api/server-info)', async () => {
    const res = await safeFetch(`${target}/api/server-info`);
    if (res.status !== 200) throw new Error(`Unexpected status ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!data.name || !data.version) throw new Error('Missing name or version in server-info');
  });

  // 2. Gatekeeper Security Policy (Unauthorized email must be rejected with 403 "Not enabled right now")
  await testEndpoint('2. Security Gatekeeper Enforcement (Unauthorized account)', async () => {
    const res = await safeFetch(`${target}/api/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-auth-secret': process.env.TEST_AUTH_SECRET || 'test_sec_mesh_secret_2026',
      },
      body: JSON.stringify({ email: 'intruder@example.org' }),
    });
    if (res.status === 401) {
      // In production, plain email without Google ID token is strictly rejected with 401 credential_required
      const rawText = await res.text();
      verifyHeaders(res, rawText);
      const data = JSON.parse(rawText);
      if (data.error !== 'credential_required') {
        throw new Error(`Expected 'credential_required', got '${data.error}'`);
      }
      return;
    }
    if (res.status !== 403) throw new Error(`Expected 403 or 401, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (data.message !== 'Not enabled right now') {
      throw new Error(`Expected 'Not enabled right now', got '${data.message}'`);
    }
  });

  // 3. Authorized Human Authentication
  await testEndpoint('3. Authorized Human Authentication (Admin Gatekeeper)', async () => {
    let res;
    if (process.env.ADMIN_EMAIL) {
      res = await safeFetch(`${target}/api/auth/google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-auth-secret': process.env.TEST_AUTH_SECRET || 'test_sec_mesh_secret_2026',
        },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL }),
      });
    } else {
      res = await safeFetch(`${target}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: process.env.ADMIN_PASSWORD || '',
        }),
      });
    }
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!data.authenticated || !data.token?.startsWith('sec_hum_')) {
      throw new Error('Missing valid admin session token');
    }
    adminToken = data.token;
  });

  // 4. Authenticated Fleet Agent Listing & Serialization Invariant
  await testEndpoint('4. Authenticated Fleet Agent Listing & Headers (/api/agents)', async () => {
    const res = await safeFetch(`${target}/api/agents`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!Array.isArray(data.agents)) throw new Error('Agents response is not an array');
    if (data.agents.length > 0) {
      sampleAgentId = data.agents[0].id;
    }
  });

  // 4b. Unauthenticated Query Protection: GET /api/agents & /api/links must return 401
  await testEndpoint('4b. Unauthenticated Query Protection (401 Enforced)', async () => {
    const unauthAgents = await safeFetch(`${target}/api/agents`);
    if (unauthAgents.status !== 401) throw new Error(`Expected 401 for unauthenticated /api/agents, got ${unauthAgents.status}`);
    const unauthLinks = await safeFetch(`${target}/api/links`);
    if (unauthLinks.status !== 401) throw new Error(`Expected 401 for unauthenticated /api/links, got ${unauthLinks.status}`);
    const unauthPoll = await safeFetch(`${target}/api/agents/any-agent/poll`);
    if (unauthPoll.status !== 401) throw new Error(`Expected 401 for unauthenticated /poll, got ${unauthPoll.status}`);
  });

  // 5. Single Agent Direct Lookup (/api/agents/:id)
  await testEndpoint('5. Single Agent Direct Lookup (/api/agents/:id)', async () => {
    if (!sampleAgentId) {
      // Test 404 behavior for unknown agent
      const res = await safeFetch(`${target}/api/agents/non_existent_agent_999`, {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      if (res.status !== 404) throw new Error(`Expected 404 for unknown agent, got ${res.status}`);
      return;
    }
    const res = await safeFetch(`${target}/api/agents/${sampleAgentId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!data.agent || data.agent.id !== sampleAgentId) {
      throw new Error(`Agent payload mismatch: expected ${sampleAgentId}`);
    }
  });

  // 6. Global Links Listing & Serialization Invariant (/api/links)
  await testEndpoint('6. Global Links Listing & Headers (/api/links)', async () => {
    const res = await safeFetch(`${target}/api/links`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!Array.isArray(data.links)) throw new Error('Links response is not an array');
  });

  // 7. Targeted Filtered Links Listing (/api/links?agentId=...)
  await testEndpoint('7. Filtered Links Listing (/api/links?agentId=...)', async () => {
    const filterId = sampleAgentId || 'puck';
    const res = await safeFetch(`${target}/api/links?agentId=${filterId}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const rawText = await res.text();
    verifyHeaders(res, rawText);
    const data = JSON.parse(rawText);
    if (!Array.isArray(data.links)) throw new Error('Filtered links response is not an array');
  });

  // 8. WebSocket Connectivity & Real-Time Event Bus Handshake
  await testEndpoint('8. Real-Time WebSocket Handshake & Event Bus (/ws)', async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket connection or event roundtrip timed out'));
      }, 5000);

      const ws = new WebSocket(wsTarget);
      let registered = false;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register_supervisor', token: adminToken }));
        ws.send(JSON.stringify({ type: 'ping' }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'registered') registered = true;
          if (msg.type === 'pong' && registered) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        } catch {}
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  // 9. Python Standard Library urllib / http.client Cross-Runtime Validation
  await testEndpoint('9. Python Cross-Runtime Transport Validation (urllib.request)', async () => {
    const pythonScript = `
import urllib.request, json, sys

target = "${target}"
headers = {
    "User-Agent": "AgentLink-CLI/1.0",
    "Authorization": "Bearer ${adminToken}",
}

# 1. Test /api/links with Python urllib
req = urllib.request.Request(f"{target}/api/links", headers=headers)
with urllib.request.urlopen(req, timeout=5) as resp:
    if resp.status != 200:
        sys.exit(f"Unexpected status for /api/links: {resp.status}")
    raw = resp.read()
    data = json.loads(raw.decode("utf-8"))
    if "links" not in data:
        sys.exit("Missing 'links' key in /api/links response")

# 2. Test /api/agents with Python urllib
req = urllib.request.Request(f"{target}/api/agents", headers=headers)
with urllib.request.urlopen(req, timeout=5) as resp:
    if resp.status != 200:
        sys.exit(f"Unexpected status for /api/agents: {resp.status}")
    raw = resp.read()
    data = json.loads(raw.decode("utf-8"))
    if "agents" not in data:
        sys.exit("Missing 'agents' key in /api/agents response")

print("PYTHON_TRANSPORT_OK")
`;

    try {
      const out = execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!out.includes('PYTHON_TRANSPORT_OK')) {
        throw new Error(`Python script did not report success: ${out}`);
      }
    } catch (pyErr) {
      throw new Error(`Python client validation failed: ${pyErr.stderr || pyErr.message}`);
    }
  });

  console.log(`\n🎉 ALL SYNTHETIC SMOKE TESTS PASSED!`);
}

run().catch(() => {
  console.error(`\n💥 Smoke testing encountered fatal errors.`);
  process.exit(1);
});
