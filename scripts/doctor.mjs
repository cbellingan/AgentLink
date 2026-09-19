#!/usr/bin/env node

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function run(cmd, options = {}) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', ...options }).trim() };
  } catch (err) {
    return { ok: false, error: err.message, output: (err.stdout || '').toString() };
  }
}

console.log('🩺 ========================================================');
console.log('🩺 AgentLink Environment & Configuration Doctor');
console.log('🩺 ========================================================');

let issues = 0;

// 1. Node.js Version Check
const nodeVer = process.version;
const major = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
if (major >= 18) {
  console.log(`✅ Node.js runtime: ${nodeVer} (>= v18 supported)`);
} else {
  console.error(`❌ Node.js runtime: ${nodeVer} (Node 18+ required)`);
  issues++;
}

// 2. Git Hooks Configuration Check
const hooksCheck = run('git config --local --get core.hooksPath');
if (hooksCheck.ok && hooksCheck.output === '.githooks') {
  console.log(`✅ Git hooks configured: core.hooksPath is .githooks`);
} else {
  console.warn(`⚠️  Git hooks not configured (core.hooksPath is '${hooksCheck.output || "unset"}'). Run 'npm run hooks:install'`);
  issues++;
}

// Check executable permissions on hooks
const hooks = ['pre-commit', 'pre-push', 'post-merge'];
for (const hook of hooks) {
  const hookFile = path.resolve('.githooks', hook);
  if (fs.existsSync(hookFile)) {
    try {
      fs.accessSync(hookFile, fs.constants.X_OK);
      console.log(`   ✓ Hook '.githooks/${hook}' is executable`);
    } catch {
      console.warn(`   ⚠️  Hook '.githooks/${hook}' is missing executable permission (+x)`);
      issues++;
    }
  }
}

// 3. Python 3 Runtime & CLI Checkout Check
const pyCheck = run('python3 --version');
if (pyCheck.ok) {
  console.log(`✅ Python runtime: ${pyCheck.output}`);
  // Check agent-link-cli module
  const cliDir = path.resolve('../agent-link-cli');
  const cliModuleCheck = run(`PYTHONPATH="${cliDir}" python3 -m agent_link.cli --help`);
  if (cliModuleCheck.ok) {
    console.log(`✅ agent-link-cli available and executable at ${cliDir}`);
  } else {
    console.warn(`⚠️  Could not run 'python3 -m agent_link.cli' from ${cliDir}`);
    issues++;
  }
} else {
  console.error(`❌ Python 3 runtime not found on PATH`);
  issues++;
}

// 4. Dependencies & Build Check
if (fs.existsSync('node_modules')) {
  console.log(`✅ Node modules installed`);
} else {
  console.error(`❌ node_modules missing. Run 'npm install'`);
  issues++;
}

// 5. Security Auditor Check
const auditCheck = run('node scripts/security-auditor.mjs');
if (auditCheck.ok) {
  console.log(`✅ Security auditor passed (zero secrets disclosed, gatekeeper active)`);
} else {
  console.error(`❌ Security auditor failed: ${auditCheck.output}`);
  issues++;
}

console.log('🩺 ========================================================');
if (issues === 0) {
  console.log('🎉 All environment and repository checks passed!');
  process.exit(0);
} else {
  console.warn(`⚠️  Doctor found ${issues} item(s) requiring attention.`);
  process.exit(1);
}
