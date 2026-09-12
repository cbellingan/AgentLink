#!/usr/bin/env node
/**
 * AgentLink Synthetic Smoke Test Suite
 * Used by CI/CD pipeline to verify server health, gatekeeper security, and WebSocket stability.
 */

import { WebSocket } from 'ws';

const target = process.argv[2] || process.env.TARGET_URL || 'http://localhost:3000';
const wsTarget = `${target.replace(/^http/, 'ws')}/ws`;

console.log(`🩺 ========================================================`);
console.log(`🩺 Running Synthetic Smoke Tests against ${target}`);
console.log(`🩺 ========================================================`);

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

  // 1. Server info check
  await testEndpoint('1. Server Info Endpoint (/api/server-info)', async () => {
    const res = await fetch(`${target}/api/server-info`);
    if (res.status !== 200) throw new Error(`Unexpected status ${res.status}`);
    const data = await res.json();
    if (!data.name || !data.version) throw new Error('Missing name or version in server-info');
  });

  // 2. Gatekeeper Security Policy (Unauthorized email must be rejected with 403 "Not enabled right now")
  await testEndpoint('2. Security Gatekeeper Enforcement (Unauthorized account)', async () => {
    const res = await fetch(`${target}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@example.org' }),
    });
    if (res.status !== 403) throw new Error(`Expected 403, got ${res.status}`);
    const data = await res.json();
    if (data.message !== 'Not enabled right now') {
      throw new Error(`Expected 'Not enabled right now', got '${data.message}'`);
    }
  });

  // 3. Authorized Human Login (Carl Bellingan)
  await testEndpoint('3. Authorized Human Authentication (Carl Bellingan)', async () => {
    const res = await fetch(`${target}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cbellingan@gmail.com' }),
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const data = await res.json();
    if (!data.authenticated || !data.token?.startsWith('sec_hum_')) {
      throw new Error('Missing valid admin session token');
    }
    adminToken = data.token;
  });

  // 4. Authenticated Fleet API Check
  await testEndpoint('4. Authenticated Fleet Agent Listing', async () => {
    const res = await fetch(`${target}/api/agents`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.agents)) throw new Error('Agents response is not an array');
  });

  // 5. WebSocket Connectivity & Frame Relay Handshake
  await testEndpoint('5. Real-Time WebSocket Handshake', async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket connection timed out'));
      }, 4000);

      const ws = new WebSocket(wsTarget);
      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  console.log(`\n🎉 ALL SYNTHETIC SMOKE TESTS PASSED!`);
}

run().catch(() => {
  console.error(`\n💥 Smoke testing encountered fatal errors.`);
  process.exit(1);
});
