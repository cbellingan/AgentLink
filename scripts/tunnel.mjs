#!/usr/bin/env node
/**
 * AgentLink Cloudflare Tunnel Runner
 * Spawns a secure Cloudflare Tunnel forwarding public traffic to http://localhost:3000.
 */

import { spawn } from 'node:child_process';

const localPort = process.env.PORT || 3000;
const localUrl = `http://localhost:${localPort}`;

console.log('🌐 ========================================================');
console.log(`🌐 Starting Cloudflare Tunnel pointing to ${localUrl}...`);
console.log('🌐 ========================================================\n');

const child = spawn('cloudflared', ['tunnel', '--url', localUrl]);

let tunnelUrlFound = false;

function processOutput(data) {
  const text = data.toString();
  // Match standard trycloudflare.com URL pattern
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match && !tunnelUrlFound) {
    tunnelUrlFound = true;
    const url = match[0];
    console.log('🚀 ========================================================');
    console.log(`🚀 CLOUDFLARE TUNNEL LIVE!`);
    console.log(`🚀 Public HTTPS URL: \x1b[32m\x1b[1m${url}\x1b[0m`);
    console.log('🚀 ========================================================');
    console.log(`\nYour AgentLink server is now securely accessible worldwide.`);
    console.log(`• Web Dashboard: ${url}`);
    console.log(`• Connect Agents: python3 cli.py connect --server "${url}" --api-key <YOUR_KEY> --agent-id my-agent\n`);
  }
}

child.stdout.on('data', processOutput);
child.stderr.on('data', processOutput);

child.on('close', (code) => {
  console.log(`\n[Cloudflare Tunnel] Process exited with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('\n[Cloudflare Tunnel] Shutting down tunnel...');
  child.kill('SIGTERM');
  process.exit(0);
});
