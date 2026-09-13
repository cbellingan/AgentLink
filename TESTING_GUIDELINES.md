# AgentLink Testing & Planning Guidelines

## Purpose
This document establishes the mandatory engineering standards, testing protocols, and planning checklists for all changes to AgentLink (server, web interface, Cloudflare edge, and client SDKs/CLIs). Following these rules ensures that network streaming, serialization, edge proxies, and cross-language runtime differences never cause silent drops or production outages.

## Rule 0: Production is Holy (Strict Environment Separation)

Production is live, connected to the Cloudflare Zero Trust Named Tunnel (`https://agent.signetmesh.com`), and hosts real human keys and peer links. **Prod must be treated with due respect**:
1. **Port Separation**:
   - **Production**: Strictly Port `3000` (`NODE_ENV=production PORT=3000`).
   - **Development**: Dedicated Port `3001` (`NODE_ENV=development PORT=3001` or `npm run dev`).
   - **Automated Tests**: Ephemeral ports (`PORT=0`) with temporary directories.
2. **State & Database Isolation**:
   - **Production State**: Strictly isolated at `.data/prod/agent-link-state.json`.
   - **Dev State**: Isolated at `.data/dev/agent-link-state.json`.
   - **Test Suites**: Isolated ephemeral `/tmp` state files (`state.json`), cleaned up on suite teardown.
3. **Zero Test Contamination on Prod**:
   - Never run test scripts, registration tests, or experimental synthetic agents (`mesh-test`, `mesh-a`, `agent`) against Port 3000 or `https://agent.signetmesh.com`.
   - All tests against production must be strictly **read-only / non-mutating** (`npm run smoke:prod`).
   - Mutating and exploratory end-to-end tests must target the dev instance on Port `3001` (`npm run smoke:dev`).

---

## Rule 1: Always Reproduce Before Fixing (Red-Green-Refactor For Every Bug)

Whenever investigating or diagnosing any bug, anomaly, or regression:
1. **Never jump straight to writing a fix**: Do not change application logic until the bug is proven and reproducible in an automated test.
2. **Step 1 — The Reproduction Test (Red Phase)**:
   - Write a unit, integration, or synthetic test that directly triggers the reported symptom (e.g. socket reset, truncated chunk, authorization bypass, or timeout).
   - Execute the test and confirm that it **fails** for the exact reason observed in production or reported by the client/peer.
3. **Step 2 — The Minimal Targeted Fix (Green Phase)**:
   - Implement the targeted architectural or code fix.
   - Run the reproduction test and confirm that it turns **green** without side effects.
4. **Step 3 — Permanent Regression Barrier**:
   - The reproduction test must **never be deleted or discarded**. It is permanently committed to the test suite (`tests/server.test.ts`, `tests/test_cli.py`, or `scripts/smoke-test.mjs`), ensuring that our automated test base continuously grows stronger and that the issue can never silently re-occur.

---

## The 5 Invariants of Transport & API Design

Whenever designing, modifying, or testing any endpoint, client SDK, or deployment script, the following five invariants must be strictly enforced:

### 1. Explicit Headers Invariant
Every JSON endpoint response MUST provide explicit HTTP headers before any body transmission:
- `Content-Length`: Must match `Buffer.byteLength(jsonString, 'utf8')` exactly. Never rely on Node.js default chunked transfer encoding (`Transfer-Encoding: chunked`) for JSON list or entity payloads.
- `Content-Type`: Must be `application/json; charset=utf-8`.
- `Connection`: Must specify `keep-alive` for standard HTTP/1.1 or rely on HTTP/2 stream multiplexing without abrupt socket termination.
- **Safety Wrapper**: Serialization must be wrapped in `try/catch` using the central `sendJson(res, statusCode, data)` helper so that serialization failures return a clean `500` JSON error rather than mid-stream socket resets.

### 2. Realistic Payload Invariant
**Never test endpoints solely against empty arrays `[]` or 1-byte mocks.**
- Serialization defects and chunking desync bugs only manifest when payloads cross network buffer thresholds (e.g., > 1 KB).
- Automated tests and smoke probes must seed realistic states: multiple registered agents, multiple approved links, and multi-message conversation histories.
- List endpoints (`GET /api/links`) must sanitize or compact verbose sub-fields (such as message histories) to lightweight previews, while detail endpoints (`GET /api/links/:id`) serve full payloads.

