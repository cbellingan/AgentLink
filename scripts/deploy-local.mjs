#!/usr/bin/env node
/**
 * AgentLink End-to-End Local CI/CD Deployment & Rollback Engine
 * 
 * Flow:
 * 1. Preflight Static Analysis & Security Auditing
 * 2. Full Test Suite (Vitest + Python CLI tests)
 * 3. Atomic Backup of Current Running Version
 * 4. Production Build (Web & Server)
 * 5. Safe Local Process Restart
 * 6. Synthetic Smoke Testing Probe
 * 7. Automated Instant Rollback on Any Verification Failure
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve('.');
const BACKUP_DIR = path.join(ROOT_DIR, '.backup', 'current');
const PID_FILE = path.join(ROOT_DIR, '.data', 'agentlink.pid');
const LOG_FILE = path.join(ROOT_DIR, '.data', 'agentlink.log');

console.log('🚀 ========================================================');
console.log('🚀 AgentLink Local CI/CD: Automated Deploy & Rollback');
console.log('🚀 ========================================================\n');

function step(name, fn) {
  console.log(`🔷 [STEP] ${name}...`);
  try {
    fn();
    console.log(`✅ [STEP PASSED] ${name}\n`);
  } catch (err) {
    console.error(`❌ [STEP FAILED] ${name}: ${err.message}\n`);
    throw err;
  }
}

function getRunningPid() {
  try {
    const lsof = execSync('lsof -t -i:3000', { encoding: 'utf8' }).trim();
    if (lsof) {
      const pids = lsof.split('\n').map(p => parseInt(p.trim(), 10)).filter(Boolean);
      return pids[0] || null;
    }
  } catch {}
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && !isNaN(pid)) return pid;
    } catch {}
  }
  return null;
}

function stopServer(pid) {
  if (!pid) return;
  console.log(`   Stopping existing server process (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  
  // Wait up to 3 seconds for port to clear
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      process.kill(pid, 0); // check if alive
      execSync('sleep 0.2');
    } catch {
      break; // process exited
    }
  }

  // Force kill if still alive
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function startServer() {
  console.log('   Starting server in background (node dist/server.mjs)...');
  const outLog = fs.openSync(LOG_FILE, 'a');
  const errLog = fs.openSync(LOG_FILE, 'a');

  const child = spawn('node', ['dist/server.mjs'], {
    detached: true,
    stdio: ['ignore', outLog, errLog],
    cwd: ROOT_DIR,
    env: { ...process.env, NODE_ENV: 'production', PORT: '3000' },
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(`   Server spawned with PID: ${child.pid}`);

  // Wait for server to become responsive
  const start = Date.now();
  let online = false;
  while (Date.now() - start < 7000) {
    try {
      execSync('curl -s http://localhost:3000/api/server-info', { stdio: 'ignore' });
      online = true;
      break;
    } catch {
      execSync('sleep 0.2');
    }
  }

  if (!online) {
    throw new Error('Server failed to respond on http://localhost:3000 within 7 seconds');
  }
  console.log('   Server is live and accepting connections on port 3000');
}

function performRollback() {
  console.error('\n🚨 ========================================================');
  console.error('🚨 INITIATING AUTOMATIC ZERO-DOWNTIME ROLLBACK!');
  console.error('🚨 ========================================================');

  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      console.error('💥 No previous backup found to restore!');
      return;
    }

    console.log('   Restoring previous build from backup...');
    if (fs.existsSync(path.join(BACKUP_DIR, 'server.mjs'))) {
      fs.copyFileSync(path.join(BACKUP_DIR, 'server.mjs'), path.join(ROOT_DIR, 'dist', 'server.mjs'));
    }
    if (fs.existsSync(path.join(BACKUP_DIR, 'bundle.js'))) {
      fs.copyFileSync(path.join(BACKUP_DIR, 'bundle.js'), path.join(ROOT_DIR, 'web', 'bundle.js'));
    }

    const currentPid = getRunningPid();
    stopServer(currentPid);
    startServer();

    console.log('   Verifying rolled-back version with smoke tests...');
    execSync('node scripts/smoke-test.mjs http://localhost:3000', { stdio: 'inherit' });
    console.log('\n✅ ROLLBACK SUCCESSFUL: System reverted to known-good operational state.');
  } catch (err) {
    console.error(`💥 Rollback failed: ${err.message}`);
  }
}

async function main() {
  try {
    // 1. Preflight Static Analysis
    step('1. Preflight Lint, Typecheck & Security Audit', () => {
      execSync('node scripts/security-auditor.mjs', { stdio: 'inherit' });
      // Validate HTML balance
      execSync(`node -e '
        const fs = require("fs");
        const html = fs.readFileSync("web/index.html", "utf8");
        const tagStack = [];
        const re = /<\\/?([a-zA-Z0-9]+)(\\s+[^>]*)?\\/?>/g;
        const selfClosing = new Set(["meta","link","img","input","br","hr"]);
        let match;
        while ((match = re.exec(html)) !== null) {
          const full = match[0];
          const tag = match[1].toLowerCase();
          if (full.endsWith("/>") || selfClosing.has(tag)) continue;
          if (full.startsWith("</")) {
            const last = tagStack.pop();
            if (last !== tag) { process.exit(1); }
          } else {
            tagStack.push(tag);
          }
        }
        if (tagStack.length > 0) process.exit(1);
      '`, { stdio: 'inherit' });
    });

    // 2. Automated Test Suites
    step('2. Unit & Integration Test Suites', () => {
      console.log('   Running Vitest test suite...');
      execSync('npm test', { stdio: 'inherit' });

      // Run Python CLI tests
      const cliDir = path.resolve('../agent-link-cli');
      if (fs.existsSync(cliDir)) {
        console.log('   Running agent-link-cli Python test suite...');
        execSync('.venv/bin/python -m unittest discover tests', { cwd: cliDir, stdio: 'inherit' });
      }
    });

    // 3. Backup Current Known-Good Deployment
    step('3. Backup Current Known-Good Binaries', () => {
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }
      const distServer = path.join(ROOT_DIR, 'dist', 'server.mjs');
      const webBundle = path.join(ROOT_DIR, 'web', 'bundle.js');
      if (fs.existsSync(distServer)) {
        fs.copyFileSync(distServer, path.join(BACKUP_DIR, 'server.mjs'));
      }
      if (fs.existsSync(webBundle)) {
        fs.copyFileSync(webBundle, path.join(BACKUP_DIR, 'bundle.js'));
      }
    });

    // 4. Production Build
    step('4. Build Web Frontend & Server Binaries', () => {
      execSync('npm run build:web', { stdio: 'inherit' });
      execSync('npm run build:server', { stdio: 'inherit' });
    });

    // 5. Safe Local Restart
    step('5. Graceful Local Process Restart', () => {
      const currentPid = getRunningPid();
      stopServer(currentPid);
      startServer();
    });

    // 6. Synthetic Smoke Testing
    step('6. Post-Deployment Synthetic Smoke Testing', () => {
      execSync('node scripts/smoke-test.mjs http://localhost:3000', { stdio: 'inherit' });
    });

    console.log('🎉 ========================================================');
    console.log('🎉 LOCAL CI/CD PIPELINE SUCCEEDED!');
    console.log('🎉 New build deployed and verified healthy on port 3000.');
    console.log('🎉 ========================================================');

  } catch (error) {
    performRollback();
    process.exit(1);
  }
}

main();
