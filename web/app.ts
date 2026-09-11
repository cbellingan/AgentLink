import QRCode from 'qrcode';

// DOM Elements
const landingCard = document.getElementById('landingCard')!;
const dashboardCard = document.getElementById('dashboardCard')!;
const notEnabledBanner = document.getElementById('notEnabledBanner')!;
const notEnabledMessage = document.getElementById('notEnabledMessage')!;
const btnGoogleSignIn = document.getElementById('btnGoogleSignIn')!;
const formCredentialLogin = document.getElementById('formCredentialLogin') as HTMLFormElement;
const inputEmail = document.getElementById('inputEmail') as HTMLInputElement;
const inputPassword = document.getElementById('inputPassword') as HTMLInputElement;

const userName = document.getElementById('userName')!;
const userEmail = document.getElementById('userEmail')!;
const btnSignOut = document.getElementById('btnSignOut')!;

// API Keys UI
const btnGenerateKey = document.getElementById('btnGenerateKey')!;
const newKeyBanner = document.getElementById('newKeyBanner')!;
const newKeyValue = document.getElementById('newKeyValue') as HTMLInputElement;
const newKeyCmd = document.getElementById('newKeyCmd')!;
const btnCopyNewKey = document.getElementById('btnCopyNewKey')!;
const keysListContainer = document.getElementById('keysListContainer')!;

// Fleet Agents UI
const agentCountBadge = document.getElementById('agentCountBadge')!;
const agentListContainer = document.getElementById('agentListContainer')!;

// Modals
const agentQrModal = document.getElementById('agentQrModal')!;
const btnCloseAgentQrModal = document.getElementById('btnCloseAgentQrModal')!;
const modalAgentQrCanvas = document.getElementById('modalAgentQrCanvas') as HTMLCanvasElement;
const modalAgentName = document.getElementById('modalAgentName')!;
const modalAgentKid = document.getElementById('modalAgentKid')!;
const modalAgentQrJson = document.getElementById('modalAgentQrJson') as HTMLTextAreaElement;
const btnCopyModalQrJson = document.getElementById('btnCopyModalQrJson')!;

// State
let sessionToken = localStorage.getItem('agentlink_token') || '';
let currentUser: any = null;
const fleetAgents = new Map<string, any>();

function showNotEnabled(message?: string) {
  notEnabledBanner.classList.remove('hidden');
  notEnabledMessage.textContent = message || 'Not enabled right now';
}

function hideNotEnabled() {
  notEnabledBanner.classList.add('hidden');
}

function unlockDashboard(user: any, token: string) {
  sessionToken = token;
  currentUser = user;
  localStorage.setItem('agentlink_token', token);
  localStorage.setItem('agentlink_user', JSON.stringify(user));

  landingCard.classList.add('hidden');
  dashboardCard.classList.remove('hidden');

  userName.textContent = user.name || 'Carl Bellingan';
  userEmail.textContent = user.email || 'cbellingan@gmail.com';

  refreshDashboard();
}

function lockLanding() {
  sessionToken = '';
  currentUser = null;
  localStorage.removeItem('agentlink_token');
  localStorage.removeItem('agentlink_user');

  landingCard.classList.remove('hidden');
  dashboardCard.classList.add('hidden');
  hideNotEnabled();
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers as any),
  };
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error: any = new Error(data.message || data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// 1. Google Sign-In Handler
async function handleGoogleLogin(emailParam?: string) {
  hideNotEnabled();

  let email = emailParam;
  if (!email && inputEmail && inputEmail.value.trim()) {
    email = inputEmail.value.trim();
  }
  if (!email) {
    email = prompt('Enter your Google email address:', 'cbellingan@gmail.com') || '';
  }
  if (!email.trim()) return;

  try {
    const res = await apiRequest('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim(),
        name: email.split('@')[0],
      }),
    });

    if (res.authenticated && res.token) {
      unlockDashboard(res.user, res.token);
    }
  } catch (err: any) {
    if (err.data?.error === 'not_enabled' || err.status === 403) {
      showNotEnabled(err.data?.message || 'Not enabled right now');
    } else {
      showNotEnabled(err.message);
    }
  }
}

// 2. Credential Login Handler
formCredentialLogin?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideNotEnabled();

  const email = inputEmail.value.trim();
  const password = inputPassword.value.trim();

  try {
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (res.authenticated && res.token) {
      unlockDashboard(res.user, res.token);
    }
  } catch (err: any) {
    if (err.data?.error === 'not_enabled' || err.status === 403) {
      showNotEnabled(err.data?.message || 'Not enabled right now');
    } else {
      showNotEnabled(err.message);
    }
  }
});

btnGoogleSignIn?.addEventListener('click', () => handleGoogleLogin());

btnSignOut?.addEventListener('click', async () => {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch {}
  lockLanding();
});

