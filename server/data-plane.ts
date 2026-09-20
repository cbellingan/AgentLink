/**
 * Autonomous Data Plane Engine for AgentLink (Feature 11)
 *
 * Implements pure message forwarding, routing checks, bounded envelope ingress,
 * queueing, leasing, acknowledgements, and dead-letter quarantine.
 *
 * ZERO dependencies on human sessions, Google OAuth, invitations, or dashboard rendering.
 * All forwarding path checks are strictly local against cached versioned policy.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { MessageSpool } from './message-spool.js';
import {
  AuthorizationPolicySnapshot,
  PolicyValidator,
} from './policy.js';

export interface DataPlaneOptions {
  spoolPath?: string;
  maxQueueDepth?: number;
  maxPayloadBytes?: number;
  initialPolicy?: AuthorizationPolicySnapshot;
  internalSecret?: string;
  onMessageForwarded?: (event: {
    linkId: string;
    senderId: string;
    targetId: string;
    seq?: number;
    payload: any;
    isOperator?: boolean;
    operatorEmail?: string;
  }) => void;
  onMessageDelivered?: (event: {
    agentId: string;
    acknowledgedIds: string[];
  }) => void;
}

export class AgentLinkDataPlane {
  public messageSpool: MessageSpool;
  public validator: PolicyValidator;
  public isReady: boolean = true;
  public isShuttingDown: boolean = false;
  public startTime: number = Date.now();
  public internalSecret: string;
  public onMessageForwarded?: (event: any) => void;
  public onMessageDelivered?: (event: any) => void;

  public metrics = {
    messagesAccepted: 0,
    messagesDelivered: 0,
    rejections: 0,
  };

  public pollWaiters: Map<string, Array<(data: { messages: any[]; leaseId: string; leaseExpiresAt: number }) => boolean>> = new Map();
  public messageQueues: Map<string, any[]> = new Map();

  private server: http.Server | null = null;
  private port: number = 0;

  constructor(options: DataPlaneOptions = {}) {
    this.messageSpool = new MessageSpool({
      spoolFilePath: options.spoolPath,
      maxQueueDepth: options.maxQueueDepth || 1000,
      maxQueueBytes: (options.maxPayloadBytes || 65536) * 100,
    });
    this.validator = new PolicyValidator(options.initialPolicy);
    this.internalSecret = options.internalSecret || process.env.DATA_PLANE_SECRET || 'secret_internal_plane_sync';
    this.onMessageForwarded = options.onMessageForwarded;
    this.onMessageDelivered = options.onMessageDelivered;
  }

  public applyPolicySnapshot(snapshot: AuthorizationPolicySnapshot): { updated: boolean; gapDetected: boolean } {
    return this.validator.updateSnapshot(snapshot);
  }

  public getHealthStatus(): {
    status: 'ok' | 'degraded' | 'failed';
    ready: boolean;
    spoolHealthy: boolean;
    policyRevision: number;
    policyStale: boolean;
    policyExpired: boolean;
    queueDepth: number;
    activeLeases: number;
    quarantinedCount: number;
    error?: string;
  } {
    const isShutdown = this.isShuttingDown || !this.isReady;
    let spoolHealthy = true;
    let spoolMetrics = { availableCount: 0, inFlightCount: 0, quarantinedCount: 0, totalBytes: 0 };

    try {
      spoolMetrics = this.messageSpool.getMetrics();
    } catch {
      spoolHealthy = false;
    }

    const policyExpired = this.validator.isExpired();
    const policyStale = this.validator.isStale();

    let status: 'ok' | 'degraded' | 'failed' = 'ok';
    let error: string | undefined = undefined;

    if (isShutdown || !spoolHealthy) {
      status = 'failed';
      error = !spoolHealthy ? 'Message spool storage failure' : 'Data plane is shutting down';
    } else if (policyExpired) {
      status = 'degraded';
      error = 'Authorization policy has expired';
    } else if (policyStale) {
      status = 'degraded';
      error = 'Authorization policy is stale (control plane refresh needed)';
    }

    return {
      status,
      ready: status === 'ok' && !isShutdown,
      spoolHealthy,
      policyRevision: this.validator.getRevision(),
      policyStale,
      policyExpired,
      queueDepth: spoolMetrics.availableCount,
      activeLeases: spoolMetrics.inFlightCount,
      quarantinedCount: spoolMetrics.quarantinedCount,
      error,
    };
  }

  public initiateShutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isReady = false;

    // Wake all long poll waiters cleanly
    for (const [_, waiters] of this.pollWaiters.entries()) {
      for (const resolver of waiters) {
        try {
          resolver({ messages: [], leaseId: '', leaseExpiresAt: 0 });
        } catch {}
      }
    }
    this.pollWaiters.clear();

    // Release all in-flight message leases back to available
    try {
      this.messageSpool.releaseAllLeases();
    } catch (err: any) {
      console.error('[DataPlane] Error releasing leases during shutdown:', err.message);
    }
  }

  public async gracefulShutdown(timeoutMs: number = 5000): Promise<void> {
    this.initiateShutdown();
    if (this.server) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { this.server?.closeAllConnections?.(); } catch {}
          resolve();
        }, timeoutMs);

        this.server!.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.server = null;
    }
  }

  public async listen(port: number = 0, host: string = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).then((handled) => {
          if (!handled) {
            this.sendJson(res, 404, { error: 'not_found', message: 'Data plane route not found' });
          }
        }).catch((err) => {
          this.sendJson(res, 500, { error: 'internal_error', message: err.message });
        });
      });

      this.server.listen(port, host, () => {
        const addr = this.server!.address() as any;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  public async close(): Promise<void> {
    await this.gracefulShutdown(1000);
  }

  /**
   * Dispatches data-plane routes. Returns true if handled, false if unhandled (e.g. for composite server).
   */
  public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const rawUrl = req.url || '/';
    const parsedUrl = rawUrl.split('?')[0];

    // 0. Data Plane Health
    if (parsedUrl === '/health' || parsedUrl === '/api/health' || parsedUrl === '/health/data-plane') {
      const health = this.getHealthStatus();
      const code = health.status === 'ok' ? 200 : 503;
      this.sendJson(res, code, {
        status: health.status,
        ready: health.ready,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        dataPlane: health,
      });
      return true;
    }

    // 0b. Operational Metrics
    if (req.method === 'GET' && (parsedUrl === '/api/metrics' || parsedUrl === '/metrics')) {
      const spoolMetrics = this.messageSpool.getMetrics();
      const health = this.getHealthStatus();
      this.sendJson(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        ready: health.ready,
        metrics: {
          messagesAccepted: this.metrics.messagesAccepted,
          messagesDelivered: this.metrics.messagesDelivered,
          rejections: this.metrics.rejections,
          activeLeases: spoolMetrics.inFlightCount,
          queueDepth: spoolMetrics.availableCount,
          quarantinedCount: spoolMetrics.quarantinedCount,
          spoolBytes: spoolMetrics.totalBytes,
          policyRevision: health.policyRevision,
        },
      });
      return true;
    }

    // 0c. Internal Policy Synchronization (POST /internal/policy)
    if (req.method === 'POST' && parsedUrl === '/internal/policy') {
      const authHeader = req.headers['x-internal-secret'] || req.headers['authorization'];
      const providedSecret = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : authHeader;

      if (providedSecret !== this.internalSecret) {
        this.sendJson(res, 401, { error: 'unauthorized', message: 'Invalid internal secret' });
        return true;
      }

      this.readJson(req, res, (body) => {
        if (!body || typeof body.revision !== 'number') {
          this.sendJson(res, 400, { error: 'invalid_policy_payload', message: 'Missing revision' });
          return;
        }
        const result = this.applyPolicySnapshot(body);
        this.sendJson(res, 200, { status: 'ok', appliedRevision: body.revision, ...result });
      });
      return true;
    }

    // 0d. Gate mutating ingress when Data Plane is shutting down or not ready (Feature 11)
    if ((this.isShuttingDown || !this.isReady) && req.method !== 'GET' && req.method !== 'OPTIONS') {
      res.setHeader('Retry-After', '1');
      this.sendJson(res, 503, {
        error: 'data_plane_unavailable',
        message: 'Data plane is currently unavailable or undergoing graceful shutdown. Retry with backoff.',
      });
      return true;
    }

    // 1. Message Ingress: POST /api/links/:id/send or /message
    if (req.method === 'POST' && parsedUrl.startsWith('/api/links/') && (parsedUrl.endsWith('/send') || parsedUrl.endsWith('/message'))) {
      const parts = parsedUrl.split('/');
      const linkId = parts[3];
      const token = this.extractToken(req);

      this.readJson(req, res, (body) => {
        const senderId = body.senderId;
        if (!senderId) {
          this.metrics.rejections++;
          this.sendJson(res, 400, { error: 'missing_sender_id', message: 'Missing senderId in payload' });
          return;
        }

        // Local policy validation (zero synchronous control plane call)
        const authCheck = this.validator.validateSendAuthorization({
          token,
          linkId,
          senderId,
        });

        if (!authCheck.allowed) {
          this.metrics.rejections++;
          if (authCheck.statusCode === 503) {
            res.setHeader('Retry-After', '2');
          }
          this.sendJson(res, authCheck.statusCode, {
            error: authCheck.error,
            message: authCheck.message,
          });
          return;
        }

        const targetId = authCheck.targetId!;
        const clientMsgId = body.msgId || (typeof body.payload === 'object' && body.payload !== null ? body.payload.msgId : undefined);
        const senderAgent = this.validator.getAgent(senderId);
        const isOperator = body.senderType === 'operator';
        const operatorEmail = isOperator ? (authCheck.humanEmail || body.operatorEmail || 'operator') : undefined;

        let spoolResult;
        try {
          spoolResult = this.messageSpool.enqueue({
            msgId: clientMsgId,
            linkId,
            senderId,
            targetId,
            senderType: isOperator ? 'operator' : 'agent',
            operatorEmail,
            senderEncPub: senderAgent?.encPub,
            senderSignPub: senderAgent?.signPub,
            senderKid: senderAgent?.kid,
            payload: body.payload,
          });
          this.metrics.messagesAccepted++;
        } catch (spoolErr: any) {
          this.metrics.rejections++;
          const status = spoolErr.statusCode || 500;
          if (spoolErr.retryAfter) {
            res.setHeader('Retry-After', String(spoolErr.retryAfter));
          }
          this.sendJson(res, status, {
            error: spoolErr.code || 'spool_error',
            message: spoolErr.message,
            retryAfter: spoolErr.retryAfter,
          });
          return;
        }

        const spooledMsg = spoolResult.message;

        const q = this.messageQueues.get(targetId) || [];
        this.messageQueues.set(targetId, q);
        q.push({
          msgId: spooledMsg.msgId,
          linkId,
          senderId,
          targetId,
          senderType: isOperator ? 'operator' : 'agent',
          operatorEmail,
          senderEncPub: senderAgent?.encPub,
          senderSignPub: senderAgent?.signPub,
          senderKid: senderAgent?.kid,
          payload: body.payload,
          timestamp: spooledMsg.enqueuedAt,
        });

        // Wake waiting long-pollers
        const waiters = this.pollWaiters.get(targetId) || [];
        if (waiters.length > 0) {
          const leaseData = this.messageSpool.lease(targetId, 50);
          if (leaseData.messages.length > 0) {
            const resolver = waiters.shift();
            if (resolver) {
              const targetQ = this.messageQueues.get(targetId);
              if (targetQ) {
                const leasedIds = new Set(leaseData.messages.map(m => m.msgId));
                this.messageQueues.set(targetId, targetQ.filter(m => !leasedIds.has(m.msgId)));
              }
              resolver(leaseData);
            }
          }
        }

        if (this.onMessageForwarded) {
          try {
            this.onMessageForwarded({
              linkId,
              senderId,
              targetId,
              seq: typeof body.payload === 'object' && body.payload !== null ? body.payload.seq : undefined,
              payload: body.payload,
              isOperator,
              operatorEmail,
            });
          } catch {}
        }

        this.sendJson(res, 200, {
          status: 'ok',
          state: 'accepted',
          accepted: true,
          delivered: false,
          msgId: spooledMsg.msgId,
          seq: typeof body.payload === 'object' && body.payload !== null ? body.payload.seq : undefined,
          duplicate: spoolResult.isDuplicate,
        });
      });
      return true;
    }

    // 2. Long-Poll Ingress: GET /api/agents/:id/poll
    if (req.method === 'GET' && parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/poll')) {
      const parts = parsedUrl.split('/');
      const agentId = parts[3];
      const token = this.extractToken(req);

      const authCheck = this.validator.validatePollAuthorization({
        token,
        agentId,
      });

      if (!authCheck.allowed) {
        this.metrics.rejections++;
        this.sendJson(res, authCheck.statusCode, {
          error: authCheck.error,
          message: authCheck.message,
        });
        return true;
      }

      let timeoutMs = 15000;
      if (req.url && req.url.includes('?')) {
        const query = new URLSearchParams(req.url.split('?')[1]);
        const t = parseInt(query.get('timeout') || '15000', 10);
        if (!isNaN(t) && t > 0) {
          timeoutMs = Math.min(t, 60000);
        }
      }

      const leaseResult = this.messageSpool.lease(agentId, 50);
      if (leaseResult.messages.length > 0) {
        const q = this.messageQueues.get(agentId);
        if (q) {
          const leasedIds = new Set(leaseResult.messages.map(m => m.msgId));
          this.messageQueues.set(agentId, q.filter(m => !leasedIds.has(m.msgId)));
        }
        if (this.onMessageDelivered) {
          try {
            this.onMessageDelivered({
              agentId,
              messages: leaseResult.messages,
              acknowledgedIds: leaseResult.messages.map(m => m.msgId),
            });
          } catch {}
        }
        this.sendJson(res, 200, {
          messages: leaseResult.messages,
          leaseId: leaseResult.leaseId,
          leaseExpiresAt: leaseResult.leaseExpiresAt,
        });
        return true;
      }

      let waiters = this.pollWaiters.get(agentId);
      if (!waiters) {
        waiters = [];
        this.pollWaiters.set(agentId, waiters);
      }

      let active = true;
      const resolver = (leaseData: { messages: any[]; leaseId: string; leaseExpiresAt: number }): boolean => {
        if (!active) return false;
        active = false;
        clearTimeout(timer);
        const idx = waiters!.indexOf(resolver);
        if (idx !== -1) waiters!.splice(idx, 1);
        const q = this.messageQueues.get(agentId);
        if (q) {
          const leasedIds = new Set(leaseData.messages.map(m => m.msgId));
          this.messageQueues.set(agentId, q.filter(m => !leasedIds.has(m.msgId)));
        }
        if (this.onMessageDelivered) {
          try {
            this.onMessageDelivered({
              agentId,
              messages: leaseData.messages,
              acknowledgedIds: leaseData.messages.map(m => m.msgId),
            });
          } catch {}
        }
        this.sendJson(res, 200, {
          messages: leaseData.messages,
          leaseId: leaseData.leaseId,
          leaseExpiresAt: leaseData.leaseExpiresAt,
        });
        return true;
      };

      const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        const idx = waiters!.indexOf(resolver);
        if (idx !== -1) waiters!.splice(idx, 1);
        this.sendJson(res, 200, { messages: [], leaseId: '', leaseExpiresAt: 0 });
      }, timeoutMs);

      waiters.push(resolver);
      req.on('close', () => {
        if (active) {
          active = false;
          clearTimeout(timer);
          const idx = waiters!.indexOf(resolver);
          if (idx !== -1) waiters!.splice(idx, 1);
        }
      });
      return true;
    }

    // 3. Message ACK: POST /api/agents/:id/ack
    if (req.method === 'POST' && parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/ack')) {
      const parts = parsedUrl.split('/');
      const agentId = parts[3];
      const token = this.extractToken(req);

      const authCheck = this.validator.validatePollAuthorization({ token, agentId });
      if (!authCheck.allowed) {
        this.metrics.rejections++;
        this.sendJson(res, authCheck.statusCode, { error: authCheck.error, message: authCheck.message });
        return true;
      }

      this.readJson(req, res, (body) => {
        const messageIds: string[] = Array.isArray(body.messageIds) ? body.messageIds : (body.msgId ? [body.msgId] : []);
        const leaseId: string | undefined = body.leaseId;

        const ackResult = this.messageSpool.ack(agentId, messageIds, leaseId);
        this.metrics.messagesDelivered += ackResult.acknowledged.length;

        if (this.onMessageDelivered) {
          try {
            this.onMessageDelivered({
              agentId,
              acknowledgedIds: ackResult.acknowledged,
            });
          } catch {}
        }

        this.sendJson(res, 200, {
          status: 'ok',
          acknowledged: ackResult.acknowledged,
          missing: ackResult.notFound,
          count: ackResult.acknowledged.length,
        });
      });
      return true;
    }

    // 4. Message NACK / Quarantine: POST /api/agents/:id/nack
    if (req.method === 'POST' && parsedUrl.startsWith('/api/agents/') && parsedUrl.endsWith('/nack')) {
      const parts = parsedUrl.split('/');
      const agentId = parts[3];
      const token = this.extractToken(req);

      const authCheck = this.validator.validatePollAuthorization({ token, agentId });
      if (!authCheck.allowed) {
        this.metrics.rejections++;
        this.sendJson(res, authCheck.statusCode, { error: authCheck.error, message: authCheck.message });
        return true;
      }

      this.readJson(req, res, (body) => {
        const messageIds: string[] = Array.isArray(body.messageIds) ? body.messageIds : (body.msgId ? [body.msgId] : []);
        const action = body.action === 'reject' ? 'reject' : 'requeue';

        const nackResult = this.messageSpool.nack(agentId, messageIds, action, body.reason);
        this.sendJson(res, 200, {
          status: 'ok',
          nacked: nackResult.nacked,
          action,
          count: nackResult.nacked.length,
        });
      });
      return true;
    }

    return false;
  }

  public extractToken(req: http.IncomingMessage): string | null {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const apiKeyHeader = req.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
      return apiKeyHeader.trim();
    }
    return null;
  }

  public sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
    if (res.headersSent) return;
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(body);
  }

  private readJson(req: http.IncomingMessage, res: http.ServerResponse, callback: (body: any) => void): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) {
        this.sendJson(res, 413, { error: 'payload_too_large', message: 'Payload exceeded maximum limit of 10MB' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        callback({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        callback(parsed);
      } catch {
        this.sendJson(res, 400, { error: 'invalid_json', message: 'Malformed JSON payload' });
      }
    });
  }
}