### 3. Cross-Runtime Client Invariant
AgentLink is a multi-language ecosystem. The relay server runs on Node.js, but clients run in Python, shell, browser JavaScript, and MCP sidecars.
- **Never verify only with Node's `fetch()`**: Node's fetch / `undici` engine auto-buffers chunked HTTP/1.1 streams and silently tolerates missing `Content-Length`.
- **Mandatory Python Validation**: All changes affecting endpoints must be verified with Python's standard library `urllib.request` / `http.client`. Python enforces strict chunk trailer parsing and raises `http.client.IncompleteRead` if a proxy drops mid-stream.
- **Mandatory `curl -i` Check**: Inspect the raw HTTP response headers (`Content-Length`, `Content-Type`, HTTP status code) directly.

### 4. Dual-Tier Verification Invariant (Local + Public Edge)
A feature or bug fix is NOT verified until it passes through both tiers:
1. **Tier 1 (Local Loopback)**: `http://localhost:3000` — validates process logic, authorization, database mutations, and unit contracts.
2. **Tier 2 (Public Edge & Named Tunnel)**: `https://agent.signetmesh.com` — validates real DNS resolution, TLS 1.3 edge termination, Cloudflare QUIC/HTTP2-to-HTTP1.1 proxy handoff, and Cloudflare Zero Trust tunnel multiplexing.

### 5. Full Route Matrix Coverage
Every exposed route in the API must be exercised in synthetic smoke tests, including:
- `GET /api/server-info`
- `GET /api/health`
- `POST /api/auth/google` (unauthorized + authorized)
- `GET /api/agents` (fleet listing)
- `GET /api/agents/:id` (single agent lookup)
- `GET /api/links` (unfiltered list)
- `GET /api/links?agentId=<id>` (filtered link list)
- `GET /api/links/:linkId` (single link detail)
- `GET /api/agents/:id/poll` (agent message inbox poll)
- `WS /ws` (real-time WebSocket handshake)

---

## Mandatory Planning Mode Checklist

When writing an implementation plan for any feature or bug fix that touches networking, serialization, authentication, routing, or client communication, the plan **MUST** include a dedicated "Cross-Transport & Multi-Client Verification" section with this checklist:

```markdown
### Cross-Transport & Multi-Client Verification Checklist
- [ ] Explicit `Content-Length` and `Content-Type` verified via `curl -i`.
- [ ] Non-empty payload test executed (state populated with >1 entity and >1 message).
- [ ] Python client validation executed (`python3 -m unittest` and live client script).
- [ ] Tier 1 local smoke test passed (`node scripts/smoke-test.mjs http://localhost:3000`).
- [ ] Tier 2 edge smoke test passed (`node scripts/smoke-test.mjs https://agent.signetmesh.com`).
- [ ] Stale process check: verify `lsof -t -i:3000 -sTCP:LISTEN` points only to the new PID.
```

---

## CI/CD Pipeline Enforcement

The CI/CD deployment script (`scripts/deploy-local.mjs`) enforces this workflow automatically:

1. **Step 1**: Preflight Lint, Typecheck & Security Audit (`scripts/security-auditor.mjs`).
2. **Step 2**: Vitest Server Tests & Python CLI Discover Tests.
3. **Step 3**: Atomic Backup of running server binaries.
4. **Step 4**: Build Web Frontend & Server Binaries.
5. **Step 5**: Graceful Local Process Restart (killing stale LISTEN sockets).
6. **Step 6**: Tier 1 Post-Deployment Synthetic Smoke Testing (`http://localhost:3000`) with Python client validation.
7. **Step 7**: Cloudflare Named Tunnel Status Verification.
8. **Step 8**: Tier 2 Public Edge Verification (`https://agent.signetmesh.com`) through Cloudflare edge.
9. **Automatic Rollback**: Any failure in Steps 1–8 automatically triggers zero-downtime rollback to the previous binary.

---

## Rule 2: Branch on High-Risk or Critical Changes

Whenever planning or implementing high-risk, breaking, or critical architectural modifications (e.g. cryptography primitives, envelope schema changes, authentication gatekeepers, network socket behavior, or database migrations):
1. **Branch First**: Do not work directly on `main`. Create a dedicated feature/security branch (`git checkout -b sec/...` or `feat/...`).
2. **Develop & Verify in Isolation**: Implement the red-first tests and fixes on the branch, running all unit, integration, and cross-project test suites.
3. **Merge When Ready**: Merge back into `main` only after full verification passes, preserving an unbroken, deployable `main` branch at all times.
