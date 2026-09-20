import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import { AgentLinkServer } from '../server/agent-link-server.js';
import {
  generateAgentKeys,
  deriveSharedKey,
  encryptPayload,
  decryptPayload,
  signEnvelope,
  ReplManager,
  TuiRenderer,
} from '../scripts/repl.mjs';

describe('Feature: AgentMesh Multi-Pane Terminal REPL & Telemetry Monitor', () => {
  let server: AgentLinkServer;
  let serverUrl: string;
  let activeRepl: ReplManager | null = null;
  const testAdminEmail = 'admin@signetmesh.internal';
  const testAdminPassword = 'test_repl_admin_password';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL = testAdminEmail;
    process.env.ADMIN_PASSWORD = testAdminPassword;
    process.env.ADMIN_EMAIL_HASH = crypto.createHash('sha256').update(testAdminEmail).digest('hex');

    server = new AgentLinkServer({
      port: 0,
      adminPassword: testAdminPassword,
      allowedEmails: [testAdminEmail],
    });
    const port = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (activeRepl) {
      activeRepl.stop();
    }
    if (server) {
      await server.close();
    }
  });

  it('1. cryptographic key generation produces valid Ed25519/X25519 keys and KIDs', () => {
    const agent = generateAgentKeys('bot-test-alpha');
    expect(agent.agentId).toBe('bot-test-alpha');
    expect(agent.kid).toMatch(/^kid-bot-test-alpha-[0-9a-f]{16}$/);
    expect(agent.signPubRaw.length).toBe(32);
    expect(agent.encPubRaw.length).toBe(32);
    expect(Buffer.from(agent.signPubB64, 'base64').length).toBe(32);
    expect(Buffer.from(agent.encPubB64, 'base64').length).toBe(32);
  });

  it('2. symmetric Diffie-Hellman derivation and AES-256-GCM authenticated encryption cycle', () => {
    const alice = generateAgentKeys('alice');
    const bob = generateAgentKeys('bob');
    const linkId = 'link_repl_test_001';

    const pubBob = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), bob.encPubRaw]),
      format: 'der',
      type: 'spki',
    });
    const pubAlice = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), alice.encPubRaw]),
      format: 'der',
      type: 'spki',
    });

    const keyAlice = deriveSharedKey(alice.xKey.privateKey, pubBob, linkId);
    const keyBob = deriveSharedKey(bob.xKey.privateKey, pubAlice, linkId);
    expect(keyAlice).toEqual(keyBob);

    const plaintext = 'Secret rendezvous coordinates: sector-7G';
    const enc = encryptPayload(keyAlice, plaintext, linkId, 'alice', 'bob', 1);

    expect(enc.iv).toBeDefined();
    expect(enc.data).toBeDefined();
    expect(enc.nonce).toBeDefined();

    const dec = decryptPayload(keyBob, enc.iv, enc.data, linkId, 'alice', 'bob', 1, enc.nonce);
    expect(dec).toBe(plaintext);
  });

  it('3. command auto-completer returns expected suggestions for bot and human panes', () => {
    const repl = new ReplManager({ serverUrl });

    // Bot shell completions
    expect(repl.getCompletions('botA', 's')).toContain('send');
    expect(repl.getCompletions('botA', 'w')).toContain('whoami');
    expect(repl.getCompletions('botA', 'l')).toContain('links');
    expect(repl.getCompletions('botA', 'h')).toContain('help');

    // Human shell completions
    expect(repl.getCompletions('human', 'app')).toContain('approve');
    expect(repl.getCompletions('human', 'ag')).toContain('agents');
    expect(repl.getCompletions('human', 'st')).toContain('status');
  });

  it('4. end-to-end multi-agent provisioning, linking, and dual telemetry streams', async () => {
    const repl = new ReplManager({
      serverUrl,
      adminEmail: testAdminEmail,
      adminPassword: testAdminPassword,
      botAId: 'bot-repl-a',
      botBId: 'bot-repl-b',
    });
    activeRepl = repl;

    // 1. Initialize REPL (registers botA and botB, authenticates human operator)
    await repl.initialize();

    expect(repl.adminToken).toBeDefined();
    expect(repl.logs.botA.some(l => l.includes('registered'))).toBe(true);
    expect(repl.logs.botB.some(l => l.includes('registered'))).toBe(true);

    // 2. Link agents via human command
    await repl.executeCommand('human', 'link');

    expect(repl.activeLinkId).toBeDefined();
    expect(repl.linkRecord?.status).toBe('active');
    expect(repl.symKeyA).toBeDefined();
    expect(repl.symKeyB).toBeDefined();

    // 3. Bot A sends E2EE message to Bot B
    await repl.executeCommand('botA', 'send "Hello Bot B from REPL pane"');

    // Verify Bot A log
    expect(repl.logs.botA.some(l => l.includes('Sent E2EE message #1'))).toBe(true);

    // Verify Encrypted Flow pane (raw wire transit)
    expect(repl.logs.encrypted.some(l => l.includes('E2EE v2') && l.includes(repl.activeLinkId!))).toBe(true);

    // Verify Decrypted Flow pane (Link Telemetry & Conversation Flow)
    expect(repl.logs.decrypted.some(l => l.includes('Hello Bot B from REPL pane'))).toBe(true);

    // Verify Bot B receives decrypted message
    expect(repl.logs.botB.some(l => l.includes('Received from bot-repl-a'))).toBe(true);

    // 4. Bot B replies to Bot A
    await repl.executeCommand('botB', 'send "Message received loud and clear"');
    expect(repl.logs.botB.some(l => l.includes('Sent E2EE message #1'))).toBe(true);
    expect(repl.logs.botA.some(l => l.includes('Received from bot-repl-b'))).toBe(true);
    expect(repl.logs.decrypted.some(l => l.includes('Message received loud and clear'))).toBe(true);

    // 5. Human operator dispatches supervisor message
    await repl.executeCommand('human', 'send "Supervisor link integrity check: PASSED"');
    expect(repl.logs.decrypted.some(l => l.includes('Supervisor link integrity check: PASSED'))).toBe(true);

    // 6. Test whoami command
    await repl.executeCommand('botA', 'whoami');
    expect(repl.logs.botA.some(l => l.includes('Agent: bot-repl-a'))).toBe(true);

    // 7. Test links command
    await repl.executeCommand('human', 'links');
    expect(repl.logs.human.some(l => l.includes(repl.activeLinkId!))).toBe(true);

    repl.stop();
  });

  it('5. TUI renderer guarantees exact terminal line widths and non-offset cursor positioning', () => {
    const repl = new ReplManager();
    repl.botA.agentId = 'bot-alpha';
    repl.botB.agentId = 'bot-beta';
    const renderer = new TuiRenderer(repl);

    // Test across various pane selections and input buffers
    const cases = [
      { pane: 0, bufferKey: 'botA' as const, text: 'send "hello"' },
      { pane: 1, bufferKey: 'human' as const, text: 'cursur....' },
      { pane: 2, bufferKey: 'botB' as const, text: 'whoami' },
    ];

    for (const c of cases) {
      repl.switchPane(c.pane);
      repl.inputBuffers[c.bufferKey] = c.text;

      renderer.cols = 120;
      renderer.rows = 36;

      let output = '';
      const origWrite = process.stdout.write;
      process.stdout.write = (chunk: any) => {
        output += chunk;
        return true;
      };
      renderer.render();
      process.stdout.write = origWrite;

      // Extract cursor escape code: \x1b[Y;XH
      const cursorMatches = output.match(/\x1b\[(\d+);(\d+)H/g);
      expect(cursorMatches).toBeDefined();
      const lastCursor = cursorMatches![cursorMatches!.length - 1];
      const m = lastCursor.match(/\x1b\[(\d+);(\d+)H/);
      expect(m).not.toBeNull();
      const curY = parseInt(m![1], 10);
      const curX = parseInt(m![2], 10);

      // Strip ANSI escape codes
      const body = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const lines = body.split('\r\n');

      // 1. Every rendered line must match terminal width W exactly (zero line-wrapping)
      for (let i = 0; i < lines.length; i++) {
        expect(lines[i].length).toBe(120);
      }

      // 2. Total rendered lines must be strictly less than H to prevent auto-scrolling
      expect(lines.length).toBeLessThan(36);

      // 3. The cursor row (curY, 1-indexed) must point precisely to the prompt line
      const promptLine = lines[curY - 1];
      expect(promptLine).toBeDefined();

      if (c.pane === 0) {
        expect(promptLine).toContain('Bot A > ' + c.text);
      } else if (c.pane === 1) {
        expect(promptLine).toContain('Human > ' + c.text);
      } else {
        expect(promptLine).toContain('Bot B > ' + c.text);
      }

      // 4. Cursor column (curX, 1-indexed) must point to the space immediately following the text
      const charBeforeCursor = promptLine[curX - 2];
      const charAtCursor = promptLine[curX - 1];
      expect(charBeforeCursor).toBe(c.text.slice(-1));
      expect(charAtCursor).toBe(' ');
    }
  });
});
