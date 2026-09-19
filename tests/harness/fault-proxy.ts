import * as http from 'node:http';
import { URL } from 'node:url';

export type FaultMode =
  | 'none'
  | 'drop_after_commit'  // Wait for upstream response status, then abort client socket without responding
  | 'truncate_body'      // Write status & half payload, then abort client socket
  | 'delay'              // Delay before forwarding
  | 'drop_request';      // Abort client socket before sending anything to upstream

export interface FaultConfig {
  mode: FaultMode;
  delayMs?: number;
  targetPathPrefix?: string;
}

export interface ProxyLogEntry {
  method: string;
  url: string;
  statusCode?: number;
  faultApplied?: FaultMode;
  timestamp: number;
}

export class FaultProxy {
  private server: http.Server | null = null;
  private upstreamUrl: string;
  private currentConfig: FaultConfig = { mode: 'none' };
  private history: ProxyLogEntry[] = [];

  constructor(upstreamUrl: string) {
    this.upstreamUrl = upstreamUrl.replace(/\/$/, '');
  }

  public setFault(config: FaultConfig): void {
    this.currentConfig = config;
  }

  public resetFault(): void {
    this.currentConfig = { mode: 'none' };
  }

  public getHistory(): ProxyLogEntry[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history = [];
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((clientReq, clientRes) => {
        this.handleRequest(clientReq, clientRes);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to bind FaultProxy to ephemeral port'));
        }
      });

      this.server.on('error', reject);
    });
  }

  private async handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): Promise<void> {
    const reqUrl = clientReq.url || '/';
    const matchesPrefix = !this.currentConfig.targetPathPrefix ||
      reqUrl.startsWith(this.currentConfig.targetPathPrefix);

    const activeMode = matchesPrefix ? this.currentConfig.mode : 'none';

    if (activeMode === 'drop_request') {
      this.history.push({
        method: clientReq.method || 'GET',
        url: reqUrl,
        faultApplied: 'drop_request',
        timestamp: Date.now(),
      });
      clientReq.destroy();
      return;
    }

    if (activeMode === 'delay' && this.currentConfig.delayMs) {
      await new Promise((r) => setTimeout(r, this.currentConfig.delayMs));
    }

    const upstreamParsed = new URL(this.upstreamUrl);
    const headers = { ...clientReq.headers, host: upstreamParsed.host, connection: 'close' };
    const options: http.RequestOptions = {
      hostname: upstreamParsed.hostname,
      port: upstreamParsed.port,
      path: reqUrl,
      method: clientReq.method,
      headers,
      agent: false,
    };

    const upstreamReq = http.request(options, (upstreamRes) => {
      if (activeMode === 'drop_after_commit') {
        this.history.push({
          method: clientReq.method || 'GET',
          url: reqUrl,
          statusCode: upstreamRes.statusCode,
          faultApplied: 'drop_after_commit',
          timestamp: Date.now(),
        });
        // Consume upstream response so server doesn't back up, but destroy client connection
        upstreamRes.resume();
        clientRes.destroy();
        return;
      }

      if (activeMode === 'truncate_body') {
        this.history.push({
          method: clientReq.method || 'GET',
          url: reqUrl,
          statusCode: upstreamRes.statusCode,
          faultApplied: 'truncate_body',
          timestamp: Date.now(),
        });
        clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        clientRes.write('{"truncated":');
        clientRes.destroy();
        upstreamRes.resume();
        return;
      }

      this.history.push({
        method: clientReq.method || 'GET',
        url: reqUrl,
        statusCode: upstreamRes.statusCode,
        timestamp: Date.now(),
      });

      clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
      }
    });

    clientReq.pipe(upstreamReq);
  }

  public async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }
}
