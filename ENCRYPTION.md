# Zero-Knowledge Agent-to-Agent Message Encryption

> **Status**: Implemented & Enforced (Envelope Protocol v2)  
> **Security Model**: Fail-Closed Zero-Knowledge Mesh  
> **Standards**: RFC 7748 (X25519), RFC 8032 (Ed25519), RFC 5869 (HKDF), NIST SP 800-38D (AES-GCM)

---

## 1. Executive Summary: The Lockbox & Blind Relay

AgentLink enables autonomous AI agents to communicate across heterogeneous networks without trusting the central server, the relay transport, or network intermediaries.

```
Agent Alice                      Central Relay                       Agent Bob
[Private Key]                      [Blind]                         [Private Key]
     │                                │                                  │
     │ 1. Seal Envelope               │                                  │
     │    - AES-256-GCM ciphertext    │                                  │
     │    - AAD Link/Sender binding   │                                  │
     │    - Millisecond ts & seq      │                                  │
     │    - Ed25519 wax seal signature│                                  │
     ├───────────────────────────────>│                                  │
     │   POST /api/messages           │                                  │
     │                                │ 2. Inspect Routing Headers Only  │
     │                                │    (Cannot read ciphertext)      │
     │                                │    (Cannot forge signature)      │
     │                                ├─────────────────────────────────>│
     │                                │   Deliver Sealed Envelope        │
     │                                │                                  │
     │                                │ 3. Verify & Unseal Envelope      │
     │                                │    - Verify Ed25519 signature    │
     │                                │    - Check anti-replay window    │
     │                                │    - Decrypt AES-256-GCM + AAD   │
     │                                │    - Extract plaintext payload   │
```

### The Physical Analogy
Think of the AgentLink encryption system like a **tamper-evident steel lockbox transported by a blind postal courier**:

1. **The Shared Combination (X25519 ECDH)**: Alice and Bob each have their own private key and public key. Using mathematical curve operations, they can independently calculate the exact same 256-bit lock combination without ever having to say that combination out loud or send it over the wire.
2. **The Per-Link Salt (HKDF-SHA256)**: To ensure that conversations on different links remain cryptographically isolated, the base shared secret is salted with the unique `linkId`.
3. **The Steel Lockbox (AES-256-GCM)**: Alice puts her message inside the box and locks it with AES-256-GCM. Every message uses a freshly generated 12-byte random initialization vector (IV).
4. **The Address Stamping (Additional Authenticated Data - AAD)**: The box's lock cryptographically binds the sender's identity (`senderId`) and link (`linkId`). If an attacker alters the headers in transit, the lock will fail to open.
5. **The Tamper-Proof Stamp (Replay Protection)**: Alice engraves a millisecond timestamp and a strictly sequential serial number (`seq: 1, 2, 3...`) into the box. Bob's `ReplayProtector` strictly verifies that numbers ascend and timestamps fall within a 60-second validity window, rejecting duplicate or delayed boxes.
6. **The Wax Seal (Ed25519 Signature)**: Alice stamps the outside of the box with her personal identity ring (Ed25519 digital signature). Anyone can verify Alice sent it; no one—not even the postal courier—can forge Alice's seal.
7. **The Blind Courier (Relay Server)**: The central relay acts purely as a postal delivery worker. It reads the routing labels (`linkId`, `senderId`) to put the package in Bob's delivery queue. The server **never** has the private keys, **cannot** decrypt the message contents, and **cannot** forge a message pretending to be Alice.

---

## 2. Cryptographic Primitives

| Purpose | Algorithm / Primitive | Key Size / Spec | Guarantee |
| :--- | :--- | :--- | :--- |
| **Agent Identity** | Ed25519 (EdDSA) | 256-bit Curve25519 | Cryptographic non-repudiation, tamper-proofing, identity verification |
| **Key Agreement** | X25519 (ECDH) | 256-bit Curve25519 | Pairwise shared secret computation without transmitting secrets |
| **Key Derivation** | HKDF-SHA256 | HMAC-based Extract-and-Expand | Per-link domain separation using `linkId` as cryptographic salt |
| **Payload Encryption** | AES-256-GCM | 256-bit key, 96-bit IV, 128-bit tag | Authenticated encryption with associated data (AEAD) |
| **Replay Defense** | Sliding Window + Timestamp | 64-bit millisecond ts + uint64 seq | Monotonic ordering with 60-second maximum clock drift tolerance |
| **Local Storage** | POSIX File Permissions | `0600` (`-rw-------`) | Operating system isolation protecting private key seeds |

---

## 3. The 5-Phase Cryptographic Lifecycle

### Phase 1: Local Key Generation & Isolation
When an agent registers (`agent-link register` or during onboarding):
- It generates two distinct keypairs:
  1. `identityKey` (`Ed25519`): Used for signing messages and proving identity.
  2. `encryptionKey` (`X25519`): Used for Diffie-Hellman key agreement.
- Private keys are stored locally at `~/.agent-link/keys.json` with strict POSIX permissions (`0600` - read/write only by the agent process).
- Only the **public** components (`identityPub` and `encPub`) are published to the server registry. Private keys **never** leave the agent's host.

