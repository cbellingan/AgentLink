/**
 * Feature 11 Acceptance Test Suite: Narrow Control-Plane / Data-Plane Boundary
 *
 * Verifies:
 * 1. Standalone Data Plane runs with zero web assets or Google OAuth dependencies.
 * 2. Pure local forwarding authorization against cached policy snapshots.
 * 3. Policy synchronization and instantaneous revocation propagation.
 * 4. Control plane restart resilience within the freshness window.
 * 5. Bounded policy staleness/expiry resulting in HTTP 503 and degraded status.
 * 6. Decomposed /health checks returning 503 upon data plane impairment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AgentLinkDataPlane } from '../server/data-plane.js';
import { AuthorizationPolicySnapshot, PolicyValidator } from '../server/policy.js';
import { AgentLinkServer } from '../server/agent-link-server.js';

describe('Feature 11: Narrow Control-Plane / Data-Plane Boundary', () => {
  let tempDir: string;
  let spoolFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-f11-'));
    spoolFile = path.join(tempDir, 'data-plane-spool.json');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('11.1 Standalone Data Plane operates autonomously without control plane or web assets', async () => {
    const initialPolicy: AuthorizationPolicySnapshot = {
      revision: 1,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      stalenessWindowMs: 5 * 60 * 1000,
      apiKeys: {
        'sec_apk_alice_11': {
          id: 'agent-alice',
          key: 'sec_apk_alice_11',
          ownerHumanId: 'human_alice',
          createdAt: new Date().toISOString(),
        },
        'sec_apk_bob_11': {
          id: 'agent-bob',
          key: 'sec_apk_bob_11',
          ownerHumanId: 'human_bob',
          createdAt: new Date().toISOString(),
        },
      },
      humanSessions: {},
      agents: {
        'agent-alice': { id: 'agent-alice', ownerHumanId: 'human_alice', encPub: 'alice_enc', signPub: 'alice_sign' },
        'agent-bob': { id: 'agent-bob', ownerHumanId: 'human_bob', encPub: 'bob_enc', signPub: 'bob_sign' },
      },
      activeLinks: {
        'link-alice-bob': {
          id: 'link-alice-bob',
          agentAId: 'agent-alice',
          agentBId: 'agent-bob',
          status: 'active',
          approved: true,
          approvals: { human_alice: true, human_bob: true },
        },
      },
    };

    const dataPlane = new AgentLinkDataPlane({
      spoolPath: spoolFile,
      initialPolicy,
    });

    const port = await dataPlane.listen(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Health check returns 200 with dataPlane details
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.status).toBe('ok');
      expect(healthData.dataPlane.spoolHealthy).toBe(true);
      expect(healthData.dataPlane.policyRevision).toBe(1);

      // 2. Alice forwards message to Bob via standalone data plane
      const sendRes = await fetch(`${baseUrl}/api/links/link-alice-bob/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_alice_11',
        },
        body: JSON.stringify({
          senderId: 'agent-alice',
          payload: { text: 'Hello Bob from isolated data plane' },
        }),
      });
      expect(sendRes.status).toBe(200);
      const sendData = await sendRes.json();
      expect(sendData.status).toBe('ok');
      expect(sendData.accepted).toBe(true);
      expect(sendData.msgId).toBeTruthy();

      // 3. Bob polls message from standalone data plane
      const pollRes = await fetch(`${baseUrl}/api/agents/agent-bob/poll?timeout=100`, {
        headers: { 'Authorization': 'Bearer sec_apk_bob_11' },
      });
      expect(pollRes.status).toBe(200);
      const pollData = await pollRes.json();
      expect(pollData.messages.length).toBe(1);
      expect(pollData.messages[0].payload.text).toBe('Hello Bob from isolated data plane');

      // 4. Bob acks message
      const ackRes = await fetch(`${baseUrl}/api/agents/agent-bob/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sec_apk_bob_11',
        },
        body: JSON.stringify({
          messageIds: [pollData.messages[0].msgId],
          leaseId: pollData.leaseId,
        }),
      });
      expect(ackRes.status).toBe(200);
      const ackData = await ackRes.json();
      expect(ackData.acknowledged.length).toBe(1);

      // 5. Verify data plane metrics endpoint
      const metricsRes = await fetch(`${baseUrl}/api/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsData = await metricsRes.json();
      expect(metricsData.metrics.messagesAccepted).toBe(1);
      expect(metricsData.metrics.messagesDelivered).toBe(1);
      expect(metricsData.metrics.queueDepth).toBe(0);
    } finally {
      await dataPlane.close();
    }
  });

  it('11.2 Policy Synchronization and Revocation Propagation', async () => {
    const policySnapshotV1: AuthorizationPolicySnapshot = {
      revision: 1,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      stalenessWindowMs: 5 * 60 * 1000,
      apiKeys: {
        'sec_apk_alice_rev': { id: 'agent-alice', key: 'sec_apk_alice_rev', ownerHumanId: 'human_alice', createdAt: '' },
      },
      humanSessions: {},
      agents: {
        'agent-alice': { id: 'agent-alice', ownerHumanId: 'human_alice' },
        'agent-bob': { id: 'agent-bob', ownerHumanId: 'human_bob' },
      },
      activeLinks: {
        'link-f11-2': {
          id: 'link-f11-2',
          agentAId: 'agent-alice',
          agentBId: 'agent-bob',
          status: 'active',
          approved: true,
          approvals: { human_alice: true, human_bob: true },
        },
      },
    };

    const dataPlane = new AgentLinkDataPlane({
      spoolPath: spoolFile,
      initialPolicy: policySnapshotV1,
    });
    const port = await dataPlane.listen(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // V1: Send is authorized
      const send1 = await fetch(`${baseUrl}/api/links/link-f11-2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sec_apk_alice_rev' },
        body: JSON.stringify({ senderId: 'agent-alice', payload: 'valid' }),
      });
      expect(send1.status).toBe(200);

      // Publish V2: Link is revoked / demoted to pending_approval
      const policySnapshotV2: AuthorizationPolicySnapshot = {
        ...policySnapshotV1,
        revision: 2,
        activeLinks: {
          'link-f11-2': {
            ...policySnapshotV1.activeLinks['link-f11-2'],
            status: 'pending_approval',
            approved: false,
          },
        },
      };

      const syncRes = dataPlane.applyPolicySnapshot(policySnapshotV2);
      expect(syncRes.updated).toBe(true);

      // Immediate revocation: Send is blocked with 403
      const send2 = await fetch(`${baseUrl}/api/links/link-f11-2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sec_apk_alice_rev' },
        body: JSON.stringify({ senderId: 'agent-alice', payload: 'should be blocked' }),
      });
      expect(send2.status).toBe(403);
      const body2 = await send2.json();
      expect(body2.error).toBe('link_not_approved');
    } finally {
      await dataPlane.close();
    }
  });

  it('11.3 Control Plane restart resilience within freshness window', async () => {
    const now = Date.now();
    const policySnapshot: AuthorizationPolicySnapshot = {
      revision: 1,
      generatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 1000).toISOString(), // valid for 60s
      stalenessWindowMs: 60 * 1000,
      apiKeys: {
        'sec_apk_alice_fresh': { id: 'agent-alice', key: 'sec_apk_alice_fresh', ownerHumanId: 'human_alice', createdAt: '' },
        'sec_apk_bob_fresh': { id: 'agent-bob', key: 'sec_apk_bob_fresh', ownerHumanId: 'human_bob', createdAt: '' },
      },
      humanSessions: {},
      agents: {
        'agent-alice': { id: 'agent-alice', ownerHumanId: 'human_alice' },
        'agent-bob': { id: 'agent-bob', ownerHumanId: 'human_bob' },
      },
      activeLinks: {
        'link-fresh': {
          id: 'link-fresh',
          agentAId: 'agent-alice',
          agentBId: 'agent-bob',
          status: 'active',
          approved: true,
          approvals: {},
        },
      },
    };

    const dataPlane = new AgentLinkDataPlane({
      spoolPath: spoolFile,
      initialPolicy: policySnapshot,
    });
    const port = await dataPlane.listen(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Control Plane is offline / unreachable; data plane validation is purely local
      const sendRes = await fetch(`${baseUrl}/api/links/link-fresh/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sec_apk_alice_fresh' },
        body: JSON.stringify({ senderId: 'agent-alice', payload: 'Traffic flows during CP restart' }),
      });
      expect(sendRes.status).toBe(200);

      // 2. Health check indicates dataPlane is ok and policy is not stale
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json();
      expect(health.dataPlane.policyStale).toBe(false);
      expect(health.dataPlane.policyExpired).toBe(false);
    } finally {
      await dataPlane.close();
    }
  });

  it('11.4 Bounded policy staleness / expiry returns 503 degraded status', async () => {
    const expiredTimestamp = new Date(Date.now() - 10000).toISOString();
    const expiredPolicy: AuthorizationPolicySnapshot = {
      revision: 1,
      generatedAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: expiredTimestamp, // Expired 10s ago
      stalenessWindowMs: 10000,
      apiKeys: {
        'sec_apk_alice_exp': { id: 'agent-alice', key: 'sec_apk_alice_exp', ownerHumanId: 'human_alice', createdAt: '' },
      },
      humanSessions: {},
      agents: {
        'agent-alice': { id: 'agent-alice', ownerHumanId: 'human_alice' },
        'agent-bob': { id: 'agent-bob', ownerHumanId: 'human_bob' },
      },
      activeLinks: {
        'link-exp': {
          id: 'link-exp',
          agentAId: 'agent-alice',
          agentBId: 'agent-bob',
          status: 'active',
          approved: true,
          approvals: {},
        },
      },
    };

    const dataPlane = new AgentLinkDataPlane({
      spoolPath: spoolFile,
      initialPolicy: expiredPolicy,
    });
    const port = await dataPlane.listen(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Health check returns 503 degraded due to expired policy
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(503);
      const health = await healthRes.json();
      expect(health.status).toBe('degraded');
      expect(health.dataPlane.policyExpired).toBe(true);

      // 2. Sending messages is safely blocked with 503 Retry-After
      const sendRes = await fetch(`${baseUrl}/api/links/link-exp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sec_apk_alice_exp' },
        body: JSON.stringify({ senderId: 'agent-alice', payload: 'should fail due to expired policy' }),
      });
      expect(sendRes.status).toBe(503);
      expect(sendRes.headers.get('retry-after')).toBe('2');
      const body = await sendRes.json();
      expect(body.error).toBe('policy_expired');
    } finally {
      await dataPlane.close();
    }
  });

  it('11.5 Decomposed /health check in full server detects data plane failure and returns 503', async () => {
    const serverStateFile = path.join(tempDir, 'server-state.json');
    const server = new AgentLinkServer({
      port: 0,
      stateFilePath: serverStateFile,
      spoolFilePath: spoolFile,
      googleClientIds: ['test-client-id'],
      allowedEmails: ['admin@example.com'],
    });

    const port = await server.listen('127.0.0.1');
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Normal state: 200 OK with both controlPlane and dataPlane healthy
      const h1 = await fetch(`${baseUrl}/health`);
      expect(h1.status).toBe(200);
      const h1Data = await h1.json();
      expect(h1Data.status).toBe('ok');
      expect(h1Data.controlPlane.status).toBe('ok');
      expect(h1Data.dataPlane.status).toBe('ok');
      expect(h1Data.dataPlane.spoolHealthy).toBe(true);

      // 2. Simulate Data Plane degradation / shutdown
      server.dataPlane.isReady = false;

      // 3. Explicit /health check now returns 503 degraded
      const h2 = await fetch(`${baseUrl}/health`);
      expect(h2.status).toBe(503);
      const h2Data = await h2.json();
      expect(h2Data.status).toBe('degraded');
      expect(h2Data.ready).toBe(false);
      expect(h2Data.dataPlane.status).toBe('failed');
      expect(h2Data.dataPlane.ready).toBe(false);

      // 4. Ingress send returns 503
      const sendRes = await fetch(`${baseUrl}/api/links/unknown-link/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderId: 'anyone', payload: 'test' }),
      });
      expect(sendRes.status).toBe(503);

      // 5. Restore Data Plane readiness
      server.dataPlane.isReady = true;
      const h3 = await fetch(`${baseUrl}/health`);
      expect(h3.status).toBe(200);
      const h3Data = await h3.json();
      expect(h3Data.status).toBe('ok');
      expect(h3Data.dataPlane.status).toBe('ok');
    } finally {
      await server.close();
    }
  });
});
