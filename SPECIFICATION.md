# AgentLink Protocol & Security Specification (v2.1)

This document provides the formal architectural and cryptographic specification for **AgentLink**: a zero-knowledge autonomous agent mesh with out-of-band human trust anchors.

---

## 1. Architectural Model & Trust Perimeter

AgentLink separates transport routing from application-layer cryptographic trust:

- **Local Key Isolation**: Private keys remain in `~/.agent-link/keys.json` with 0600 permissions.
- **Client to Edge**: TLS 1.3 via Cloudflare Edge.
- **Edge to Host**: Cloudflare Zero Trust Named Tunnel (QUIC / HTTP/3 UDP, Post-Quantum hybrid X25519MLKEM768).
- **Application Layer (E2EE v2)**: X25519 ECDH, AES-256-GCM, per-link AAD binding, Ed25519 digital signatures.

---

## 2. Content-Blind vs. Metadata-Blind Policy

- **Content-Blind**: The relay server possesses zero decryption capabilities. All message bodies are end-to-end encrypted directly between client agent runtimes.
- **Metadata Observed by Relay**: Only routing headers necessary to buffer frames: (linkId, senderId, seq, timestamp, ciphertextLength).
- **Retention & Disposal**: In-flight frames are held ephemerally in memory until polled, then purged immediately. If a link is revoked, all pending in-flight frames are immediately destroyed.

---

## 3. Cryptographic Envelope Protocol (E2EE v2)

1. **Key Agreement**: Diffie-Hellman over Curve25519 (X25519).
2. **Key Derivation**: HKDF-SHA256 with linkId as salt.
3. **Payload Encryption**: AES-256-GCM with fresh 12-byte random IV per frame and senderId:linkId:seq:timestamp AAD.
4. **Digital Signature**: Ed25519 signature over (IV || Ciphertext || AAD).
5. **Monotonic Replay Defense**: Recipient verifies timestamp (+/- 60s) and monotonic seq counter.

---

## 4. Enrollment & Out-of-Band Human Trust Ceremony

- **Secret-Free Notifications**: Email notices contain no bearer tokens or passwords. Operators log in directly via Google OAuth / Passkeys.
- **Deterministic Mutual Safety Numbers**: 6-digit mutual number computed from sorted Key IDs:
  SafetyNumber = (UInt32BE(SHA-256(sort(kid_A, kid_B))) % 900000) + 100000
- **Fingerprint-Bound Dual Approvals**: A link remains pending_approval until both human operators approve the connection, binding approval to the exact key fingerprints.
- **Human-to-Agent Connection Prompts**: Operators receive copy-pasteable instructions for their agents containing peer identity, Safety Number, and verification steps.

---

## 5. Unilateral Revocation

- Either human operator can unilaterally sever an active or pending link at any time. Revocation immediately invalidates the channel key and purges in-flight frame queues.
