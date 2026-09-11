import { AgentLinkServer } from './agent-link-server.js';
import path from 'node:path';

const port = parseInt(process.env.PORT || '3000', 10);
const staticPath = process.env.STATIC_PATH || path.resolve('web');
const server = new AgentLinkServer(port, staticPath);

server.listen().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
