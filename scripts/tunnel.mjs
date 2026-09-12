#!/usr/bin/env node
/**
 * AgentLink Cloudflare Tunnel Runner
 * Spawns a secure Cloudflare Tunnel using your permanent Zero Trust tunnel token,
 * or falls back to an ad-hoc quick tunnel.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Load .env if present
try {
  if (fs.existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch {}

const token = process.env.CLOUDFLARE_TUNNEL_TOKEN || process.argv[2];
const localPort = process.env.PORT || 3000;
const localUrl = `http://localhost:${localPort}`;

console.log('🌐 ========================================================');
if (token) {
  console.log('🌐 Starting Cloudflare Named Tunnel with saved token...');
} else {
  console.log(`🌐 Starting Ad-Hoc Cloudflare Quick Tunnel pointing to ${localUrl}...`);
}
console.log('🌐 ========================================================\n');

const args = token
  ? ['tunnel', 'run', '--token', token]
  : ['tunnel', '--url', localUrl];

const child = spawn('cloudflared', args);

child.stdout.on('data', (data) => {
  const text = data.toString();
  process.stdout.write(text);
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  if (text.includes('Registered tunnel connection') || text.includes('Connection registered') || text.includes('Connected to ')) {
    console.log('\n🚀 ========================================================');
    console.log('🚀 CLOUDFLARE NAMED TUNNEL CONNECTED TO CLOUDFLARE EDGE!');
    console.log('🚀 Routing remote requests to http://localhost:' + localPort);
    console.log('🚀 ========================================================\n');
  } else if (text.includes('trycloudflare.com')) {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      console.log('\n🚀 Public HTTPS URL: ' + match[0]);
    }
  } else {
    process.stderr.write(text);
  }
});

child.on('close', (code) => {
  console.log(`\n[Cloudflare Tunnel] Process exited with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('\n[Cloudflare Tunnel] Shutting down tunnel...');
  child.kill('SIGTERM');
  process.exit(0);
});
