import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type MessageDeliveryState =
  | 'available'
  | 'in_flight'
  | 'acknowledged'
  | 'expired'
  | 'rejected'
  | 'revoked';

export interface SpoolEnvelopeInput {
  msgId?: string;
  linkId: string;
  senderId: string;
  targetId: string;
  senderType?: 'agent' | 'operator';
  operatorEmail?: string;
  senderEncPub?: string;
  senderSignPub?: string;
  senderKid?: string;
  payload: any;
}

export interface SpoolMessageEntry {
  msgId: string;
  linkId: string;
  senderId: string;
  targetId: string;
  senderType: 'agent' | 'operator';
  operatorEmail?: string;
  senderEncPub?: string;
  senderSignPub?: string;
  senderKid?: string;
  payload: any;
  payloadHash: string;
  state: MessageDeliveryState;
  enqueuedAt: string;
  timestamp?: string;
  leaseId?: string;
  leaseExpiresAt?: number;
  attempts: number;
  acknowledgedAt?: string;
}

export interface MessageSpoolOptions {
  spoolFilePath?: string;
  maxQueueDepth?: number;         // default 1000 messages per recipient
  maxQueueBytes?: number;         // default 10MB per recipient
  defaultLeaseDurationMs?: number;// default 30,000ms (30s)
  retentionMs?: number;           // default 7 days
}

export class MessageSpool {
  private spoolFilePath: string;
  private maxQueueDepth: number;
  private maxQueueBytes: number;
  private defaultLeaseDurationMs: number;
  private retentionMs: number;

  private messagesByMsgId: Map<string, SpoolMessageEntry> = new Map();
  private recipientQueues: Map<string, string[]> = new Map(); // targetId -> Array<msgId>
  private acknowledgedMsgIds: Map<string, { payloadHash: string; targetId: string; timestamp: number }> = new Map();

  constructor(options: MessageSpoolOptions = {}) {
    this.spoolFilePath = options.spoolFilePath || path.resolve(process.cwd(), 'messages-spool.json');
    this.maxQueueDepth = options.maxQueueDepth || 1000;
    this.maxQueueBytes = options.maxQueueBytes || 10 * 1024 * 1024; // 10MB
    this.defaultLeaseDurationMs = options.defaultLeaseDurationMs || 30_000;
    this.retentionMs = options.retentionMs || 7 * 24 * 60 * 60 * 1000;

    this.load();
  }

