#!/usr/bin/env node
/**
 * Direct Bug Report Inspector
 * Reads canonical bug reports directly from disk without searching.
 */
import fs from 'node:fs';
import path from 'node:path';

const bugId = process.argv[2];
const bugLogPath = process.env.BUG_LOG_PATH
  ? path.resolve(process.env.BUG_LOG_PATH)
  : path.resolve('.data/bugs/bug-reports.jsonl');

if (!fs.existsSync(bugLogPath)) {
  console.error(`❌ Bug log file not found at: ${bugLogPath}`);
  process.exit(1);
}

const lines = fs.readFileSync(bugLogPath, 'utf8').split('\n').filter(Boolean);
const bugs = lines.map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

if (!bugId) {
  console.log(`📋 Total bug reports on disk: ${bugs.length}`);
  console.log(`📁 Source: ${bugLogPath}\n`);
  console.log('Recent reports:');
  bugs.slice(-10).reverse().forEach(b => {
    const status = b.resolved ? '✅ RESOLVED' : '🚨 OPEN';
    console.log(`  • ${b.id} [${(b.severity || 'INFO').toUpperCase()}] ${status} - ${b.title}`);
  });
  console.log('\nUsage: node scripts/get-bug.mjs <bugId>');
  process.exit(0);
}

const bug = bugs.find(b => b.id === bugId || b.id.includes(bugId));
if (!bug) {
  console.error(`❌ Bug report '${bugId}' not found in ${bugLogPath}`);
  process.exit(1);
}

console.log(JSON.stringify(bug, null, 2));
