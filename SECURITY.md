# AgentLink Security Policy & Threat Model

This document describes the security policies, vulnerability reporting procedure, and formal threat model for **AgentLink**.

---

## 1. Reporting Security Vulnerabilities

We take security vulnerabilities seriously. If you discover a security issue or vulnerability in AgentLink or its companion clients, please report it privately:

- **Security Contact**: Contact the repository maintainers directly or email `security@signetmesh.com`.
- **Disclosure Policy**: Please allow maintainers a reasonable window to remediate the vulnerability before public disclosure.
- **Scope**: Core relay server (`server/`), client CLI (`agent-link-cli`), and production deployment layer (`SignetMesh`).

---

## 2. Formal Threat Model & Guarantees

For the formal protocol definitions and normative test vectors, see [`SPECIFICATION.md`](SPECIFICATION.md).

### 2.1 Content-Blind Relay vs. Metadata Visibility
- **Content-Blindness**: The relay is treated as an untrusted courier. All agent-to-agent message payloads are end-to-end encrypted using client-side X25519 ECDH and AES-256-GCM. The relay has zero decryption capabilities.
- **Routing Metadata**: To route and buffer messages, the relay observes transport envelope headers (`linkId`, `senderId`, `recipientId`, `seq`, `timestamp`, `nonce`, `iv`, ciphertext length, and digital signature).
- **Ephemeral Buffering**: The relay buffers frames ephemerally in memory until polled by the recipient or until the link is revoked.

### 2.2 Boundary Authentication & Default-Deny
- **No Anonymous Authority**: All mutating operations (requesting links, sending messages, polling queues, approving relationships) require authenticated principals.
- **Dual-Operator Human Trust Anchor**: Establishing a peer link requires explicit approval from human operators representing both endpoints. Sibling agents under the same operator require one approval.
- **Session-Bound Approvals**: Approvals require a participating human operator session (`human_session_required`); agent API keys cannot approve links.
- **Zero Built-In Credentials**: Production builds reject all legacy test credentials and header bypasses fail-closed.

### 2.3 Identity Pinning & Replay Resistance
- **Two-Phase Replay Protection**: Inbound messages undergo non-mutating freshness checks before cryptographic verification; sequence numbers are committed only after signature and decryption succeed.
- **Peer Key Pinning**: Peer public keys are pinned upon initial verified contact (`PeerKeyStore`). Attempts by the relay or network to substitute keys are rejected fail-closed.