  private hashPayload(payload: any): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  public enqueue(input: SpoolEnvelopeInput): { isDuplicate: boolean; message: SpoolMessageEntry } {
    const msgId = input.msgId && input.msgId.trim()
      ? input.msgId.trim()
      : `msg_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

    const payloadHash = this.hashPayload(input.payload);

    // 1. Check idempotency against active messages
    const existing = this.messagesByMsgId.get(msgId);
    if (existing) {
      if (existing.payloadHash === payloadHash && existing.targetId === input.targetId) {
        return { isDuplicate: true, message: existing };
      }
      const err: any = new Error(`Conflicting msgId reuse with different payload or target: ${msgId}`);
      err.statusCode = 409;
      err.code = 'idempotency_conflict';
      throw err;
    }

    // 2. Check idempotency against recently acknowledged messages
    const acked = this.acknowledgedMsgIds.get(msgId);
    if (acked) {
      if (acked.payloadHash === payloadHash && acked.targetId === input.targetId) {
        // Synthesize an acknowledged message entry for idempotent return
        return {
          isDuplicate: true,
          message: {
            msgId,
            linkId: input.linkId,
            senderId: input.senderId,
            targetId: input.targetId,
            senderType: input.senderType || 'agent',
            operatorEmail: input.operatorEmail,
            payload: input.payload,
            payloadHash,
            state: 'acknowledged',
            enqueuedAt: new Date(acked.timestamp).toISOString(),
            attempts: 1,
            acknowledgedAt: new Date(acked.timestamp).toISOString(),
          },
        };
      }
      const err: any = new Error(`Conflicting msgId reuse with different payload (already acknowledged): ${msgId}`);
      err.statusCode = 409;
      err.code = 'idempotency_conflict';
      throw err;
    }

    // 3. Check queue limits (backpressure)
    const queue = this.recipientQueues.get(input.targetId) || [];
    const activeMsgIds = queue.filter(id => {
      const m = this.messagesByMsgId.get(id);
      return m && (m.state === 'available' || m.state === 'in_flight');
    });

    if (activeMsgIds.length >= this.maxQueueDepth) {
      const err: any = new Error(`Recipient queue depth limit exceeded (${this.maxQueueDepth} messages)`);
      err.statusCode = 429;
      err.code = 'queue_full';
      err.retryAfter = 10;
      throw err;
    }

    let currentBytes = 0;
    for (const id of activeMsgIds) {
      const m = this.messagesByMsgId.get(id);
      if (m) {
        currentBytes += JSON.stringify(m.payload).length;
      }
    }
    const incomingBytes = JSON.stringify(input.payload).length;
    if (currentBytes + incomingBytes > this.maxQueueBytes) {
      const err: any = new Error(`Recipient queue byte limit exceeded (${this.maxQueueBytes} bytes)`);
      err.statusCode = 429;
      err.code = 'queue_full';
      err.retryAfter = 10;
      throw err;
    }

    const nowIso = new Date().toISOString();
    const entry: SpoolMessageEntry = {
      msgId,
      linkId: input.linkId,
      senderId: input.senderId,
      targetId: input.targetId,
      senderType: input.senderType || 'agent',
      operatorEmail: input.operatorEmail,
      senderEncPub: input.senderEncPub,
      senderSignPub: input.senderSignPub,
      senderKid: input.senderKid,
      payload: input.payload,
      payloadHash,
      state: 'available',
      enqueuedAt: nowIso,
      timestamp: nowIso,
      attempts: 0,
    };

    this.messagesByMsgId.set(msgId, entry);
    if (!this.recipientQueues.has(input.targetId)) {
      this.recipientQueues.set(input.targetId, []);
    }
    this.recipientQueues.get(input.targetId)!.push(msgId);

    // 5. Durably sync to disk before acknowledging acceptance
    this.persist();

    return { isDuplicate: false, message: entry };
  }

  public lease(
    recipientId: string,
    limit: number = 50,
    durationMs?: number
  ): { leaseId: string; messages: SpoolMessageEntry[]; leaseExpiresAt: number } {
    const now = Date.now();
    const leaseDuration = durationMs || this.defaultLeaseDurationMs;
    const queue = this.recipientQueues.get(recipientId) || [];

    // Reclaim expired leases & check retention
    for (const id of queue) {
      const m = this.messagesByMsgId.get(id);
      if (!m) continue;

      if (m.state === 'in_flight' && m.leaseExpiresAt && m.leaseExpiresAt <= now) {
        m.state = 'available';
        m.leaseId = undefined;
        m.leaseExpiresAt = undefined;
      }

      if (m.state === 'available') {
        const ageMs = now - Date.parse(m.enqueuedAt);
        if (ageMs > this.retentionMs) {
          m.state = 'expired';
        }
      }
    }

    const available = queue
      .map(id => this.messagesByMsgId.get(id))
      .filter((m): m is SpoolMessageEntry => !!m && m.state === 'available');

    if (available.length === 0) {
      return { leaseId: '', messages: [], leaseExpiresAt: 0 };
    }

    const picked = available.slice(0, limit);
    const leaseId = `lease_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const leaseExpiresAt = now + leaseDuration;

    for (const msg of picked) {
      msg.state = 'in_flight';
      msg.leaseId = leaseId;
      msg.leaseExpiresAt = leaseExpiresAt;
      msg.attempts += 1;
    }

    this.persist();

    return {
      leaseId,
      messages: picked,
      leaseExpiresAt,
    };
  }

