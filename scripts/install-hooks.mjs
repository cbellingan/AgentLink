#!/usr/bin/env node

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

console.log('🔧 [AgentLink] Installing tracked Git hooks (.githooks)...');

try {
  let currentHooksPath = '';
  try {
    currentHooksPath = run('git config --local --get core.hooksPath');
  } catch {
    // Not set
  }

  if (currentHooksPath && currentHooksPath !== '.githooks') {
    console.warn(`⚠️  Existing core.hooksPath detected: '${currentHooksPath}'`);
    console.warn(`    Integrating with .githooks...`);
  }

  run('git config --local core.hooksPath .githooks');

  // Ensure hooks are executable
  const hooksDir = path.resolve('.githooks');
  if (fs.existsSync(hooksDir)) {
    const files = fs.readdirSync(hooksDir);
    for (const file of files) {
      const fullPath = path.join(hooksDir, file);
      if (fs.statSync(fullPath).isFile()) {
        try {
          fs.chmodSync(fullPath, 0o755);
        } catch {
          // Best effort
        }
      }
    }
  }

  console.log('✅ Git hooks successfully configured: core.hooksPath = .githooks');
} catch (err) {
  console.error('❌ Failed to configure Git hooks:', err.message);
  process.exit(1);
}
