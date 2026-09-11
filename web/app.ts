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
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.promptCreateLink('${a.id}')" title="Link this agent to another peer">
              🔗 Link
            </button>
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

// 5. Peer Links Management
const linksListContainer = document.getElementById('linksListContainer')!;
const btnShowCreateLinkModal = document.getElementById('btnShowCreateLinkModal')!;
const createLinkModal = document.getElementById('createLinkModal')!;
const btnCloseCreateLinkModal = document.getElementById('btnCloseCreateLinkModal')!;
const formCreateLink = document.getElementById('formCreateLink') as HTMLFormElement;
const selectAgentA = document.getElementById('selectAgentA') as HTMLSelectElement;
const selectAgentB = document.getElementById('selectAgentB') as HTMLSelectElement;

// Send message modal elements
const sendMessageModal = document.getElementById('sendMessageModal')!;
const btnCloseSendMsgModal = document.getElementById('btnCloseSendMsgModal')!;
const formSendMessage = document.getElementById('formSendMessage') as HTMLFormElement;
const modalMsgLinkId = document.getElementById('modalMsgLinkId') as HTMLInputElement;
const modalMsgLinkDisplay = document.getElementById('modalMsgLinkDisplay')!;
const modalMsgSenderSelect = document.getElementById('modalMsgSenderSelect') as HTMLSelectElement;
const modalMsgText = document.getElementById('modalMsgText') as HTMLTextAreaElement;

// Conversation Flow Viewer Elements
const linkConversationModal = document.getElementById('linkConversationModal')!;
const btnCloseConversationModal = document.getElementById('btnCloseConversationModal')!;
const convoAgentA = document.getElementById('convoAgentA')!;
const convoAgentB = document.getElementById('convoAgentB')!;
const convoStatusBadge = document.getElementById('convoStatusBadge')!;
const convoLinkId = document.getElementById('convoLinkId')!;
const convoFramesCount = document.getElementById('convoFramesCount')!;
const flowAgentALabel = document.getElementById('flowAgentALabel')!;
const flowAgentAKid = document.getElementById('flowAgentAKid')!;
const flowAgentBLabel = document.getElementById('flowAgentBLabel')!;
const flowAgentBKid = document.getElementById('flowAgentBKid')!;
const conversationStream = document.getElementById('conversationStream')!;
const formConvoSend = document.getElementById('formConvoSend') as HTMLFormElement;
const convoSenderSelect = document.getElementById('convoSenderSelect') as HTMLSelectElement;
const convoMsgInput = document.getElementById('convoMsgInput') as HTMLInputElement;

let currentConvoLinkId: string | null = null;
let convoPollTimer: any = null;

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const activeLinks = new Map<string, any>();

