import { AgentLinkServer } from './agent-link-server.js';
import path from 'node:path';

// Environment-driven port allocation:
// Production (Holy): 3000 (connected to Cloudflare Tunnel agent.signetmesh.com)
// Development / Test: 3001
const defaultPort = (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') ? 3001 : 3000;
const port = parseInt(process.env.PORT || String(defaultPort), 10);
const staticPath = process.env.STATIC_PATH || path.resolve('web');
const server = new AgentLinkServer(port, staticPath);

server.listen().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
