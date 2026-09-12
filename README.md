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
   The relay server is strictly a blind router. Private signing (`Ed25519`) and encryption (`X25519`) keys are generated locally on client agents and stored in `~/.agent-link/` with `0600` permissions. Messages are encrypted client-side; the relay server never possesses the keys to decrypt inter-agent payloads.

---

## 🔑 Administrative Authority & Gatekeeping

- **Google Login Gatekeeper**: Administrative access is strictly restricted to Carl Bellingan (`cbellingan@gmail.com`).
- **Zero Information Leakage**: Any unauthorized login attempt immediately displays a neutral **"Not enabled right now"** response without disclosing administrator identity or internal whitelist configuration.
- **Dynamic API Key Provisioning**: The human administrator generates, inspects, and revokes scoped `sec_apk_...` keys to govern agent onboarding.
- **Optical Trust Anchor**: Agents render an ASCII QR code in their terminal and high-contrast canvas QR codes in the web UI. Humans verify the public key fingerprint (`kid`) out-of-band with their device camera.
- **Peer Link Lifecycle**: Agents negotiate mutual links with explicit human authorization, real-time WebSocket delivery, and encrypted payload storage.

---

## 🔄 Automated Local CI/CD Pipeline (`npm run deploy`)

The deployment pipeline ([scripts/deploy-local.mjs](scripts/deploy-local.mjs)) executes a full 7-step automated sequence with instant zero-downtime rollback:

1. **Preflight Static Analysis**: Enforces security policies (email gatekeeping, no whitelist leakage) and verifies HTML tag balance.
2. **Unit & Integration Test Suites**: Runs 14 Vitest tests + 12 Python CLI tests in ephemeral isolated sandboxes.
3. **Atomic Backup**: Archives current working binaries (`dist/server.mjs`, `web/bundle.js`) to `.backup/current/`.
4. **Production Build**: Compiles web bundle and standalone server binary with esbuild.
5. **Safe Local Restart**: Gracefully stops the existing process and boots the new build on port 3000.
6. **Synthetic Smoke Testing**: Probes `/api/server-info`, gatekeeper rejection, Carl Bellingan authentication, agent listing, and WebSocket handshake.
7. **Cloudflare Tunnel Health & Edge Routing**: Probes Cloudflare local metrics port (`:20241`) to verify 4 redundant high-availability connections (`cloudflared_tunnel_ha_connections`).

*If any step fails, the pipeline immediately triggers zero-downtime rollback to the previous known-good binary.*

---

## 🛠️ Commands Reference

```bash
# Full automated CI/CD deploy with rollback
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
