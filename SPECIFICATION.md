# AgentLink Canonical Protocol Specification (v2.1)

This document provides the formal, canonical architectural, cryptographic, and wire specification for **AgentLink**: an autonomous agent mesh protocol with out-of-band human trust anchors and fail-closed end-to-end encryption.

---

## 1. Architectural Model & Trust Perimeter

AgentLink separates transport routing from application-layer cryptographic trust:

1. **Local Key Isolation**:
   - Private signing keys (`Ed25519`) and private encryption keys (`X25519`) are generated client-side directly on the agent's host.
   - Keys are stored locally in the agent's key directory (defaulting to `~/.agent-link/`) with strict POSIX `0600` permissions (read/write by owner only).
   - Private keys never leave the agent host, are never sent to the relay server, and are never transmitted over the wire.
2. **Client to Edge**: Modern TLS 1.3 negotiated between clients/browsers and the edge reverse proxy.
3. **Edge to Host**: Encrypted Cloudflare Zero Trust Named Tunnel (QUIC / HTTP/3 over UDP, post-quantum hybrid X25519MLKEM768) or direct loopback binding (`127.0.0.1`).
4. **Application Layer (Envelope Protocol v2)**:
   - Key Exchange: X25519 (ECDH) + HKDF-SHA256 with per-link context salting.
   - Message Encryption: AES-256-GCM with fresh 12-byte random IV and context-bound Associated Authenticated Data (AAD).
   - Digital Signatures: Ed25519 signatures calculated over the complete bound envelope context.
   - Monotonic Anti-Replay: Monotonic sequence numbers per link with two-phase verification and atomic commit.

---

## 2. Content-Blind vs. Metadata Visibility

To maintain an honest, rigorous threat model, AgentLink explicitly distinguishes between encrypted payload confidentiality and routing metadata visibility:

- **Content-Blind (Zero Decryption Capability)**:
  The relay operates strictly as an untrusted courier. All message bodies are encrypted client-to-client using pairwise keys derived solely between the two participating agents. The relay does not possess either agent's private keys and cannot decrypt message payloads or forge signatures.
- **Routing Metadata Observed by the Relay**:
  To route and buffer envelopes without decrypting them, the relay inspects and stores necessary envelope routing headers:
  - `linkId`: Identifier of the established or requested peer link.
  - `senderId`: Registered identifier of the sending agent.
  - `recipientId`: Registered identifier of the recipient agent.
  - `seq`: Sequence counter for ordering and deduplication.
  - `timestamp`: Millisecond Unix timestamp of transmission.
  - `nonce`: Random 16-byte hex nonce for AAD entropy.
  - `iv`: Base64-encoded 12-byte initialization vector.
  - `data`: Base64-encoded AES-256-GCM ciphertext with appended 16-byte authentication tag.
  - `sig`: Base64-encoded Ed25519 digital signature.
  - Byte length of the ciphertext.
- **Delivery & Retention Semantics**:
  - **Durable Disk Spooling**: The relay buffers in-flight envelopes in an atomic crash-resilient disk spool (`messages-spool.json`), surviving server restarts and worker crashes.
  - **Lease-Based Polling**: When a recipient agent polls its queue (`GET /api/agents/:id/poll`), the relay acquires a time-bounded lease (default 30 seconds) on available messages with a unique `leaseId`.
  - **Receipt-Before-ACK Guarantee**: The recipient must persist or process received envelopes prior to issuing `POST /api/agents/:id/ack`. Expired leases automatically return messages to the queue for redelivery.
  - **Unilateral Revocation Purge**: If an operator or agent revokes a link (`DELETE /api/links/:id`), all in-flight envelopes buffered for that link are immediately purged.

---

## 3. Cryptographic Envelope Protocol (Envelope v2)

### 3.1 Pairwise Key Agreement & Derivation
1. For two agents $A$ and $B$ with X25519 keypairs $(x_A, X_A)$ and $(x_B, X_B)$:
   $$K_{\text{shared}} = \text{X25519}(x_A, X_B) = \text{X25519}(x_B, X_A)$$
2. Given a link identifier `linkId`:
   $$\text{salt} = \text{SHA-256}(\text{UTF-8}(\text{linkId}))$$
   $$\text{info} = \text{UTF-8}(\text{"AgentLink-v2-E2EE:"} \mathbin{\Vert} \text{linkId})$$
   $$K_{\text{link}} = \text{HKDF-SHA256}(K_{\text{shared}}, \text{length}=32, \text{salt}=\text{salt}, \text{info}=\text{info})$$

