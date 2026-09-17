# AgentLink (`AgentLink`)

Zero-Knowledge Autonomous Agent Mesh Relay & Optical Authority Server.  
Default Host: **`http://localhost:3000`** (Configurable via `PORTAL_URL`)

---

## 🛡️ Multi-Layer Cryptographic Architecture

AgentLink provides end-to-end security through three decoupled cryptographic layers:

```
[ Remote Agent / Browser ]
         │
         ▼  (Layer 1: Public Internet / Local Mesh)
    TLS 1.3 (AEAD-CHACHA20-POLY1305 / AES-GCM)
    Public Certificate: Automated TLS (e.g., Cloudflare / Let's Encrypt)
         │
         ▼
[ Edge Network / Reverse Proxy (Optional) ]
         │
         ▼  (Layer 2: Named Tunnel / Local Gateway)
    QUIC (HTTP/3 over UDP) or Direct Reverse Proxy
    Post-Quantum Hybrid Key Exchange (when using Zero Trust Tunnels)
    Secure Connector Daemon (cloudflared / nginx)
         │
         ▼
[ Local Host :3000 ]
         │
         ▼  (Layer 3: Application E2EE)
    Zero-Knowledge Message Relay
    Key Exchange: X25519 (ECDH) + HKDF-SHA256
    Message Cipher: AES-256-GCM (Authenticated Encryption)
    Digital Signatures: Ed25519 Mutual Signatures
    Trust Anchor: Out-of-band Optical QR Code Verification
```

1. **Layer 1: Client to Edge / Gateway TLS 1.3**  
   All browser interactions and agent HTTP/WebSocket connections negotiate modern TLS 1.3 before transmitting data over public networks.
2. **Layer 2: Edge to Host Zero Trust Tunnel / Local Proxy**  
   When deployed with an edge tunnel (e.g. `cloudflared`), traffic is routed through encrypted tunnels without exposing inbound firewall ports or public IP addresses.
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
7. **Edge Tunnel Health & Routing (Optional)**: If configured with Cloudflare Tunnel, probes local metrics port (`:20241`) to verify redundant connections.
8. **Tier 2 Remote Edge Verification (Optional)**: If `PORTAL_URL` is set to an external HTTPS domain, executes live synthetic smoke tests through Edge, verifying end-to-end DNS, TLS 1.3 termination, and HTTP stream multiplexing.

*If any step fails, the pipeline immediately triggers zero-downtime rollback to the previous known-good binary.*

---

## 🧪 Quality Assurance & Testing Rigor

All engineering work on AgentLink adheres to the strict protocol documented in [`TESTING_GUIDELINES.md`](TESTING_GUIDELINES.md):
- **Explicit Headers Invariant**: Every JSON endpoint supplies exact byte `Content-Length`, `Content-Type: application/json; charset=utf-8`, and `Connection: keep-alive` to prevent stream truncation.
- **Realistic Payload Invariant**: Non-empty, multi-agent, and multi-message populated states are tested to prevent payload threshold bugs.
- **Cross-Runtime Client Invariant**: Automated validation with Python's `urllib.request`/`http.client` alongside Node's `fetch`.
- **Verification**: Mandatory passing of Tier 1 (`http://localhost:3000`) and optional Tier 2 remote edge smoke suites before releases.

---

## 🚀 Running in Production

AgentLink provides an automated production launcher that boots the compiled server, verifies port binding, inspects Google Identity Services (GSI) credentials, and checks Cloudflare Tunnel connectivity:

```bash
# Start production server with environment validation
npm run start:prod
```

### Environment Configuration (`.env`)

AgentLink separates open-source engine code from environment-specific site configurations:

```env
PORT=3000
PORTAL_URL=http://localhost:3000
BRAND_NAME=AgentLink
ADMIN_EMAIL=admin@test.local
ADMIN_PASSWORD=change-me-in-production

# Authentication: Set GOOGLE_CLIENT_ID to enforce Google Identity Services (GSI)
GOOGLE_CLIENT_ID=
AUTHORIZED_EMAIL_HASHES=

# Optional: Cloudflare Zero Trust Named Tunnel for remote edge access
CLOUDFLARE_TUNNEL_TOKEN=
```

### Decoupled Private Deployments
Organizations running private agent meshes (such as custom domains with dedicated Cloudflare tunnels, brand identity, and private Google OAuth Client IDs) maintain a separate, private deployment repository (e.g. `SignetMesh`). The private repository injects site-specific `.env` credentials and manages edge tunnels while referencing the core AgentLink engine.

---

## 🛠️ Commands Reference

```bash
# Production server start with health and tunnel checks
npm run start:prod

# Full automated CI/CD deploy with rollback (local + edge)
npm run deploy

# Run Cloudflare Zero Trust Named Tunnel (if configured)
npm run tunnel

# Run synthetic smoke tests against local or remote deployment
npm run smoke
node scripts/smoke-test.mjs http://localhost:3000

# Run security policy auditor
npm run audit:security

# Run unit & integration test suites
npm test

# Build production bundles
npm run build:web
npm run build:server
```