  public ack(
    recipientId: string,
    messageIds: string[],
    leaseId?: string
  ): { acknowledged: string[]; notFound: string[] } {
    const acknowledged: string[] = [];
    const notFound: string[] = [];
    const queue = this.recipientQueues.get(recipientId) || [];

    for (const id of messageIds) {
      const msg = this.messagesByMsgId.get(id);
      if (msg && msg.targetId === recipientId && msg.state !== 'revoked') {
        msg.state = 'acknowledged';
        msg.acknowledgedAt = new Date().toISOString();
        acknowledged.push(id);

        // Record in recent idempotency cache
        this.acknowledgedMsgIds.set(id, {
          payloadHash: msg.payloadHash,
          targetId: msg.targetId,
          timestamp: Date.now(),
        });

        // Prune from active recipient queue
        const qIdx = queue.indexOf(id);
        if (qIdx !== -1) queue.splice(qIdx, 1);
        this.messagesByMsgId.delete(id);
      } else if (this.acknowledgedMsgIds.has(id)) {
        // Already acknowledged previously
        acknowledged.push(id);
      } else {
        notFound.push(id);
      }
    }

    // Cap acknowledgedMsgIds size at 10,000
    if (this.acknowledgedMsgIds.size > 10000) {
      const keys = Array.from(this.acknowledgedMsgIds.keys());
      for (let i = 0; i < 2000; i++) {
        this.acknowledgedMsgIds.delete(keys[i]);
      }
    }

    this.persist();

    return { acknowledged, notFound };
  }

  public nack(
    recipientId: string,
    messageIds: string[],
    action: 'requeue' | 'reject' = 'requeue'
  ): { nacked: string[] } {
    const nacked: string[] = [];
    const queue = this.recipientQueues.get(recipientId) || [];

    for (const id of messageIds) {
      const msg = this.messagesByMsgId.get(id);
      if (msg && msg.targetId === recipientId && msg.state === 'in_flight') {
        if (action === 'reject') {
          msg.state = 'rejected';
          const qIdx = queue.indexOf(id);
          if (qIdx !== -1) queue.splice(qIdx, 1);
          this.messagesByMsgId.delete(id);
        } else {
          msg.state = 'available';
          msg.leaseId = undefined;
          msg.leaseExpiresAt = undefined;
        }
        nacked.push(id);
      }
    }

    this.persist();

    return { nacked };
  }

  public purgeForLink(linkId: string): number {
    let count = 0;
    for (const [id, msg] of this.messagesByMsgId.entries()) {
      if (msg.linkId === linkId && msg.state !== 'acknowledged') {
        msg.state = 'revoked';
        const q = this.recipientQueues.get(msg.targetId);
        if (q) {
          const idx = q.indexOf(id);
          if (idx !== -1) q.splice(idx, 1);
        }
        this.messagesByMsgId.delete(id);
        count++;
      }
    }
    if (count > 0) this.persist();
    return count;
  }

  public purgeForAgent(agentId: string): number {
    let count = 0;
    for (const [id, msg] of this.messagesByMsgId.entries()) {
      if ((msg.targetId === agentId || msg.senderId === agentId) && msg.state !== 'acknowledged') {
        msg.state = 'revoked';
        const q = this.recipientQueues.get(msg.targetId);
        if (q) {
          const idx = q.indexOf(id);
          if (idx !== -1) q.splice(idx, 1);
        }
        this.messagesByMsgId.delete(id);
        count++;
      }
    }
    this.recipientQueues.delete(agentId);
    if (count > 0) this.persist();
    return count;
  }

  public getPendingCount(linkId?: string): number {
    let count = 0;
    for (const msg of this.messagesByMsgId.values()) {
      if (linkId && msg.linkId !== linkId) continue;
      if (msg.state === 'available' || msg.state === 'in_flight') {
        count++;
      }
    }
    return count;
  }

  public getAvailableCount(targetId: string, linkId?: string): number {
    const queue = this.recipientQueues.get(targetId) || [];
    let count = 0;
    const now = Date.now();
    for (const id of queue) {
      const m = this.messagesByMsgId.get(id);
      if (!m) continue;
      if (linkId && m.linkId !== linkId) continue;
      const isAvailable = m.state === 'available' ||
        (m.state === 'in_flight' && m.leaseExpiresAt && m.leaseExpiresAt <= now);
      if (isAvailable) count++;
    }
    return count;
  }