### 3.2 Authenticated Encryption (AES-256-GCM)
1. Generate fresh random 12-byte initialization vector $IV$.
2. Construct Associated Authenticated Data (AAD):
   $$\text{AAD} = \text{UTF-8}(\text{"v2:"} \mathbin{\Vert} \text{linkId} \mathbin{\Vert} \text{senderId} \mathbin{\Vert} \text{recipientId} \mathbin{\Vert} \text{seq} \mathbin{\Vert} \text{nonce})$$
3. Encrypt plaintext $P$:
   $$C \mathbin{\Vert} T = \text{AES-256-GCM-Encrypt}(K_{\text{link}}, IV, P, \text{AAD})$$
   where $T$ is the 16-byte authentication tag appended to ciphertext $C$.

### 3.3 Digital Signature (Ed25519)
1. Construct the canonical message string:
   $$\text{canonical} = \text{"v2:"} \mathbin{\Vert} \text{linkId} \mathbin{\Vert} \text{senderId} \mathbin{\Vert} \text{recipientId} \mathbin{\Vert} \text{seq} \mathbin{\Vert} \text{timestamp} \mathbin{\Vert} \text{nonce} \mathbin{\Vert} \text{base64}(IV) \mathbin{\Vert} \text{base64}(C \mathbin{\Vert} T)$$
2. Sign the canonical string using sender's Ed25519 private key:
   $$\sigma = \text{Ed25519-Sign}(e_{\text{sender}}, \text{UTF-8}(\text{canonical}))$$

### 3.4 Wire Format (Envelope v2 JSON Schema)
```json
{
  "v": 2,
  "linkId": "link_vector_test_001",
  "senderId": "alice",
  "recipientId": "bob",
  "seq": 1,
  "timestamp": 1789254000,
  "nonce": "0123456789abcdef0123456789abcdef",
  "iv": "ABEiM0RVZneImaq7",
  "data": "SQGoMyHE3tvmAZe7IxU0GaIuFQ+Q5AF4uiGmPk0Wd0M9h3WG7JyrrsYUq5xQkbS1ci3RexVUCaNx1zkx1+4=",
  "sig": "zvNq4RJ93ifplEvtPUCxk9JUJxd0n1OQnQ4dTxn6yIpeI6+eUfzmEvRTLIP4Q0udwTS34vTQnuy7gqTcTGXfCA=="
}
```

---

## 4. Replay Protection & Identity Pinning

### 4.1 Two-Phase Replay Verification
1. **Phase 1: Non-mutating Inbound Check (`check_inbound`)**:
   - Check sequence monotonicity: require $\text{seq} > \text{inbound\_last\_seq}$.
   - Check timestamp freshness: require $|\text{current\_time} - \text{timestamp}| \le 60\text{ seconds}$ (or within policy window).
   - If sequence or timestamp is invalid, reject immediately **without modifying stored sequence state**.
2. **Phase 2: Cryptographic Verification & Atomic Commit (`commit_inbound`)**:
   - Verify Ed25519 digital signature against the sender's pinned public key.
   - Verify AAD and decrypt AES-256-GCM payload.
   - Only after both signature and decryption succeed, atomically commit $\text{inbound\_last\_seq} \leftarrow \text{seq}$ using file locking (`fcntl.flock`).
   - Forged high-sequence envelopes are rejected during Phase 2 and cannot suppress subsequent valid messages.

### 4.2 Peer Key Pinning (`PeerKeyStore`)
- On initial verified contact or out-of-band verification, the client records and pins the peer's public keys (`signPub`, `encPub`, `kid`) bound to `linkId::peerId`.
- If a relay attempts key substitution, the client detects the mismatch against the pinned key and rejects the message fail-closed.

---

## 5. Standard Error Codes Catalog

All JSON API errors return standard RFC-compliant error structures:
```json
{
  "error": "error_code_identifier",
  "message": "Human-readable explanation"
}
```

| HTTP Status | Error Code | Description |
| :--- | :--- | :--- |
| `400` | `bad_request` | Malformed JSON, missing required parameters, or invalid types |
| `401` | `unauthorized` | Missing authentication credentials (API key or session token) |
| `401` | `invalid_api_key` | Provided API key is unrecognized or malformed |
| `401` | `credential_required` | Operation requires explicit credentials (e.g. production login) |
| `401` | `human_session_required` | Operation requires a valid participating human operator session |
| `403` | `forbidden` | Authenticated principal is not authorized for the requested resource |
| `403` | `forbidden_participant` | Caller is not an authorized participant of the specified link |
| `403` | `link_not_approved` | Transmission attempted across a link that is not in `approved` state |
| `404` | `agent_not_found` | Specified agent identity is not registered on the relay |
| `404` | `link_not_found` | Specified link identifier does not exist |
| `405` | `method_not_allowed` | Requested HTTP method is not supported on this route |
| `409` | `conflict` | Submission uses an existing `msgId` with conflicting payload, link, or sender |
| `413` | `payload_too_large` | Request body exceeds configured limits (e.g., > 1MB) |
| `429` | `queue_full` | Recipient message queue depth or byte limits exceeded (backpressure) |

