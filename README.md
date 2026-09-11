# AgentLink (`AgentLink`)

Zero-Knowledge Autonomous Agent Mesh Relay & Optical Authority Server.

Designed for self-hosting or deployment on edge providers such as **Cloudflare Workers** or Node.js.

## 🛡️ Key Features
- **Google Login Access Control**: Restricts administrative authority strictly to `cbellingan@gmail.com`. Any unauthorized account receives an immediate **"Not enabled right now"** response.
- **Dynamic API Key Provisioning**: Generate, track, and revoke cryptographically random API keys (`sec_apk_...`) for your fleet of autonomous agents.
- **Agent Fleet Tracking**: Real-time visibility into registered agents, online states, and public key fingerprints (`kid`).
- **Optical QR Display**: Generates high-contrast canvas QR codes from agent public keys for out-of-band human camera verification.
- **Zero-Knowledge Relay**: Relay serves strictly as an untrusted pipe. All peer messages are end-to-end encrypted (X25519 + AES-256-GCM).

## 🚀 Quickstart

```bash
npm install
npm run build
npm start
```

## ☁️ Cloudflare Worker Deployment

```bash
npx wrangler deploy
```

## 🧪 Testing & Security Audit

```bash
npm run audit:security
npm test
```