  public getQueue(targetId: string): SpoolMessageEntry[] {
    const queue = this.recipientQueues.get(targetId) || [];
    return queue.map(id => this.messagesByMsgId.get(id)).filter((m): m is SpoolMessageEntry => !!m);
  }

  public releaseAllLeases(): number {
    let released = 0;
    for (const m of this.messagesByMsgId.values()) {
      if (m.state === 'in_flight') {
        m.state = 'available';
        m.leaseId = undefined;
        m.leaseExpiresAt = undefined;
        released++;
      }
    }
    if (released > 0) {
      this.persist();
    }
    return released;
  }

  public getMetrics(): {
    totalEnqueued: number;
    totalAcknowledged: number;
    availableCount: number;
    inFlightCount: number;
    quarantinedCount: number;
    totalBytes: number;
  } {
    let availableCount = 0;
    let inFlightCount = 0;
    let quarantinedCount = 0;
    let totalBytes = 0;
    const now = Date.now();

    for (const m of this.messagesByMsgId.values()) {
      const raw = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
      totalBytes += Buffer.byteLength(raw, 'utf8');

      if (m.state === 'available') {
        availableCount++;
      } else if (m.state === 'in_flight') {
        if (m.leaseExpiresAt && m.leaseExpiresAt <= now) {
          availableCount++;
        } else {
          inFlightCount++;
        }
      } else if (m.state === 'rejected') {
        quarantinedCount++;
      }
    }

    return {
      totalEnqueued: this.messagesByMsgId.size + this.acknowledgedMsgIds.size,
      totalAcknowledged: this.acknowledgedMsgIds.size,
      availableCount,
      inFlightCount,
      quarantinedCount,
      totalBytes,
    };
  }

  public clear(): void {
    this.messagesByMsgId.clear();
    this.recipientQueues.clear();
    this.acknowledgedMsgIds.clear();
    this.persist();
  }

  public persist(): void {
    try {
      const dataDir = path.dirname(this.spoolFilePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const serialized = {
        version: 1,
        savedAt: new Date().toISOString(),
        messages: Array.from(this.messagesByMsgId.values()),
        recipientQueues: Array.from(this.recipientQueues.entries()),
        acknowledgedMsgIds: Array.from(this.acknowledgedMsgIds.entries()),
      };

      const tmpPath = `${this.spoolFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.spoolFilePath);
    } catch (err: any) {
      console.error(`[MessageSpool Error] Failed to persist spool to ${this.spoolFilePath}:`, err.message);
      const persistenceErr: any = new Error(`Failed to persist message spool to disk: ${err.message}`);
      persistenceErr.code = 'persistence_error';
      persistenceErr.statusCode = 500;
      throw persistenceErr;
    }
  }

  public load(): void {
    if (!fs.existsSync(this.spoolFilePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.spoolFilePath, 'utf8');
      const data = JSON.parse(raw);

      this.messagesByMsgId.clear();
      this.recipientQueues.clear();
      this.acknowledgedMsgIds.clear();

      if (Array.isArray(data.messages)) {
        for (const m of data.messages) {
          // Re-claim any in-flight messages whose lease expired while server was offline
          if (m.state === 'in_flight') {
            m.state = 'available';
            m.leaseId = undefined;
            m.leaseExpiresAt = undefined;
          }
          this.messagesByMsgId.set(m.msgId, m);
        }
      }

      if (Array.isArray(data.recipientQueues)) {
        for (const [recipientId, q] of data.recipientQueues) {
          this.recipientQueues.set(recipientId, q);
        }
      }

      if (Array.isArray(data.acknowledgedMsgIds)) {
        for (const [id, val] of data.acknowledgedMsgIds) {
          this.acknowledgedMsgIds.set(id, val);
        }
      }
    } catch (err: any) {
      console.warn(`[MessageSpool Warning] Failed to load spool from ${this.spoolFilePath}:`, err.message);
    }
  }
}
