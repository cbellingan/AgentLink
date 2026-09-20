# AgentLink Architecture Specification

## 1. System Overview & Boundaries

AgentLink is a decentralized, zero-knowledge agent communication protocol designed to interconnect autonomous AI agents across organizational, host, and network boundaries with cryptographic verification and out-of-band human authorization.

The system is decomposed into two distinct planes:

```
+-----------------------------------------------------------------------------+
|                               CONTROL PLANE                                 |
|                                                                             |
|   +-------------------+    Optical QR / OOB     +--------------------+      |
|   | Human Operator A  |<======================>|  Human Operator B  |      |
|   +-------------------+                         +--------------------+      |
|             |                                              |                |
|             v (Browser WebUI)                              v (Browser WebUI)|
|   +------------------------------------------------------------------+      |
|   |                 AgentLink Hub / Registry                         |      |
|   |   - Agent Registration & Key Binding                             |      |
|   |   - Link State Machine (pending_approval -> approved -> revoked) |      |
|   |   - Session & Cookie Security (SameSite, Anti-CSRF)              |      |
|   +------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------+
                                       |
+-----------------------------------------------------------------------------+
|                                 DATA PLANE                                  |
|                                                                             |
|      Agent A (Client)                               Agent B (Client)        |
|    +-------------------+                         +--------------------+     |
|    |  Local Keypair    |                         |   Local Keypair    |     |
|    |  Replay Protector |                         |  Replay Protector  |     |
|    +-------------------+                         +--------------------+     |
|              \                                              /               |
|     (POST /send) \                                      / (GET /poll +      |
|                    \                                  /    POST /ack)       |
|                     v                                v                      |
|             +-----------------------------------------------+               |
|             |             Durable Message Spool             |               |
|             |  - Client msgId Idempotency Scoping           |               |
|             |  - Atomic Crash-Resilient Disk Spool          |               |
|             |  - Lease-Based Concurrent Polling (30s lease) |               |
|             |  - Explicit Delivery Acknowledgement (/ack)   |               |
|             |  - Poison Quarantine / Requeue (/nack)        |               |
|             |  - Backpressure Queue & Byte Bounds           |               |
|             +-----------------------------------------------+               |
+-----------------------------------------------------------------------------+
```

---

## 2. Cryptographic Architecture & Trust Invariants

1. **Zero Knowledge Courier**: The relay server is strictly content-blind. It operates as an untrusted courier that can route and buffer envelopes by inspecting only unencrypted routing headers (`linkId`, `senderId`, `recipientId`, `seq`, `timestamp`, `nonce`, `iv`).
2. **Local Key Isolation**: Private signing keys (`Ed25519`) and private key-agreement keys (`X25519`) are generated locally on the agent's host and never transmitted over the network. Key files are saved with strict POSIX `0600` permissions.
3. **Fail-Closed E2EE**: Transmission across links defaults to fail-closed authenticated encryption using `AES-256-GCM` with pairwise HKDF-derived link keys and Ed25519 digital signatures. Plaintext transmission is prohibited unless the client explicitly opts in via `--plaintext`.
4. **Anti-Replay Protection**: Outbound messages increment a monotonic sequence counter per link. Inbound verification applies a two-phase check: signature verification against the stored counter, followed by atomic counter advancement upon successful processing.

---

## 3. Data Plane: Durable Delivery & Safe Client Retries

### 3.1 Acceptance vs. Delivery Guarantees

AgentLink explicitly separates **relay acceptance** from **recipient delivery**:

- **Accepted (`state: "accepted"`, `accepted: true`, `delivered: false`)**: Returned synchronously by `POST /api/links/:id/send` as soon as the message has been validated, idempotency-checked, and safely persisted to the durable message spool.
- **Delivered**: Occurs only when the recipient agent fetches the message and explicitly commits an acknowledgement (`POST /api/agents/:id/ack`).

### 3.2 Stable Client-Generated `msgId` & Idempotency

Every message transmission accepts or generates a stable, client-scoped `msgId`:
- **Format**: `msg_<hex>` or arbitrary client UUID.
- **Idempotency Rule**: If a sender retries `POST /api/links/:id/send` with the exact same `msgId`, `senderId`, `linkId`, and `payload`, the relay returns the existing accepted record (`HTTP 200`) without duplicating the queued envelope.
- **Conflict Rule**: If a sender submits a request with an existing `msgId` but differing payload, link, or sender, the relay rejects the request immediately with `HTTP 409 Conflict`.

### 3.3 Atomic Disk Spool Persistence

- Enqueued messages are flushed atomically to disk (`messages-spool.json`) using temporary file rename operations (`fs.renameSync`).
- Upon server crash, process kill, or planned restart, the relay loads `messages-spool.json` during startup and immediately re-evaluates in-flight leases, ensuring zero message loss.

### 3.4 Lease State Machine

To support concurrent consumers, reliable polling, and safe worker restarts:

```
                 +-------------------+
                 |     UNLEASED      | <----+ (Lease Expired /
                 +-------------------+      |  NACK Requeue)
                           |                |
                           | GET /poll      |
                           v                |
                 +-------------------+      |
                 |      LEASED       | -----+
                 +-------------------+
                   |               |
       POST /ack   |               | POST /nack (quarantine)
                   v               v
             +-----------+   +---------------+
             | COMMITTED |   |  QUARANTINED  |
             | (Deleted) |   | (Dead-Letter) |
             +-----------+   +---------------+
```

1. **Leasing**: When an authorized agent calls `GET /api/agents/:id/poll`, the relay atomically leases up to `batchSize` unleased messages (default lease duration: 30 seconds). The response includes `leaseId` and `leaseExpiresAt`.
2. **Concurrency Safety**: While leased, messages are concealed from subsequent poll requests by other worker threads or processes.
3. **Lease Expiry**: If a consumer crashes or fails to acknowledge within the lease window, the lease expires and the messages automatically become available for the next poll.
4. **Explicit Acknowledgement (`POST /api/agents/:id/ack`)**: The recipient provides `messageIds` and the active `leaseId`. Acknowledged messages are permanently purged from the spool and persisted to disk.
5. **Negative Acknowledgement (`POST /api/agents/:id/nack`)**: Used for poison envelopes or processing failures. Supports `action: "requeue"` (immediately breaks lease and returns to queue) or `action: "quarantine"` (marks as dead-lettered to prevent infinite crash loops).

### 3.5 Bounded Queues & Backpressure

To protect the relay against resource exhaustion or disconnected recipients:
- **Depth Bound**: Default maximum 1,000 pending unleased messages per recipient queue.
- **Byte Bound**: Default maximum 10 MB total buffered payload per recipient queue.
- **Backpressure Behavior**: If enqueuing an envelope would exceed either limit, the relay rejects the submission with `HTTP 429 Too Many Requests` (`error: "queue_full"`), signaling the sender to apply exponential backoff.

### 3.6 Revocation & De-registration Cascades

- When an operator or agent revokes a link (`DELETE /api/links/:id`), all envelopes buffered for that link are purged from the spool immediately.
- When an agent is de-registered or deleted, all pending messages addressed to or sent by that agent are permanently purged.
