# Zero-Knowledge Agent-to-Agent Message Encryption

> **Status**: Implemented & Enforced (Envelope Protocol v2)  
> **Security Model**: Fail-Closed Zero-Knowledge Mesh  
> **Standards**: RFC 7748 (X25519), RFC 8032 (Ed25519), RFC 5869 (HKDF), NIST SP 800-38D (AES-GCM)

---

## 1. The Story: The Steel Lockbox & The Postal Courier

Imagine two agents, **Alice** and **Bob**, who want to send private messages to each other across the internet, using a central server (the **Postal Courier**) to deliver them.

Here is how their conversation stays completely private and tamper-proof—even though the courier inspects and handles every single package:

### 1. The Secret Combination (No keys sent over the wire)
Alice and Bob never send passwords, combinations, or secret keys across the internet. Instead, using a clever piece of math called **Diffie-Hellman Key Exchange (X25519)**, Alice and Bob can each figure out the *exact same 256-bit lock combination* entirely on their own machines, without ever telling anyone or sending that combination over the wire.

Anyone listening in on the conversation—including the courier—only sees random mathematical public points that are impossible to turn into the combination.

### 2. The Steel Lockbox (AES-256-GCM)
When Alice wants to send a message to Bob, she doesn't write it on a postcard. She places her message inside a heavy **steel lockbox** and scrambles the lock using the combination only she and Bob know. 

Every single message uses a brand new, random padlock position (a fresh 12-byte initialization vector), so even if Alice sends the exact same sentence twice, the locked boxes look completely different from the outside.

### 3. The Personal Wax Seal (Ed25519 Digital Signature)
Before handing the box over, Alice presses her personal signet ring into a dollop of hot wax on the clasp (her digital signature). 
- Bob knows what Alice's seal looks like.
- If someone tries to pry the box open or modify the address label, the wax seal cracks.
- Nobody—not even the courier—can duplicate Alice's signet ring.

### 4. Serial Numbers & Timestamps (Preventing Replays)
Alice engraves today's exact millisecond timestamp and an ascending serial number (`Message #1`, `Message #2`, `Message #3`...) into the steel. 
- When Bob receives a box, he checks that the number is strictly higher than the last one he saw, and that the timestamp is fresh.
- If an eavesdropper captures a box and tries to re-deliver it later to trick Bob, Bob instantly rejects it: *"I already received Message #1, this is an old duplicate!"*

### 5. The Postal Courier (The Relay Server)
Alice hands the sealed steel box to the courier (the central server). 

The courier looks at the outside label: *"Deliver to Bob."* The courier drops the box in Bob's delivery queue.

Notice: **We do not care if the courier inspects the box!** The courier can hold the box, look at it under bright lights, examine the outside, and log the transmission. The message is 100% safe because **the courier does not have the combination to open it**.

### 6. Bob Opens the Box
When Bob picks up the box:
1. He checks Alice's wax seal: **Authentic**.
2. He checks the serial number and timestamp: **Fresh and in order**.
3. He enters the secret combination that only he and Alice computed: **Click! The box pops open**.
4. He reads Alice's message in complete privacy.

```
Agent Alice                         Postal Courier                       Agent Bob
[Private Key]                  [Can Inspect Everything]                [Private Key]
     │                                    │                                  │
     │ 1. Seal Envelope                   │                                  │
     │    - AES-256-GCM lockbox           │                                  │
     │    - Context binding to link       │                                  │
     │    - Fresh timestamp & sequence #  │                                  │
     │    - Ed25519 wax seal signature    │                                  │
     ├───────────────────────────────────>│                                  │
     │   POST /api/messages               │                                  │
     │                                    │ 2. Deliver by Address Label      │
     │                                    │    (Inspects outside of box)     │
     │                                    │    (Has NO combination to open)  │
     │                                    ├─────────────────────────────────>│
     │                                    │   Deliver Sealed Box             │
     │                                    │                                  │
     │                                    │ 3. Verify & Open Box             │
     │                                    │    - Verify Alice's wax seal     │
     │                                    │    - Check serial # is fresh     │
     │                                    │    - Enter secret combination    │
     │                                    │    - Read private message        │
```

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

### Phase 4: The Untrusted Relay
The relay receives the envelope via HTTP (`POST /api/messages`) or WebSocket (`/ws`):
- The relay reads and logs all payload fields (`linkId`, `senderId`, `seq`, `ts`, `iv`, `ciphertext`, `sig`).
- The relay does not possess $K_{link}$ and cannot decrypt `ciphertext`, regardless of how thoroughly it inspects the wire.
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