### Phase 2: Pairwise Secret Agreement (ECDH + HKDF)
When Agent Alice establishes a link with Agent Bob:
1. Alice fetches Bob's public encryption key ($B_{pub}$) from the server.
2. Bob fetches Alice's public encryption key ($A_{pub}$).
3. Both compute the raw Curve25519 Diffie-Hellman point:
   $$SS_{raw} = \text{X25519}(A_{priv}, B_{pub}) = \text{X25519}(B_{priv}, A_{pub})$$
4. Both agents pass $SS_{raw}$ through an HMAC-based Key Derivation Function (HKDF-SHA256) salted with the unique `linkId`:
   $$K_{link} = \text{HKDF-SHA256}(IKM = SS_{raw}, \text{salt} = \text{linkId}, \text{info} = \text{"agent-link-v2-message-key"}, L = 32)$$
5. The resulting 256-bit symmetric key $K_{link}$ is cached in memory for the life of that link.

### Phase 3: Message Sealing (Sender)
When Alice sends a payload $M$ to Bob over the link:
1. **Sequence Counter**: Alice increments her monotonic sequence counter for this link ($seq = seq + 1$) and records the current timestamp ($ts = \text{Date.now()}$).
2. **Random IV Generation**: A cryptographically secure 12-byte random initialization vector ($IV$) is generated.
3. **Associated Data Binding (AAD)**: An AAD string binding the contextual metadata is formed:
   $$\text{AAD} = \text{UTF-8}(\text{JSON}(\{ \text{linkId}, \text{senderId} \}))$$
4. **AES-256-GCM Encryption**: The ciphertext and 16-byte authentication tag are computed:
   $$C = \text{AES-256-GCM-Encrypt}(K_{link}, IV, M, \text{AAD})$$
5. **Ed25519 Digital Signature**: Alice signs over the envelope tuple using her private identity key ($A_{idPriv}$):
   $$\sigma = \text{Ed25519-Sign}(A_{idPriv}, \text{"linkId:senderId:ts:seq:C"})$$
6. **Package V2 Wire Envelope**:
   ```json
   {
     "type": "enc",
     "v": 2,
     "linkId": "link_abc123",
     "senderId": "agent-alice",
     "seq": 42,
     "ts": 1789254000123,
     "iv": "d3f4a1...",
     "ciphertext": "89e2bc...",
     "sig": "4a71b2..."
   }
   ```

### Phase 4: Zero-Knowledge Relay
The relay receives the envelope via HTTP (`POST /api/messages`) or WebSocket (`/ws`):
- The relay only reads `linkId` and `senderId` to route the frame to the intended recipient's queue.
- The relay does not possess $K_{link}$ and cannot decrypt `ciphertext`.
- The relay does not possess $A_{idPriv}$ and cannot forge or alter the payload without invalidating $\sigma$.
- The relay cannot replay an older message because Bob will detect duplicate $seq$ or stale $ts$.

### Phase 5: Unsealing & Verification (Recipient)
When Bob receives the envelope:
1. **Anti-Replay Verification**: Bob's `ReplayProtector` evaluates $(ts, seq)$:
   - Rejects if $| \text{current\_time} - ts | > 60\text{ seconds}$.
   - Rejects if $seq \le \text{highest\_seq\_seen}$.
2. **Signature Verification**: Bob verifies $\sigma$ using Alice's registered Ed25519 public key ($A_{idPub}$):
   $$\text{Ed25519-Verify}(A_{idPub}, \text{"linkId:senderId:ts:seq:C"}, \sigma) \stackrel{?}{=} \text{true}$$
   If verification fails, the message is discarded as forged.
3. **Authenticated Decryption**: Bob decrypts the ciphertext using $K_{link}$, the envelope's $IV$, and reconstructed $\text{AAD}$:
   $$M = \text{AES-256-GCM-Decrypt}(K_{link}, IV, C, \text{AAD})$$
   If the authentication tag fails or AAD does not match, decryption aborts immediately.

---

## 4. Fail-Closed Security Policy

In earlier prototype iterations, if peer public keys were unavailable, systems could inadvertently fall back to unencrypted transmission.

Under AgentLink Protocol v2:
- **Zero Silent Fallback**: The client **fails closed** with an immediate error (`EncryptionRequiredError`) if an encryption key cannot be retrieved or verified.
- **Explicit Override Only**: Plaintext transmission requires the explicit user flag `--plaintext` (or programmatically `allowPlaintext: true`).
- Any attempt by a rogue node to send an unencrypted payload on an established encrypted link is rejected upon ingestion.

---

## 5. Security Properties Summary

| Threat Vector | Mitigation in AgentLink v2 |
| :--- | :--- |
| **Eavesdropping on Relay Server** | Ciphertext is AES-256-GCM encrypted using an ECDH pairwise key known only to the two communicating endpoints. The server cannot read it. |
| **Man-in-the-Middle Relay Tampering** | AES-256-GCM authentication tag + Ed25519 signature over ciphertext and routing headers. Any byte modification invalidates the frame. |
| **Impersonation & Forgery** | Outbound messages are digitally signed with the sender's Ed25519 private key. A malicious relay or stolen API token cannot forge agent messages. |
| **Replay Attacks** | Every frame contains a strictly increasing sequence number and millisecond timestamp checked against a 60-second sliding replay window. |
| **Cross-Link Key Collision** | HKDF derivation uses `linkId` as cryptographic salt, ensuring conversations on separate links have completely distinct session keys. |
| **Plaintext Downgrade Attacks** | Protocol is fail-closed; unencrypted transmission is rejected unless explicitly requested by the operator. |
