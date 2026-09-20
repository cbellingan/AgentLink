#!/usr/bin/env node
/**
 * AgentLink Production Start Script
 * 
 * Boots AgentLink in production mode:
 * - Loads environment variables from .env
 * - Ensures compiled server binary (dist/server.mjs) exists
 * - Gracefully terminates any existing process holding the port
 * - Spawns server in production mode
 * - Validates local endpoint responsiveness
 * - Checks/starts Cloudflare Tunnel if token is configured
 * - Inspects Google Identity Services (GSI) / Auth gate configuration
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

// Feature 7.1: SignetMesh is the authoritative production deployment layer
const siblingSignetMesh = path.resolve(ROOT_DIR, '..', 'SignetMesh');
if (fs.existsSync(siblingSignetMesh) && !process.env.AGENTLINK_STANDALONE) {
  console.log('📌 Notice: SignetMesh is the authoritative production deployment layer for this mesh.');
  console.log(`   Delegating to: node ${path.join(siblingSignetMesh, 'scripts', 'start-production.mjs')}\n`);
  const res = spawnSync('node', [path.join(siblingSignetMesh, 'scripts', 'start-production.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: siblingSignetMesh,
  });
  process.exit(res.status ?? 0);
}

const DATA_DIR = path.join(ROOT_DIR, '.data');
const PID_FILE = path.join(DATA_DIR, 'agentlink.pid');
const LOG_FILE = path.join(DATA_DIR, 'agentlink.log');
const TUNNEL_PID_FILE = path.join(DATA_DIR, 'tunnel.pid');
const TUNNEL_LOG_FILE = path.join(DATA_DIR, 'tunnel.log');

// Ensure data directory
fs.mkdirSync(DATA_DIR, { recursive: true });

// Load .env
if (fs.existsSync(path.join(ROOT_DIR, '.env'))) {
  try {
    process.loadEnvFile(path.join(ROOT_DIR, '.env'));
  } catch (err) {
    console.warn('⚠️ Could not load .env:', err.message);
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const PORTAL_URL = process.env.PORTAL_URL || `http://localhost:${PORT}`;
const BRAND_NAME = process.env.BRAND_NAME || 'AgentLink';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLOUDFLARE_TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN || '';

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log(`║ 🚀 Starting ${BRAND_NAME.padEnd(52)} ║`);
console.log('║    Zero-Knowledge Autonomous Agent Mesh Production Server        ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// 1. Build Verification
function ensureBuild() {
  const serverPath = path.join(ROOT_DIR, 'dist', 'server.mjs');
  const webPath = path.join(ROOT_DIR, 'web', 'bundle.js');
  if (!fs.existsSync(serverPath) || !fs.existsSync(webPath)) {
    console.log('⚙️ Building production bundles (server & web)...');
    execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });
  } else {
    console.log('✓ Production binaries verified:', serverPath);
  }
}

// 2. Clear Port
function clearPort() {
  console.log(`🔍 Checking port ${PORT}...`);
  try {
    const lsof = execSync(`lsof -t -i:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    if (lsof) {
      const pids = lsof.split('\n').map(p => parseInt(p.trim(), 10)).filter(Boolean);
      for (const pid of pids) {
        console.log(`   Terminating existing listener on port ${PORT} (PID: ${pid})...`);
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      execSync('sleep 1');
    }
  } catch {}
}

// 3. Spawn Server
function startServer() {
  console.log(`🚀 Spawning ${BRAND_NAME} server on port ${PORT}...`);
  const outLog = fs.openSync(LOG_FILE, 'a');
  const errLog = fs.openSync(LOG_FILE, 'a');
  const statePath = path.join(DATA_DIR, 'prod', 'agent-link-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    PORTAL_URL,
    BRAND_NAME,
    DATA_PATH: statePath,
  };

  const child = spawn('node', ['dist/server.mjs'], {
    detached: true,
    stdio: ['ignore', outLog, errLog],
    cwd: ROOT_DIR,
    env,
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(`   Server spawned with PID: ${child.pid}`);

  // Wait for health check
  const start = Date.now();
  let online = false;
  while (Date.now() - start < 7000) {
    try {
      const res = execSync(`curl -s http://localhost:${PORT}/api/server-info`, { encoding: 'utf8' });
      const parsed = JSON.parse(res);
      if (parsed.brandName) {
        online = true;
        break;
      }
    } catch {}
    execSync('sleep 0.3');
  }

  if (!online) {
    throw new Error(`Server failed to respond on http://localhost:${PORT}/api/server-info within 7 seconds. Check ${LOG_FILE}`);
  }

  console.log(`   ✓ Local server online and healthy at http://localhost:${PORT}`);
  return child.pid;
}

// 4. Tunnel check
function checkTunnel() {
  if (!CLOUDFLARE_TUNNEL_TOKEN) {
    console.log('ℹ️ No CLOUDFLARE_TUNNEL_TOKEN configured. Operating in local mode.');
    return;
  }

  console.log('\n🔒 Checking Cloudflare Zero Trust Named Tunnel...');
  let haConnections = 0;
  try {
    const metrics = execSync('curl -s http://127.0.0.1:20241/metrics', { encoding: 'utf8' });
    const match = metrics.match(/cloudflared_tunnel_ha_connections\s+(\d+)/);
    if (match) haConnections = parseInt(match[1], 10);
  } catch {}

  if (haConnections > 0) {
    console.log(`   ✓ Cloudflare Named Tunnel active with ${haConnections} redundant HA edge connections.`);
  } else {
    console.log('   Starting Cloudflare Tunnel daemon...');
    const outLog = fs.openSync(TUNNEL_LOG_FILE, 'a');
    const errLog = fs.openSync(TUNNEL_LOG_FILE, 'a');

    const child = spawn('cloudflared', ['tunnel', 'run', '--token', CLOUDFLARE_TUNNEL_TOKEN], {
      detached: true,
      stdio: ['ignore', outLog, errLog],
      cwd: ROOT_DIR,
    });
    child.unref();
    fs.writeFileSync(TUNNEL_PID_FILE, String(child.pid), 'utf8');

    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        const metrics = execSync('curl -s http://127.0.0.1:20241/metrics', { encoding: 'utf8' });
        const match = metrics.match(/cloudflared_tunnel_ha_connections\s+(\d+)/);
        if (match && parseInt(match[1], 10) > 0) {
          console.log(`   ✓ Cloudflare Tunnel connected! Active HA connections: ${match[1]}`);
          break;
        }
      } catch {}
      execSync('sleep 0.5');
    }
  }

  // Edge probe if PORTAL_URL is remote
  if (PORTAL_URL.startsWith('https://')) {
    try {
      const res = execSync(`curl -s --max-time 5 ${PORTAL_URL}/api/server-info`, { encoding: 'utf8' });
      const parsed = JSON.parse(res);
      console.log(`   ✓ Edge endpoint verified: [${parsed.brandName}] ${PORTAL_URL}`);
    } catch {
      console.warn(`   ⚠️ Edge probe to ${PORTAL_URL} pending or unverified.`);
    }
  }
}

// 5. Auth gate check
function checkAuth() {
  console.log('\n🔑 Authentication Configuration:');
  if (GOOGLE_CLIENT_ID) {
    console.log(`   • Google Identity Services: ACTIVE (Audience: ${GOOGLE_CLIENT_ID})`);
  } else {
    console.log('   • Google Identity Services: UNCONFIGURED (Using fallback password authentication)');
    console.log('     To configure Google Sign-In, provide GOOGLE_CLIENT_ID in .env');
  }

  const hashes = (process.env.AUTHORIZED_EMAIL_HASHES || '').split(',').filter(Boolean);
  console.log(`   • Registered Operator Hashes: ${hashes.length}`);
}

async function main() {
  try {
    ensureBuild();
    clearPort();
    const pid = startServer();
    checkTunnel();
    checkAuth();

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log(`✨ ${BRAND_NAME} IS RUNNING IN PRODUCTION MODE`);
    console.log(`   • Local Address:    http://localhost:${PORT}`);
    console.log(`   • Portal URL:       ${PORTAL_URL}`);
    console.log(`   • Server PID:       ${pid}`);
    console.log(`   • Logs:             ${LOG_FILE}`);
    console.log('══════════════════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error(`\n❌ Failed to start production server: ${err.message}`);
    process.exit(1);
  }
}

main();
