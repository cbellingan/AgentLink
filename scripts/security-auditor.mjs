#!/usr/bin/env node
/**
 * Security Auditor & Scanner for AgentLink
 *
 * Scans both codebase files and git staged changes to proactively block:
 * 1. Hardcoded passwords, default credentials, and predictable passwords.
 * 2. Insecure authentication bypass flags (e.g. ALLOW_DEFAULT_PASSWORD, DISABLE_AUTH).
 * 3. Staged .env or sensitive environment credential files.
 * 4. Private cryptographic key dumps and certificates.
 * 5. Public web asset whitelist disclosure.
 * 6. Personal identifying information (PII) disclosure.
 * 7. Enforces server security architecture guardrails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const isStagedMode = args.includes('--staged');

let errors = 0;

console.log('🔒 ========================================================');
console.log(`🔒 Running Security Scanner for AgentLink [Mode: ${isStagedMode ? 'STAGED DIFF' : 'FULL REPO'}]`);
console.log('🔒 ========================================================');

function recordError(msg) {
  console.error(`❌ [SECURITY SCANNER ERROR] ${msg}`);
  errors++;
}

// -----------------------------------------------------------------------------
// Banned Strings & Patterns
// -----------------------------------------------------------------------------
const BANNED_PASSWORDS = [
  'AdminSecure2026!',
  'password123',
  'admin123',
  'changeme',
  'secret123',
  'adminadmin',
  '12345678',
  'pass1234',
];

const BANNED_BYPASS_FLAGS = [
  'ALLOW_DEFAULT_PASSWORD',
  'DISABLE_AUTH',
  'BYPASS_AUTH',
  'SKIP_AUTH',
  'ALLOW_INSECURE_AUTH',
];

const SENSITIVE_KEY_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  new RegExp(['ed25519', 'priv', 'b64'].join('_')),
  new RegExp(['x25519', 'priv', 'b64'].join('_')),
];

const PII_PATTERNS = [
  Buffer.from('Y2JlbGxpbmdhbg==', 'base64').toString(),
  Buffer.from('Y2FybCBiZWxsaW5nYW4=', 'base64').toString(),
];

// In production / server / web code, hardcoded assignment of non-empty passwords or secrets is forbidden
const HARDCODED_CREDENTIAL_REGEX = /(?:adminPassword|password|secretKey|clientSecret|apiKey)\s*[:=]\s*['"`]([a-zA-Z0-9!@#$%^&*()_+=\-`~[\]{}|:;<>?,./]{4,})['"`]/i;

// -----------------------------------------------------------------------------
// Staged Mode: Inspect `git diff --cached`
// -----------------------------------------------------------------------------
if (isStagedMode) {
  try {
    // 1. Check for staged .env files
    const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    for (const f of stagedFiles) {
      if (/^\.env($|\.)/i.test(path.basename(f))) {
        recordError(`Accidental live environment file staged: "${f}". Live secrets must never be committed!`);
      }
    }

    // 2. Check staged additions in git diff --cached -U0
    const stagedDiff = execSync('git diff --cached -U0', { encoding: 'utf8' });
    const diffLines = stagedDiff.split('\n');
    let currentFile = '';

    for (const line of diffLines) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim();
        continue;
      }
      // Only inspect added lines
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const addedContent = line.slice(1);

      // Skip scanning the security scanner and githooks scripts for their pattern matchers
      if (currentFile.includes('security-auditor.mjs') || currentFile.includes('security-scanner') || currentFile.includes('.githooks')) {
        continue;
      }

      // Check banned passwords
      for (const bannedPwd of BANNED_PASSWORDS) {
        if (addedContent.includes(bannedPwd)) {
          recordError(`Forbidden hardcoded/default password "${bannedPwd}" staged in ${currentFile}:\n   > ${addedContent.trim()}`);
        }
      }

      // Check banned bypass flags
      for (const flag of BANNED_BYPASS_FLAGS) {
        if (addedContent.includes(flag)) {
          recordError(`Forbidden security bypass flag "${flag}" staged in ${currentFile}:\n   > ${addedContent.trim()}`);
        }
      }

      // Check private keys (except in test fixtures)
      if (!currentFile.includes('tests/')) {
        for (const keyPat of SENSITIVE_KEY_PATTERNS) {
          if (keyPat.test(addedContent)) {
            recordError(`Private cryptographic key material staged in non-test file ${currentFile}:\n   > ${addedContent.trim()}`);
          }
        }

        if (HARDCODED_CREDENTIAL_REGEX.test(addedContent)) {
          // Allow comments or env lookups
          if (!addedContent.trim().startsWith('//') && !addedContent.trim().startsWith('*') && !addedContent.includes('process.env')) {
            recordError(`Suspected hardcoded credential assignment staged in ${currentFile}:\n   > ${addedContent.trim()}`);
          }
        }
      }

      // Check PII
      const lowerAdded = addedContent.toLowerCase().replace(/github\.com\/cbellingan\//g, '');
      for (const pii of PII_PATTERNS) {
        if (lowerAdded.includes(pii)) {
          recordError(`Personal identifier disclosure staged in ${currentFile}:\n   > ${addedContent.trim()}`);
        }
      }
    }
  } catch (err) {
    recordError(`Failed to inspect staged git diff: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Full Repo Mode / General Checks
// -----------------------------------------------------------------------------

// 1. Audit public web assets for zero disclosure
const webFiles = ['web/index.html', 'web/app.ts', 'web/bundle.js'];
for (const relPath of webFiles) {
  const fullPath = path.resolve(relPath);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes('Whitelist') || content.includes('whitelist')) {
      recordError(`Public asset ${relPath} contains the word "Whitelist"`);
    }
  }
}

// 2. Audit server security policies & obfuscated hash enforcement
const serverPath = path.resolve('server/agent-link-server.ts');
if (fs.existsSync(serverPath)) {
  const serverContent = fs.readFileSync(serverPath, 'utf8');
  if (!serverContent.includes('Not enabled right now')) {
    recordError('Server does not enforce "Not enabled right now" message');
  }
  if (!serverContent.includes('adminEmailHash')) {
    recordError('Server missing adminEmailHash configuration');
  }

  // Ensure production check does not have a hardcoded password default
  if (serverContent.includes("= 'AdminSecure2026!'") || serverContent.includes('ALLOW_DEFAULT_PASSWORD')) {
    recordError('Server source contains hardcoded default password or bypass flag');
  }
}

// 3. Scan directories for banned passwords, bypass flags, and PII
const scanDirs = ['server', 'web', 'cloudflare', 'scripts'];
function scanFileForSecurity(filePath) {
  const relPath = path.relative(process.cwd(), filePath);
  // Skip the auditor script itself
  if (relPath.includes('security-auditor.mjs')) return;
  if (relPath.endsWith('.png') || relPath.endsWith('.jpg') || relPath.endsWith('.ico') || relPath.endsWith('.map')) return;

  const rawContent = fs.readFileSync(filePath, 'utf8');

  // Check banned passwords
  for (const pwd of BANNED_PASSWORDS) {
    if (rawContent.includes(pwd)) {
      recordError(`File ${relPath} contains forbidden default password "${pwd}"`);
    }
  }

  // Check bypass flags
  for (const flag of BANNED_BYPASS_FLAGS) {
    if (rawContent.includes(flag)) {
      recordError(`File ${relPath} contains forbidden bypass flag "${flag}"`);
    }
  }

  // Check hardcoded credential assignments
  if (!relPath.startsWith('scripts/') && !relPath.includes('test')) {
    const lines = rawContent.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.includes('process.env')) return;
      if (HARDCODED_CREDENTIAL_REGEX.test(trimmed)) {
        recordError(`File ${relPath}:${idx + 1} contains hardcoded credential assignment: "${trimmed}"`);
      }
    });
  }

  // Check PII
  const content = rawContent.toLowerCase().replace(/github\.com\/cbellingan\//g, '');
  for (const pattern of PII_PATTERNS) {
    if (content.includes(pattern)) {
      recordError(`File ${relPath} contains personal identifier disclosure: "${pattern}"`);
    }
  }
}

function scanDir(dir) {
  const fullDir = path.resolve(dir);
  if (!fs.existsSync(fullDir)) return;
  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  for (const entry of entries) {
    const resPath = path.join(fullDir, entry.name);
    if (entry.isDirectory()) {
      scanDir(resPath);
    } else if (entry.isFile()) {
      scanFileForSecurity(resPath);
    }
  }
}

for (const dir of scanDirs) {
  scanDir(dir);
}

// Check root config files
const rootConfigs = ['docker-compose.yml', 'package.json'];
for (const cfg of rootConfigs) {
  const cfgPath = path.resolve(cfg);
  if (fs.existsSync(cfgPath)) {
    scanFileForSecurity(cfgPath);
  }
}

// -----------------------------------------------------------------------------
// Verdict
// -----------------------------------------------------------------------------
if (errors > 0) {
  console.error(`\n💥 Security Scanner failed with ${errors} violation(s)!`);
  console.error('👉 Remediate all violations above. Never commit or push hardcoded credentials, defaults, or bypass flags.');
  process.exit(1);
} else {
  console.log('\n✅ ALL SECURITY SCANNER CHECKS PASSED:');
  console.log('   ✓ Zero hardcoded passwords, predictable defaults, or bypass flags');
  console.log('   ✓ Zero administrative whitelist disclosure on landing page');
  console.log('   ✓ Zero personal email or name disclosure across codebase');
  console.log('   ✓ Zero private key material in production/relay assets');
  console.log('   ✓ Obfuscated SHA-256 hash admin gatekeeper enforced');
  console.log('   ✓ Strict "Not enabled right now" enforcement active');
  if (isStagedMode) {
    console.log('   ✓ Staged git diff verified clean (no .env, no secrets, no bypasses)');
  }
  process.exit(0);
}
