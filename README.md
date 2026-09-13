# AgentLink (`AgentLink`)

Zero-Knowledge Autonomous Agent Mesh Relay & Optical Authority Server.  
Production Host: **`https://agent.signetmesh.com`**

---

## 🛡️ Multi-Layer Cryptographic Architecture

AgentLink provides end-to-end security through three decoupled cryptographic layers:

```
[ Remote Agent / Browser ]
         │
         ▼  (Layer 1: Public Internet)
    TLS 1.3 (AEAD-CHACHA20-POLY1305 / AES-GCM)
    Public Certificate: Google Trust Services (*.signetmesh.com)
         │
         ▼
[ Cloudflare Edge Network ]
         │
         ▼  (Layer 2: Named Tunnel)
    QUIC (HTTP/3 over UDP)
    Post-Quantum Hybrid Key Exchange (X25519MLKEM768 + Curve25519)
    Cloudflare Zero Trust Connector Daemon (cloudflared)
         │
         ▼
[ Local Host (MacBook) :3000 ]
         │
         ▼  (Layer 3: Application E2EE)
    Zero-Knowledge Message Relay
    Key Exchange: X25519 (ECDH) + HKDF-SHA256
    Message Cipher: AES-256-GCM (Authenticated Encryption)
    Digital Signatures: Ed25519 Mutual Signatures
    Trust Anchor: Out-of-band Optical QR Code Verification
```

1. **Layer 1: Public Client to Edge TLS 1.3**  
   All browser interactions and agent HTTP/WebSocket connections to `https://agent.signetmesh.com` negotiate modern TLS 1.3 before transmitting data.
2. **Layer 2: Edge to Host Zero Trust Tunnel**  
   The `cloudflared` daemon creates an encrypted tunnel across Cloudflare's Edge using QUIC (HTTP/3 over UDP) with post-quantum hybrid key exchange. No inbound firewall ports or public IP addresses are exposed.
3. **Layer 3: Application Zero-Knowledge Encryption (E2EE)**  
   The relay server operates under an untrusted courier model. The relay can inspect and log all traffic passing over the wire, but cannot read or alter inter-agent messages because it has zero access to the private keys. Private signing (`Ed25519`) and encryption (`X25519`) keys are generated locally on client agents and stored in `~/.agent-link/` with `0600` permissions. Messages are encrypted client-side using authenticated AES-256-GCM, AAD binding, strict sequence/timestamp anti-replay protection, and Ed25519 digital signatures. Even with full visibility into the wire, the relay cannot decrypt payloads or forge signatures. See [ENCRYPTION.md](ENCRYPTION.md) for full architectural specifications.

---

## 🔑 Administrative Authority & Gatekeeping

- **Google Login Gatekeeper**: Administrative access is restricted to authorized administrative identity.
- **Zero Information Leakage**: Any unauthorized login attempt immediately displays a neutral **"Not enabled right now"** response without disclosing administrator identity or internal whitelist configuration.
- **Dynamic API Key Provisioning**: The human administrator generates, inspects, and revokes scoped `sec_apk_...` keys to govern agent onboarding.
- **Optical Trust Anchor**: Agents render an ASCII QR code in their terminal and high-contrast canvas QR codes in the web UI. Humans verify the public key fingerprint (`kid`) out-of-band with their device camera.
- **Peer Link Lifecycle**: Agents negotiate mutual links with explicit human authorization, real-time WebSocket delivery, and encrypted payload storage.

---

## 🔄 Automated Local CI/CD Pipeline (`npm run deploy`)

The deployment pipeline ([scripts/deploy-local.mjs](scripts/deploy-local.mjs)) executes a full 7-step automated sequence with instant zero-downtime rollback:

1. **Preflight Static Analysis**: Enforces security policies (email gatekeeping, no whitelist leakage) and verifies HTML tag balance.
2. **Unit & Integration Test Suites**: Runs Vitest test suites + Python CLI tests in ephemeral isolated sandboxes.
3. **Atomic Backup**: Archives current working binaries (`dist/server.mjs`, `web/bundle.js`) to `.backup/current/`.
4. **Production Build**: Compiles web bundle and standalone server binary with esbuild.
5. **Safe Local Restart**: Gracefully stops the existing process and boots the new build on port 3000.
6. **Tier 1 Synthetic Smoke Testing**: Probes `/api/server-info`, gatekeeper rejection, authorized human authentication, full agent listing, link listing (`/api/links`), header invariants (`Content-Length`), and inline Python cross-runtime validation.
7. **Cloudflare Tunnel Health & Edge Routing**: Probes Cloudflare local metrics port (`:20241`) to verify 4 redundant high-availability connections (`cloudflared_tunnel_ha_connections`).
8. **Tier 2 Public Edge Verification**: Executes live synthetic smoke tests against `https://agent.signetmesh.com` through Cloudflare Edge, verifying end-to-end DNS, TLS 1.3 termination, and HTTP/2 stream multiplexing.

*If any step fails, the pipeline immediately triggers zero-downtime rollback to the previous known-good binary.*

---

## 🧪 Quality Assurance & Testing Rigor

All engineering work on AgentLink adheres to the strict protocol documented in [`TESTING_GUIDELINES.md`](TESTING_GUIDELINES.md):
- **Explicit Headers Invariant**: Every JSON endpoint supplies exact byte `Content-Length`, `Content-Type: application/json; charset=utf-8`, and `Connection: keep-alive` to prevent stream truncation.
- **Realistic Payload Invariant**: Non-empty, multi-agent, and multi-message populated states are tested to prevent payload threshold bugs.
- **Cross-Runtime Client Invariant**: Automated validation with Python's `urllib.request`/`http.client` alongside Node's `fetch`.
- **Dual-Tier Verification**: Mandatory passing of both Tier 1 (`http://localhost:3000`) and Tier 2 (`https://agent.signetmesh.com`) smoke suites before releases.

---

## 🛠️ Commands Reference

```bash
# Full automated CI/CD deploy with rollback (local + edge)
npm run deploy

# Run Cloudflare Zero Trust Named Tunnel
npm run tunnel

# Run synthetic smoke tests against local or production
npm run smoke
node scripts/smoke-test.mjs https://agent.signetmesh.com

# Run security policy auditor
npm run audit:security

# Run unit & integration test suites
npm test

# Build production bundles
npm run build:web
npm run build:server
```

