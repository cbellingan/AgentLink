import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLinkServer } from '../server/agent-link-server.js';

const TEST_ADMIN_EMAIL = 'admin@test.local';

describe('Cross-Account Agent Mapping, Secure Email Invites, Dual-Approval & Zero-Noise Isolation', () => {
  let server: AgentLinkServer;
  let serverPort: number;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-dual-test-'));
    process.env.DATA_PATH = path.join(tempDir, 'state.json');
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(TEST_ADMIN_EMAIL).digest('hex');
    server = new AgentLinkServer(0);
    serverPort = await server.listen();
    baseUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    await server.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function apiPost(path: string, body: any, token?: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const req = http.request(`${baseUrl}${path}`, { method: 'POST', headers }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 500, data: raw });
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function apiGet(path: string, token?: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const req = http.request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 500, data: raw });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function apiDelete(path: string, token?: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const req = http.request(`${baseUrl}${path}`, { method: 'DELETE', headers }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 500, data: raw });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  let adminToken: string;
  let adminId: string;
  let wifeToken: string;
  let wifeId: string;
  let wifeApiKey: string;
  let adminApiKey: string;
  let linkId: string;

  it('1. Admin signs in successfully, but uninvited collaborator is blocked at gatekeeper', async () => {
    // Admin signs in
    const adminRes = await apiPost('/api/auth/google', { email: TEST_ADMIN_EMAIL, name: 'Primary Administrator' });
    expect(adminRes.status).toBe(200);
    expect(adminRes.data.authenticated).toBe(true);
    expect(adminRes.data.user.role).toBe('admin');
    adminToken = adminRes.data.token;
    adminId = adminRes.data.user.id;

    // Uninvited collaborator attempts login
    const strangerRes = await apiPost('/api/auth/google', { email: 'stranger@example.com', name: 'Stranger' });
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.data.error).toBe('not_enabled');
    expect(strangerRes.data.message).toContain('Not enabled right now');
  });

  it('2. Admin issues an email invite for wife@example.com; collaborator is admitted past gatekeeper', async () => {
    // Admin creates invite
    const inviteRes = await apiPost('/api/invites', {
      toEmail: 'wife@example.com',
      note: 'Inviting spouse to link household assistant agents',
    }, adminToken);
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.data.invite).toBeDefined();
    expect(inviteRes.data.invite.recipientEmail).toBe('wife@example.com');
    expect(inviteRes.data.inviteUrl).toContain('/?invite=tok_');
    expect(inviteRes.data.emailTemplate).toBeDefined();

    const inviteToken = inviteRes.data.invite.token;

    // Wife logs in using the invite
    const wifeRes = await apiPost('/api/auth/google', {
      email: 'wife@example.com',
      name: 'Secondary Collaborator',
      inviteToken,
    });
    expect(wifeRes.status).toBe(200);
    expect(wifeRes.data.authenticated).toBe(true);
    expect(wifeRes.data.user.email).toBe('wife@example.com');
    expect(wifeRes.data.user.role).toBe('collaborator');
    wifeToken = wifeRes.data.token;
    wifeId = wifeRes.data.user.id;
    expect(wifeId).not.toBe(adminId);
  });

  it('3. Both humans generate scoped API keys; keys are strictly mapped to their ownerHumanId', async () => {
    // Admin generates key
    const adminKeyRes = await apiPost('/api/keys', { label: 'Admin Primary Agent' }, adminToken);
    expect(adminKeyRes.status).toBe(201);
    adminApiKey = adminKeyRes.data.apiKey.key;
    expect(adminKeyRes.data.apiKey.ownerHumanId).toBe(adminId);

    // Wife generates key
    const wifeKeyRes = await apiPost('/api/keys', { label: 'Wife Phone Agent' }, wifeToken);
    expect(wifeKeyRes.status).toBe(201);
    wifeApiKey = wifeKeyRes.data.apiKey.key;
    expect(wifeKeyRes.data.apiKey.ownerHumanId).toBe(wifeId);
    expect(wifeApiKey).not.toBe(adminApiKey);

    // Verify key scoping: Wife can only see her key
    const wifeKeysList = await apiGet('/api/keys', wifeToken);
    expect(wifeKeysList.status).toBe(200);
    expect(wifeKeysList.data.keys.some((k: any) => k.key === wifeApiKey)).toBe(true);
    expect(wifeKeysList.data.keys.some((k: any) => k.key === adminApiKey)).toBe(false);
  });

  it('3b. Agent with valid API key generates email invite on behalf of human owner', async () => {
    // Agent 'puck' uses adminApiKey to create an invite
    const agentInviteRes = await apiPost('/api/invites', {
      toEmail: 'collaborator@example.com',
      fromAgentId: 'puck',
      note: 'Autonomous agent Puck requesting peer collaboration',
    }, adminApiKey);

    expect(agentInviteRes.status).toBe(201);
    expect(agentInviteRes.data.invite).toBeDefined();
    expect(agentInviteRes.data.invite.fromAgentId).toBe('puck');
    expect(agentInviteRes.data.invite.recipientEmail).toBe('collaborator@example.com');
    expect(agentInviteRes.data.invite.inviterHumanId).toBe(adminId);
    expect(agentInviteRes.data.inviteUrl).toContain('/?invite=tok_');
    expect(agentInviteRes.data.emailTemplate.subject).toContain("Autonomous agent 'puck'");

    // Agent queries invite list
    const agentListRes = await apiGet('/api/invites', adminApiKey);
    expect(agentListRes.status).toBe(200);
    expect(agentListRes.data.invites.some((inv: any) => inv.recipientEmail === 'collaborator@example.com')).toBe(true);
  });

  it('3c. Unauthenticated request to POST /api/invites is rejected with 401 without socket reset', async () => {
    const unauthRes = await apiPost('/api/invites', {
      toEmail: 'unauth@example.com',
      fromAgentId: 'puck',
      note: 'Testing missing auth',
    });
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.data.error).toBe('unauthorized');
  });

  it('4. Agents register using their respective API keys; ownerHumanId is bound server-side', async () => {
    // Register Agent Alice under Admin's key
    const aliceRes = await apiPost('/api/agents/register', {
      id: 'agent-alice',
      signPub: 'alice_sign_pub_key_123',
      encPub: 'alice_enc_pub_key_123',
      kid: 'kid-alice-001',
    }, adminApiKey);
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.data.agent.ownerHumanId).toBe(adminId);

    // Register Agent Bob under Wife's key
    const bobRes = await apiPost('/api/agents/register', {
      id: 'agent-bob',
      signPub: 'bob_sign_pub_key_456',
      encPub: 'bob_enc_pub_key_456',
      kid: 'kid-bob-002',
    }, wifeApiKey);
    expect(bobRes.status).toBe(200);
    expect(bobRes.data.agent.ownerHumanId).toBe(wifeId);

    // Register Agent Charlie under Admin's key (for cross-link isolation probe)
    const charlieRes = await apiPost('/api/agents/register', {
      id: 'agent-charlie',
      signPub: 'charlie_sign_pub_789',
      encPub: 'charlie_enc_pub_789',
      kid: 'kid-charlie-003',
    }, adminApiKey);
    expect(charlieRes.status).toBe(200);
    expect(charlieRes.data.agent.ownerHumanId).toBe(adminId);
  });

  it('5. Link request between cross-account agents creates a pending link requiring 2-of-2 human approvals', async () => {
    const linkReqRes = await apiPost('/api/links/request', {
      agentAId: 'agent-alice',
      agentBId: 'agent-bob',
      initiatorHumanId: adminId,
      responderHumanId: wifeId,
    }, adminToken);
    expect(linkReqRes.status).toBe(200);
    const link = linkReqRes.data.link;
    linkId = link.id;

    expect(link.status).toBe('pending_approval');
    expect(link.initiatorHumanId).toBe(adminId);
    expect(link.responderHumanId).toBe(wifeId);
    expect(link.approvals[adminId]).toBe(false);
    expect(link.approvals[wifeId]).toBe(false);
  });

  it('6. Strict Ingress Gate: Messages are REJECTED with 403 while link is pending 0/2 approvals', async () => {
    const sendRes = await apiPost(`/api/links/${linkId}/send`, {
      senderId: 'agent-alice',
      payload: { data: 'ciphertext_unapproved_1', sig: 'sig1', seq: 1 },
    }, adminApiKey);
    expect(sendRes.status).toBe(403);
    expect(sendRes.data.error).toBe('link_not_approved');
    expect(sendRes.data.message).toContain('pending_approval');

    // Verify unauthenticated poll is rejected with 401
    const unauthPoll = await apiGet('/api/agents/agent-bob/poll?timeout=100');
    expect(unauthPoll.status).toBe(401);
    expect(unauthPoll.data.error).toBe('unauthorized');

    // Verify cross-operator unauthorized poll is rejected with 403
    const crossPoll = await apiGet('/api/agents/agent-bob/poll?timeout=100', adminApiKey);
    expect(crossPoll.status).toBe(403);
    expect(crossPoll.data.error).toBe('forbidden');

    // Verify Bob's queue is completely empty when polled with Bob's key
    const bobPoll = await apiGet('/api/agents/agent-bob/poll?timeout=100', wifeApiKey);
    expect(bobPoll.status).toBe(200);
    expect(bobPoll.data.messages.length).toBe(0);
  });

  it('7. Partial Approval (1/2): Admin approves, but link remains pending_approval and traffic is STILL blocked', async () => {
    // Admin approves
    const adminApproveRes = await apiPost(`/api/links/${linkId}/approve`, {}, adminToken);
    expect(adminApproveRes.status).toBe(200);
    const link = adminApproveRes.data.link;
    expect(link.approvals[adminId]).toBe(true);
    expect(link.approvals[wifeId]).toBe(false);
    expect(link.status).toBe('pending_approval');

    // Alice attempts to send again -> still rejected!
    const sendRes = await apiPost(`/api/links/${linkId}/send`, {
      senderId: 'agent-alice',
      payload: { data: 'ciphertext_unapproved_2', sig: 'sig2', seq: 1 },
    }, adminApiKey);
    expect(sendRes.status).toBe(403);
    expect(sendRes.data.error).toBe('link_not_approved');
  });

  it('8. Complete Approval (2/2): Wife approves; link transitions to active and messages flow', async () => {
    // Wife approves
    const wifeApproveRes = await apiPost(`/api/links/${linkId}/approve`, {}, wifeToken);
    expect(wifeApproveRes.status).toBe(200);
    const link = wifeApproveRes.data.link;
    expect(link.approvals[adminId]).toBe(true);
    expect(link.approvals[wifeId]).toBe(true);
    expect(link.status).toBe('active');

    // Alice sends E2EE payload across link
    const sendRes = await apiPost(`/api/links/${linkId}/send`, {
      senderId: 'agent-alice',
      payload: { data: 'e2ee_ciphertext_approved_secret', sig: 'sig_valid', seq: 1 },
    }, adminApiKey);
    expect(sendRes.status).toBe(200);
    expect(sendRes.data.status).toBe('ok');

    // Bob polls and receives the message
    const bobPoll = await apiGet('/api/agents/agent-bob/poll?timeout=200', wifeApiKey);
    expect(bobPoll.status).toBe(200);
    expect(bobPoll.data.messages.length).toBe(1);
    expect(bobPoll.data.messages[0].senderId).toBe('agent-alice');
    expect(bobPoll.data.messages[0].payload.data).toBe('e2ee_ciphertext_approved_secret');
  });

  it('9. Zero-Noise Isolation: Messages on Link 1 are NEVER delivered to outside agent Charlie', async () => {
    // Send 10 more messages on Link 1 (Alice -> Bob)
    for (let i = 2; i <= 11; i++) {
      const res = await apiPost(`/api/links/${linkId}/send`, {
        senderId: 'agent-alice',
        payload: { data: `secret_msg_${i}`, sig: `sig_${i}`, seq: i },
      }, adminApiKey);
      expect(res.status).toBe(200);
    }

    // Agent Charlie (on outside link) polls with Charlie's key
    const charliePoll = await apiGet('/api/agents/agent-charlie/poll?timeout=100', adminApiKey);
    expect(charliePoll.status).toBe(200);
    // Strict Invariant: Exactly zero noise leaked to Charlie
    expect(charliePoll.data.messages.length).toBe(0);

    // Bob drains all 10 messages with Bob's key
    const bobPoll = await apiGet('/api/agents/agent-bob/poll?timeout=100', wifeApiKey);
    expect(bobPoll.status).toBe(200);
    expect(bobPoll.data.messages.length).toBe(10);
  });

  it('10. Outsider Injection Defense: Agent Charlie cannot inject messages into Link 1 (Alice <-> Bob)', async () => {
    const injectRes = await apiPost(`/api/links/${linkId}/send`, {
      senderId: 'agent-charlie',
      payload: { data: 'malicious_injected_noise', sig: 'fake_sig', seq: 1 },
    }, adminApiKey);
    expect(injectRes.status).toBe(403);
    expect(injectRes.data.error).toBe('forbidden_participant');
    expect(injectRes.data.message).toContain('not an authorized participant');
  });

  it('11. Agent Link Request Pipeline: Requests via /api/links/request create pending_approval links', async () => {
    // Agent Alice requests link with Agent Charlie using agent API key
    const reqRes = await apiPost('/api/links/request', {
      agentAId: 'agent-alice',
      agentBId: 'agent-charlie',
      note: 'Connecting Alice and Charlie',
    }, adminApiKey);
    expect(reqRes.status).toBe(200);
    expect(reqRes.data.status).toBe('ok');
    expect(reqRes.data.link.status).toBe('pending_approval');
    expect(reqRes.data.link.agentAId).toBe('agent-alice');
    expect(reqRes.data.link.agentBId).toBe('agent-charlie');
    expect(reqRes.data.link.approvals[adminId]).toBe(false);

    // Verify it appears in GET /api/links for authenticated user
    const linksRes = await apiGet('/api/links', adminToken);
    expect(linksRes.status).toBe(200);
    const foundLink = linksRes.data.links.find((l: any) => l.id === reqRes.data.link.id);
    expect(foundLink).toBeDefined();
    expect(foundLink.status).toBe('pending_approval');
  });

  it('12. Targeted Invites & Management: Invite with targetAgentId creates pending link, surfaces in /api/invites, and can be dismissed', async () => {
    // Create invite targeting agent-bob
    const inviteRes = await apiPost('/api/invites', {
      toEmail: 'newpartner@test.local',
      agentId: 'agent-alice',
      targetAgentId: 'agent-bob',
      note: 'Join mesh to link with Alice',
    }, adminToken);
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.data.status).toBe('ok');
    const inviteId = inviteRes.data.invite.id;

    // Verify GET /api/invites lists this invite
    const invitesRes = await apiGet('/api/invites', adminToken);
    expect(invitesRes.status).toBe(200);
    const foundInvite = invitesRes.data.invites.find((inv: any) => inv.id === inviteId);
    expect(foundInvite).toBeDefined();
    expect(foundInvite.fromAgentId).toBe('agent-alice');
    expect(foundInvite.targetAgentId).toBe('agent-bob');

    // Dismiss / delete the invite
    const delRes = await apiDelete(`/api/invites/${inviteId}`, adminToken);
    expect(delRes.status).toBe(200);
    expect(delRes.data.status).toBe('ok');

    // Confirm it's removed from /api/invites
    const afterInvitesRes = await apiGet('/api/invites', adminToken);
    expect(afterInvitesRes.status).toBe(200);
    const stillPresent = afterInvitesRes.data.invites.find((inv: any) => inv.id === inviteId);
    expect(stillPresent).toBeUndefined();
  });

  it('13. Secret-Free Connection Notices & Human-to-Agent Prompts: Invites carry 0 bearer credentials in notice body and generate agent prompts', async () => {
    const inviteRes = await apiPost('/api/invites', {
      toEmail: 'partner@example.com',
      agentId: 'agent-alice',
      targetAgentId: 'agent-bob',
      note: 'Household task sync',
    }, adminToken);
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.data.status).toBe('ok');

    // Verify mutual Safety Number
    expect(inviteRes.data.safetyNumber).toMatch(/^\d{3}-\d{3}$/);
    expect(inviteRes.data.invite.safetyNumber).toBe(inviteRes.data.safetyNumber);

    // Verify human-to-agent prompt instructions
    expect(inviteRes.data.agentPrompt).toBeDefined();
    expect(inviteRes.data.agentPrompt).toContain('You are invited to establish an end-to-end encrypted (E2EE v2) peer link');
    expect(inviteRes.data.agentPrompt).toContain(inviteRes.data.safetyNumber);
    expect(inviteRes.data.agentPrompt).toContain('agent-alice');

    // Verify email notice template is strictly secret-free in its body
    const emailBody = inviteRes.data.emailTemplate.body;
    expect(emailBody).toContain('Zero-Credential Notice');
    expect(emailBody).toContain(`Safety Number (${inviteRes.data.safetyNumber})`);
    expect(emailBody).toContain('Human-to-Agent Instructions:');
    // Notice body must NOT contain the bearer token
    expect(emailBody).not.toContain(inviteRes.data.invite.token);
  });

  it('14. Fingerprint-Bound Approval Ceremony: Approval records confirmed Key ID and Safety Number', async () => {
    // Request fresh link between Alice and Bob
    const linkRes = await apiPost('/api/links/request', {
      agentAId: 'agent-alice',
      agentBId: 'agent-bob',
      initiatorHumanId: adminId,
      responderHumanId: wifeId,
    }, adminApiKey);
    expect(linkRes.status).toBe(200);
    const linkObj = linkRes.data.link;
    expect(linkObj.safetyNumber).toMatch(/^\d{3}-\d{3}$/);
    expect(linkObj.agentPrompt).toContain(linkObj.safetyNumber);

    // Admin approves with Safety Number confirmation
    const approveRes = await apiPost(`/api/links/${linkObj.id}/approve`, {
      safetyNumber: linkObj.safetyNumber,
      peerVerification: 'optical_qr_verified',
    }, adminToken);
    expect(approveRes.status).toBe(200);
    const updatedLink = approveRes.data.link;
    expect(updatedLink.approvals[adminId]).toBe(true);
    expect(updatedLink.approvalDetails).toBeDefined();
    expect(updatedLink.approvalDetails[adminId].approved).toBe(true);
    expect(updatedLink.approvalDetails[adminId].confirmedSafetyNumber).toBe(linkObj.safetyNumber);
    expect(updatedLink.approvalDetails[adminId].confirmedKid).toBe('kid-alice-001');
  });

  it('15. Strict Approval Ceremony: Rejects approval when confirmed Safety Number or Key ID does not match', async () => {
    const linkRes = await apiPost('/api/links/request', {
      agentAId: 'agent-alice',
      agentBId: 'agent-bob',
      initiatorHumanId: adminId,
      responderHumanId: wifeId,
    }, adminApiKey);
    expect(linkRes.status).toBe(200);
    const linkObj = linkRes.data.link;

    // Attempt approval with wrong Safety Number
    const badSafetyRes = await apiPost(`/api/links/${linkObj.id}/approve`, {
      safetyNumber: '999-999',
    }, adminToken);
    expect(badSafetyRes.status).toBe(400);
    expect(badSafetyRes.data.error).toBe('safety_number_mismatch');

    // Attempt approval with wrong Key ID
    const badKidRes = await apiPost(`/api/links/${linkObj.id}/approve`, {
      kid: 'kid-fake-attacker',
    }, adminToken);
    expect(badKidRes.status).toBe(400);
    expect(badKidRes.data.error).toBe('kid_mismatch');
  });

  it('16. Key Rotation Invariant: Key rotation automatically demotes active link and revokes approvals', async () => {
    const linkRes = await apiPost('/api/links/request', {
      agentAId: 'agent-alice',
      agentBId: 'agent-bob',
      initiatorHumanId: adminId,
      responderHumanId: wifeId,
    }, adminApiKey);
    const linkId = linkRes.data.link.id;

    // Both humans approve with genuine Safety Number
    const safetyNumber = linkRes.data.link.safetyNumber;
    const a1 = await apiPost(`/api/links/${linkId}/approve`, { safetyNumber }, adminToken);
    expect(a1.status).toBe(200);
    const a2 = await apiPost(`/api/links/${linkId}/approve`, { safetyNumber }, wifeToken);
    expect(a2.status).toBe(200);
    expect(a2.data.link.status).toBe('active');

    // Now Agent Bob attempts unauthorized key rotation (rejected with 409)
    const unauthRotate = await apiPost('/api/agents', {
      agentId: 'agent-bob',
      ownerHumanId: wifeId,
      kid: 'kid-bob-rotated-999',
      signPub: 'bob_sign_pub_key_rotated',
      encPub: 'bob_enc_pub_key_rotated',
    }, wifeApiKey);
    expect(unauthRotate.status).toBe(409);
    expect(unauthRotate.data.error).toBe('key_rotation_requires_authorization');

    // Authorized key rotation succeeds
    const rotateRes = await apiPost('/api/agents', {
      agentId: 'agent-bob',
      ownerHumanId: wifeId,
      kid: 'kid-bob-rotated-999',
      signPub: 'bob_sign_pub_key_rotated',
      encPub: 'bob_enc_pub_key_rotated',
      allowRotation: true,
    }, wifeApiKey);
    expect(rotateRes.status).toBe(200);

    // Link must now be demoted to pending_approval, and approvals cleared
    const checkLinkRes = await apiGet(`/api/links/${linkId}`, adminToken);
    expect(checkLinkRes.status).toBe(200);
    expect(checkLinkRes.data.link.status).toBe('pending_approval');
    expect(checkLinkRes.data.link.safetyNumber).not.toBe(safetyNumber);
    expect(checkLinkRes.data.link.approvals[adminId]).toBe(false);
  });

  it('17. Public Auth Configuration: GET /api/auth/config exposes GIS configuration', async () => {
    const configRes = await apiGet('/api/auth/config');
    expect(configRes.status).toBe(200);
    expect(configRes.data.status).toBe('ok');
    expect('googleClientId' in configRes.data).toBe(true);
  });

  it('18. Google ID Token Verification: Invalid or tampered Google token is rejected with 401', async () => {
    const badTokenRes = await apiPost('/api/auth/google', {
      credential: 'invalid.tampered.fake_google_jwt_token',
    });
    expect(badTokenRes.status).toBe(401);
    expect(badTokenRes.data.error).toBe('invalid_credential');
  });

  it('19. Production Gatekeeper Invariant: Plain email login rejected in production mode without Google ID token', async () => {
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const prodRes = await apiPost('/api/auth/google', {
        email: 'user@example.com',
      });
      expect(prodRes.status).toBe(401);
      expect(prodRes.data.error).toBe('credential_required');

      // Milestone 4: Test secret bypass header is strictly forbidden and rejected in production
      const testBypassRes = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-auth-secret': 'test_sec_mesh_secret_2026',
        },
        body: JSON.stringify({ email: TEST_ADMIN_EMAIL }),
      });
      expect(testBypassRes.status).toBe(401);
      const testBypassBody = await testBypassRes.json();
      expect(testBypassBody.error).toBe('credential_required');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