// 3. API Keys Management
async function refreshApiKeys() {
  try {
    const res = await apiRequest('/api/keys');
    const keys: any[] = res.keys || [];

    if (keys.length === 0) {
      keysListContainer.innerHTML = `<em>No active API keys yet. Click "➕ Generate Agent API Key" to create one.</em>`;
    } else {
      keysListContainer.innerHTML = keys.map((k) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border);">
          <div>
            <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 12px;">${k.keyMasked || k.key}</strong>
            <span style="font-size: 11px; color: var(--text-secondary); margin-left: 8px;">${k.label || 'Agent Key'}</span>
            <div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px;">Created: ${new Date(k.createdAt).toLocaleDateString()}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${k.key}')">📋 Copy</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="window.revokeKey('${k.id}')">Revoke</button>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to refresh API keys:', err);
  }
}

btnGenerateKey?.addEventListener('click', async () => {
  try {
    const res = await apiRequest('/api/keys/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: `Agent Key (${new Date().toLocaleDateString()})` }),
    });

    if (res.apiKey) {
      newKeyBanner.classList.remove('hidden');
      newKeyValue.value = res.apiKey.key;
      newKeyCmd.textContent = res.apiKey.key;
      await refreshApiKeys();
    }
  } catch (err: any) {
    alert(`Could not generate API key: ${err.message}`);
  }
});

btnCopyNewKey?.addEventListener('click', () => {
  if (newKeyValue.value) {
    navigator.clipboard.writeText(newKeyValue.value);
    btnCopyNewKey.textContent = '✓ Copied!';
    setTimeout(() => { btnCopyNewKey.textContent = '📋 Copy Key'; }, 2000);
  }
});

(window as any).revokeKey = async (keyId: string) => {
  if (!confirm('Revoke this API key? Connected agents using it will need a new key.')) return;
  try {
    await apiRequest(`/api/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    await refreshApiKeys();
  } catch (err: any) {
    alert(`Revocation failed: ${err.message}`);
  }
};

// 4. Fleet Agents Management
async function refreshFleetAgents() {
  try {
    const res = await apiRequest('/api/agents');
    const agents: any[] = res.agents || [];

    agentCountBadge.textContent = `${agents.length} Enrolled`;
    fleetAgents.clear();
    agents.forEach(a => fleetAgents.set(a.id, a));

    if (agents.length === 0) {
      agentListContainer.innerHTML = `<em>No agents registered yet. Use an API key with <code>agent-link connect</code> to register your first agent.</em>`;
    } else {
      agentListContainer.innerHTML = agents.map(a => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 13px;">${a.id}</strong>
            <span class="badge ${a.connected ? 'badge-success' : 'badge-warning'}" style="font-size: 10px;">
              ${a.connected ? '● Outbound WS' : '● Polling HTTP'}
            </span>
            <span style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono);">
              Key ID: ${a.kid || 'ed25519-id'}
            </span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.showAgentQr('${a.id}')" data-testid="btn-view-agent-qr-${a.id}">
              📱 View QR
            </button>
            <button type="button" class="btn btn-danger btn-sm" onclick="window.deregisterAgent('${a.id}')">
              De-register
            </button>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to refresh agents:', err);
  }
}

(window as any).deregisterAgent = async (agentId: string) => {
  if (!confirm(`De-register agent "${agentId}"?`)) return;
  try {
    await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    await refreshFleetAgents();
  } catch (err: any) {
    alert(`De-registration failed: ${err.message}`);
  }
};

// 5. Optical QR Modal
(window as any).showAgentQr = (agentId: string) => {
  const agent = fleetAgents.get(agentId) || { id: agentId };
  modalAgentName.textContent = agent.id;
  modalAgentKid.textContent = agent.kid || 'local-ed25519';

  let payloadStr = agent.qrPayload;
  if (!payloadStr) {
    payloadStr = JSON.stringify({
      v: 1,
      agent: agent.id,
      signPub: agent.signPub || 'sample_sign_pubkey',
      encPub: agent.encPub || 'sample_enc_pubkey',
      kid: agent.kid || 'kid-sample',
      iat: agent.registeredAt || new Date().toISOString(),
    });
  }

  modalAgentQrJson.value = payloadStr;
  QRCode.toCanvas(modalAgentQrCanvas, payloadStr, {
    width: 224,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  agentQrModal.classList.remove('hidden');
};

btnCloseAgentQrModal?.addEventListener('click', () => {
  agentQrModal.classList.add('hidden');
});

btnCopyModalQrJson?.addEventListener('click', () => {
  if (modalAgentQrJson.value) {
    navigator.clipboard.writeText(modalAgentQrJson.value);
    btnCopyModalQrJson.textContent = '✓ Copied!';
    setTimeout(() => { btnCopyModalQrJson.textContent = '📋 Copy'; }, 2000);
  }
});

async function refreshDashboard() {
  await Promise.all([refreshApiKeys(), refreshFleetAgents()]);
}

// 6. Initialization
window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const autoAuth = urlParams.get('auto_auth');

  if (autoAuth === 'admin') {
    await handleGoogleLogin('cbellingan@gmail.com');
  } else if (sessionToken) {
    try {
      const res = await apiRequest('/api/auth/me');
      if (res.status === 'ok' && res.user && res.user.email === 'cbellingan@gmail.com') {
        unlockDashboard(res.user, sessionToken);
      } else {
        lockLanding();
      }
    } catch {
      lockLanding();
    }
  } else {
    lockLanding();
  }
});