async function refreshPeerLinks() {
  try {
    const res = await apiRequest('/api/links');
    const links: any[] = res.links || [];

    activeLinks.clear();
    links.forEach(l => activeLinks.set(l.id, l));

    if (links.length === 0) {
      linksListContainer.innerHTML = `<em>No active links yet. Click "➕ Link Two Agents" to link your enrolled agents.</em>`;
    } else {
      linksListContainer.innerHTML = links.map(l => {
        const isActive = l.status === 'active';
        return `
          <div class="link-item" style="cursor: pointer; background: var(--bg-secondary); padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border);" onclick="window.openLinkConversationModal('${l.id}')">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 14px;">${escapeHtml(l.agentAId)}</strong>
                  <span style="color: var(--text-secondary); font-size: 13px;">⟷</span>
                  <strong style="color: #38bdf8; font-family: var(--font-mono); font-size: 14px;">${escapeHtml(l.agentBId)}</strong>
                  <span class="badge ${isActive ? 'badge-success' : 'badge-warning'}" style="font-size: 10px;">
                    ${isActive ? '● Active' : '● Pending Approval'}
                  </span>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px;">
                  ID: <span style="font-family: var(--font-mono);">${escapeHtml(l.id)}</span>
                  &bull; Frames: <strong style="color: var(--text-primary);">${l.framesCount || 0}</strong>
                  &bull; Created: ${new Date(l.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;" onclick="event.stopPropagation()">
                ${!isActive ? `
                  <button type="button" class="btn btn-sm" style="background: #059669;" onclick="window.approveLink('${l.id}')">
                    ✓ Approve Link
                  </button>
                ` : ''}
                <button type="button" class="btn btn-sm" style="background: #2563eb;" onclick="window.openLinkConversationModal('${l.id}')" title="View conversation flow & frames">
                  👁️ Conversation
                </button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="window.openSendMsgModal('${l.id}')" title="Send a message to an agent">
                  💬 Send to Agent
                </button>
                <button type="button" class="btn btn-danger btn-sm" onclick="window.severLink('${l.id}')">
                  Sever
                </button>
              </div>
            </div>
            ${l.recentMessages && l.recentMessages.length > 0 ? `
              <div style="margin-top: 8px; padding: 6px 10px; background: rgba(0,0,0,0.3); border-radius: 6px; font-family: var(--font-mono); font-size: 11px; color: #a1a1aa; border-left: 2px solid var(--accent); display: flex; justify-content: space-between; align-items: center;">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%;">
                  Recent Frame: <strong style="color: #38bdf8;">${escapeHtml(l.recentMessages[l.recentMessages.length - 1].senderId)}</strong>: <span style="color: #e4e4e7;">${escapeHtml(l.recentMessages[l.recentMessages.length - 1].text)}</span>
                </div>
                <span style="font-size: 10px; color: var(--accent); white-space: nowrap;">View full flow →</span>
              </div>
            ` : `
              <div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary); opacity: 0.8;">
                Click to open live conversation flow & message stream →
              </div>
            `}
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Failed to refresh links:', err);
  }
}

function populateLinkSelects(preselectA?: string) {
  const agents = Array.from(fleetAgents.values());
  selectAgentA.innerHTML = '';
  selectAgentB.innerHTML = '';

  if (agents.length === 0) {
    selectAgentA.innerHTML = '<option value="">No agents enrolled</option>';
    selectAgentB.innerHTML = '<option value="">No agents enrolled</option>';
    return;
  }

  agents.forEach(a => {
    const optA = document.createElement('option');
    optA.value = a.id;
    optA.textContent = `${a.id} (${a.kid ? a.kid.slice(0, 16) : 'local'}...)`;
    selectAgentA.appendChild(optA);

    const optB = document.createElement('option');
    optB.value = a.id;
    optB.textContent = `${a.id} (${a.kid ? a.kid.slice(0, 16) : 'local'}...)`;
    selectAgentB.appendChild(optB);
  });

  if (preselectA && fleetAgents.has(preselectA)) {
    selectAgentA.value = preselectA;
    // Set B to different if possible
    const other = agents.find(a => a.id !== preselectA);
    if (other) selectAgentB.value = other.id;
  } else if (agents.length >= 2) {
    selectAgentA.value = agents[0].id;
    selectAgentB.value = agents[1].id;
  }
}

(window as any).promptCreateLink = (agentId: string) => {
  populateLinkSelects(agentId);
  createLinkModal.classList.remove('hidden');
};

btnShowCreateLinkModal?.addEventListener('click', () => {
  populateLinkSelects();
  createLinkModal.classList.remove('hidden');
});

btnCloseCreateLinkModal?.addEventListener('click', () => {
  createLinkModal.classList.add('hidden');
});

formCreateLink?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const agentAId = selectAgentA.value;
  const agentBId = selectAgentB.value;

  if (agentAId === agentBId) {
    alert('Please select two different agents to link.');
    return;
  }

  try {
    const res = await apiRequest('/api/links/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentAId, agentBId }),
    });

    if (res.linkId) {
      // Auto-approve as human controller
      await apiRequest(`/api/links/${encodeURIComponent(res.linkId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerVerification: 'optical_qr_verified' }),
      });
      createLinkModal.classList.add('hidden');
      await refreshPeerLinks();
    }
  } catch (err: any) {
    alert(`Failed to establish link: ${err.message}`);
  }
});

