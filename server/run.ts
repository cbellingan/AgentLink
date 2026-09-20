import { AgentLinkServer } from './agent-link-server.js';
import path from 'node:path';

// Environment-driven port allocation:
// Default: 3000 (standard portal port)
// Development / Test: 3001
const defaultPort = (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') ? 3001 : 3000;
const port = parseInt(process.env.PORT || String(defaultPort), 10);
const staticPath = process.env.STATIC_PATH || path.resolve('web');
const server = new AgentLinkServer(port, staticPath);

const bindHost = process.env.BIND_HOST || undefined;
server.listen(bindHost).catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

let isStopping = false;
const handleSignal = async (signal: string) => {
  if (isStopping) return;
  isStopping = true;
  console.log(`\n[AgentLink Server] Received ${signal}. Initiating graceful shutdown...`);
  try {
    await server.gracefulShutdown(5000);
    console.log('[AgentLink Server] Graceful shutdown complete. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('[AgentLink Server] Error during graceful shutdown:', err.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