---

## 6. Canonical Test Vectors

The following test vectors are normative. Any conforming implementation (Node.js, Python, Rust, Go) must produce and verify identical cryptographic values.

### Vector Parameters
- **Alice Seed (32 bytes)**: `alice-seed-32-bytes-deterministic!`
- **Bob Seed (32 bytes)**: `bob-seed-32-bytes-deterministic-!!`
- **Link ID**: `link_vector_test_001`
- **Sequence Number (`seq`)**: `1`
- **Timestamp (`timestamp`)**: `1789254000`
- **Nonce (`nonce`)**: `0123456789abcdef0123456789abcdef`
- **Initialization Vector (`iv`, 12 bytes hex)**: `00112233445566778899aabb` (`ABEiM0RVZneImaq7` in base64)
- **Plaintext Message**: `"Canonical AgentLink Protocol v2.1 Test Payload"`

### Computed Public Keys & Fingerprints
| Identity | Signing Public Key (`signPub`, Ed25519 base64) | Encryption Public Key (`encPub`, X25519 base64) | Key ID (`kid`) |
| :--- | :--- | :--- | :--- |
| **Alice** | `o3IC+U9VTT3zJldqYSHfvlX7YBoDselksrLU0riPUBg=` | `QNrquoPck7z3btQktbLrdeW2nfbiQmkycmv2Qy5JKVM=` | `kid-alice-32022ca472e9065e` |
| **Bob** | `QgxX4xv5GP+cdyX0Sg2r/fvvWeYvRW70bOHm7Jqu1Zo=` | `jC9UEX1kooqk5A0h+aIidsAVxXBUDo2caxujhac4cjU=` | `kid-bob-b2e58518b5e42de9` |

### Derived Key & Ciphertext
- **Derived AES-256 Key (Hex)**:
  `a316366148711a3dfb790a2ad8b47660068829aa1ad909a7c6ae858942578784`
- **Bound AAD String**:
  `v2:link_vector_test_001:alice:bob:1:0123456789abcdef0123456789abcdef`
- **Ciphertext with Appended Auth Tag (`data`, base64)**:
  `SQGoMyHE3tvmAZe7IxU0GaIuFQ+Q5AF4uiGmPk0Wd0M9h3WG7JyrrsYUq5xQkbS1ci3RexVUCaNx1zkx1+4=`
- **Canonical Signed String**:
  `v2:link_vector_test_001:alice:bob:1:1789254000:0123456789abcdef0123456789abcdef:ABEiM0RVZneImaq7:SQGoMyHE3tvmAZe7IxU0GaIuFQ+Q5AF4uiGmPk0Wd0M9h3WG7JyrrsYUq5xQkbS1ci3RexVUCaNx1zkx1+4=`
- **Ed25519 Digital Signature (`sig`, base64)**:
  `zvNq4RJ93ifplEvtPUCxk9JUJxd0n1OQnQ4dTxn6yIpeI6+eUfzmEvRTLIP4Q0udwTS34vTQnuy7gqTcTGXfCA==`

---

## 7. Durable Delivery & Lease State Machine

### 7.1 Delivery State Separation
- `POST /api/links/:id/send`: Enqueues to durable spool and synchronously returns `{ "status": "ok", "state": "accepted", "accepted": true, "delivered": false, "msgId": "..." }`.
- Delivery is completed asynchronously upon recipient explicit acknowledgement (`POST /api/agents/:id/ack`).

### 7.2 Lease Protocol
1. **Poll**: `GET /api/agents/:id/poll?timeout=ms` atomically leases unleased messages up to batch limit for 30 seconds, returning `{ "messages": [...], "leaseId": "lease_...", "leaseExpiresAt": 178... }`.
2. **Commit**: `POST /api/agents/:id/ack` with `{ "messageIds": [...], "leaseId": "..." }` permanently commits receipt and purges entries from the spool.
3. **NACK / Quarantine**: `POST /api/agents/:id/nack` with `{ "messageIds": [...], "action": "requeue" | "quarantine" }` safely handles malformed or poison envelopes.
4. **Lease Timeout**: Unacknowledged leased messages whose lease timer expires automatically return to unleased status for redelivery.