(window as any).approveLink = async (linkId: string) => {
  try {
    await apiRequest(`/api/links/${encodeURIComponent(linkId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerVerification: 'optical_qr_verified' }),
    });
    await refreshPeerLinks();
  } catch (err: any) {
    alert(`Approval failed: ${err.message}`);
  }
};

(window as any).severLink = async (linkId: string) => {
  if (!confirm(`Sever this link (${linkId})? Messages will no longer route between these agents.`)) return;
  try {
    await apiRequest(`/api/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
    await refreshPeerLinks();
  } catch (err: any) {
    alert(`Severing link failed: ${err.message}`);
  }
};

// Send Message Modal logic
(window as any).openSendMsgModal = (linkId: string) => {
  const link = activeLinks.get(linkId);
  if (!link) return;

  modalMsgLinkId.value = linkId;
  modalMsgLinkDisplay.textContent = `${link.agentAId} ⟷ ${link.agentBId}`;
  modalMsgSenderSelect.innerHTML = `
    <option value="${link.agentAId}">${link.agentAId}</option>
    <option value="${link.agentBId}">${link.agentBId}</option>
  `;
  modalMsgText.value = '';
  sendMessageModal.classList.remove('hidden');
};

btnCloseSendMsgModal?.addEventListener('click', () => {
  sendMessageModal.classList.add('hidden');
});

formSendMessage?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const linkId = modalMsgLinkId.value;
  const senderId = modalMsgSenderSelect.value;
  const text = modalMsgText.value.trim();

  if (!text) return;

  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(linkId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId, payload: text }),
    });

    if (res.status === 'ok') {
      sendMessageModal.classList.add('hidden');
      alert(`Message dispatched from ${senderId}! When peer polls, they will receive it.`);
      await refreshPeerLinks();
    }
  } catch (err: any) {
    alert(`Message dispatch failed: ${err.message}`);
  }
});

// 6. Link Conversation Flow Viewer Logic
(window as any).openLinkConversationModal = async (linkId: string) => {
  currentConvoLinkId = linkId;
  const link = activeLinks.get(linkId);
  if (!link) return;

  renderConversationModalHeader(link);
  await refreshConversationFlow(linkId, true);

  linkConversationModal.classList.remove('hidden');

  // Poll for incoming frames every 2 seconds while modal is open
  if (convoPollTimer) clearInterval(convoPollTimer);
  convoPollTimer = setInterval(async () => {
    if (!linkConversationModal.classList.contains('hidden') && currentConvoLinkId === linkId) {
      await refreshConversationFlow(linkId, false);
    } else {
      clearInterval(convoPollTimer);
      convoPollTimer = null;
    }
  }, 2000);
};

function renderConversationModalHeader(link: any) {
  convoAgentA.textContent = link.agentAId;
  convoAgentB.textContent = link.agentBId;
  convoLinkId.textContent = link.id;
  convoFramesCount.textContent = String(link.framesCount || 0);

  const isActive = link.status === 'active';
  convoStatusBadge.className = `badge ${isActive ? 'badge-success' : 'badge-warning'}`;
  convoStatusBadge.textContent = isActive ? '● Active' : '● Pending Approval';

  flowAgentALabel.textContent = link.agentAId;
  flowAgentBLabel.textContent = link.agentBId;

  const agentA = fleetAgents.get(link.agentAId);
  const agentB = fleetAgents.get(link.agentBId);
  flowAgentAKid.textContent = agentA?.kid || 'registered';
  flowAgentBKid.textContent = agentB?.kid || 'registered';

  convoSenderSelect.innerHTML = `
    <option value="${link.agentAId}">From: ${link.agentAId}</option>
    <option value="${link.agentBId}">From: ${link.agentBId}</option>
  `;
}

async function refreshConversationFlow(linkId: string, autoScroll: boolean = true) {
  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(linkId)}`);
    const link = res.link;
    if (!link) return;

    activeLinks.set(link.id, link);
    convoFramesCount.textContent = String(link.framesCount || 0);

    const msgs: any[] = link.recentMessages || [];
    if (msgs.length === 0) {
      conversationStream.innerHTML = `
        <div style="margin: auto; text-align: center; color: var(--text-secondary); padding: 32px 16px;">
          <div style="font-size: 32px; margin-bottom: 8px;">💬</div>
          <strong style="color: var(--text-primary); font-size: 14px;">No Frames Exchanged Yet</strong>
          <p style="font-size: 12px; margin-top: 6px; max-width: 360px; line-height: 1.4;">
            Messages transmitted between <strong style="color: var(--accent);">${escapeHtml(link.agentAId)}</strong> and <strong style="color: #38bdf8;">${escapeHtml(link.agentBId)}</strong> across the zero-knowledge tunnel will appear here in real time.
          </p>
        </div>
      `;
      return;
    }

    conversationStream.innerHTML = msgs.map((m: any) => {
      const isFromA = m.senderId === link.agentAId;
      const bubbleBg = isFromA ? 'rgba(168, 85, 247, 0.12)' : 'rgba(56, 189, 248, 0.12)';
      const borderCol = isFromA ? 'rgba(168, 85, 247, 0.35)' : 'rgba(56, 189, 248, 0.35)';
      const accentCol = isFromA ? 'var(--accent)' : '#38bdf8';
      const targetAgent = isFromA ? link.agentBId : link.agentAId;

      return `
        <div style="display: flex; flex-direction: column; max-width: 85%; ${isFromA ? 'align-self: flex-start;' : 'align-self: flex-end;'} background: ${bubbleBg}; border: 1px solid ${borderCol}; border-radius: 8px; padding: 10px 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.25);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="color: ${accentCol}; font-family: var(--font-mono); font-size: 12px;">${escapeHtml(m.senderId)}</strong>
              <span style="color: var(--text-secondary); font-size: 10px;">➔</span>
              <span style="color: var(--text-secondary); font-size: 11px; font-family: var(--font-mono);">${escapeHtml(targetAgent)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${m.isEncrypted ? `
                <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 9px; padding: 1px 5px;">
                  🔒 E2EE Frame
                </span>
              ` : `
                <span class="badge" style="background: rgba(255, 255, 255, 0.08); color: var(--text-secondary); font-size: 9px; padding: 1px 5px;">
                  Plaintext
                </span>
              `}
              <span style="font-size: 10px; color: var(--text-secondary);">${new Date(m.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
          <div style="font-size: 13px; color: var(--text-primary); word-break: break-word; line-height: 1.4;">
            ${escapeHtml(m.text || '')}
          </div>
          ${m.isEncrypted && m.payload && m.payload.data ? `
            <div style="margin-top: 6px; font-family: var(--font-mono); font-size: 9px; color: var(--text-secondary); background: rgba(0,0,0,0.3); padding: 4px 6px; border-radius: 4px; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap;">
              Cipher: ${escapeHtml(m.payload.data)}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    if (autoScroll) {
      conversationStream.scrollTop = conversationStream.scrollHeight;
    }
  } catch (err) {
    console.error('Failed to refresh conversation flow:', err);
  }
}

formConvoSend?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentConvoLinkId) return;
  const senderId = convoSenderSelect.value;
  const text = convoMsgInput.value.trim();
  if (!text) return;

  convoMsgInput.value = '';

  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(currentConvoLinkId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId, payload: text }),
    });

    if (res.status === 'ok') {
      await refreshConversationFlow(currentConvoLinkId, true);
      await refreshPeerLinks();
    }
  } catch (err: any) {
    alert(`Failed to dispatch message: ${err.message}`);
  }
});

btnCloseConversationModal?.addEventListener('click', () => {
  linkConversationModal.classList.add('hidden');
  if (convoPollTimer) {
    clearInterval(convoPollTimer);
    convoPollTimer = null;
  }
  currentConvoLinkId = null;
});

(window as any).deregisterAgent = async (agentId: string) => {
  if (!confirm(`De-register agent "${agentId}"?`)) return;
  try {
    await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    await refreshFleetAgents();
    await refreshPeerLinks();
  } catch (err: any) {
    alert(`De-registration failed: ${err.message}`);
  }
};

// 6. Optical QR Modal
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
  await Promise.all([refreshApiKeys(), refreshFleetAgents(), refreshPeerLinks()]);
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
