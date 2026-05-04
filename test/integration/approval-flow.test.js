// Integration tests for the approval flow
// Tests end-to-end: request → rules check → auto_approve/require_approval → approve/deny

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { ApprovalServer } = require('../../src/core/approval-server');
const { ApprovalRules } = require('../../src/core/approval-rules');
const { ApprovalStore } = require('../../src/core/approval-store');
const { formatToolInput } = require('../../src/plugin/index');

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Approval flow — end-to-end integration', () => {
  let tmpDir;
  let rulesDir;
  let rulesPath;
  let rules;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-integ-'));
    rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-integ-rules-'));
    rulesPath = path.join(rulesDir, 'cc-approval-rules.yml');

    fs.writeFileSync(rulesPath, yaml.dump({
      rules: [
        { tool: 'Write', action: 'auto_approve' },
        { tool: 'Edit', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^git status$', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^npm test$', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^rm\\s+-rf\\s+.*', action: 'require_approval', sensitive: true },
        { tool: 'Bash', command_pattern: '^sudo\\s+.*', action: 'require_approval', sensitive: true },
        { tool: '*', action: 'require_approval' }
      ]
    }));

    rules = new ApprovalRules(rulesPath);
    server = new ApprovalServer(tmpDir, 0, null, rules, 'efficient');
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    if (server && server.server) server.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(rulesDir, { recursive: true, force: true }); } catch {}
  });

  describe('efficient mode — typical approval flow', () => {
    it('auto-approves Write tool and skips polling', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Write',
          toolInput: '{"file_path":"/ws/src/app.js","content":"console.log(1)"}',
          cwd: '/ws'
        })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
      expect(data.approvalId).toBeNull();

      // No PENDING items in store
      expect(server.store.listPending()).toEqual([]);
    });

    it('auto-approves safe Bash commands (git status)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"git status"}',
          cwd: '/ws'
        })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
    });

    it('creates PENDING for destructive Bash (rm -rf) and can be approved', async () => {
      const reqRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"rm -rf /tmp/old"}',
          cwd: '/ws'
        })
      });
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.status).toBe('PENDING');
      expect(reqData.approvalId).toBeDefined();

      // Check status is PENDING
      const statusRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${reqData.approvalId}`);
      expect(JSON.parse(statusRes.body).status).toBe('PENDING');

      // Approve via respond endpoint
      await fetchUrl(`${baseUrl}/api/approval/respond?id=${reqData.approvalId}&action=approve`, { method: 'POST' });

      // Check status is now APPROVED
      const finalRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${reqData.approvalId}`);
      expect(JSON.parse(finalRes.body).status).toBe('APPROVED');
    });

    it('creates PENDING for destructive Bash (rm -rf) and can be denied', async () => {
      const reqRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"rm -rf /tmp/old"}',
          cwd: '/ws'
        })
      });
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.status).toBe('PENDING');

      // Deny via respond endpoint
      await fetchUrl(`${baseUrl}/api/approval/respond?id=${reqData.approvalId}&action=deny`, { method: 'POST' });

      const finalRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${reqData.approvalId}`);
      expect(JSON.parse(finalRes.body).status).toBe('DENIED');
    });

    it('creates PENDING for sudo command (sensitive)', async () => {
      const reqRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"sudo apt install pkg"}',
          cwd: '/ws'
        })
      });
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.status).toBe('PENDING');
      expect(reqData.approvalId).toBeDefined();
    });

    it('creates PENDING for unknown Bash command (wildcard fallback)', async () => {
      const reqRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"curl http://example.com"}',
          cwd: '/ws'
        })
      });
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.status).toBe('PENDING');
    });
  });

  describe('strict mode — all operations require approval', () => {
    beforeEach(() => {
      server.setMode('strict');
    });

    it('overrides Write auto_approve to require_approval', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Write',
          toolInput: '{"file_path":"/ws/src/app.js"}',
          cwd: '/ws'
        })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });

    it('overrides Edit auto_approve to require_approval', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Edit',
          toolInput: '{"file_path":"/ws/src/app.js"}',
          cwd: '/ws'
        })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });

    it('still auto-approves safe Bash (git status) in strict mode', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: '{"command":"git status"}',
          cwd: '/ws'
        })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
    });
  });

  describe('mode switching affects server behavior', () => {
    it('switching from efficient to strict changes Write behavior', async () => {
      // efficient: Write auto-approves
      const effRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-001',
          toolName: 'Write',
          toolInput: '{"file_path":"/ws/a.js"}',
          cwd: '/ws'
        })
      });
      expect(JSON.parse(effRes.body).status).toBe('APPROVED');

      // Switch to strict
      server.setMode('strict');

      // strict: Write requires approval
      const strictRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-002',
          toolName: 'Write',
          toolInput: '{"file_path":"/ws/b.js"}',
          cwd: '/ws'
        })
      });
      expect(JSON.parse(strictRes.body).status).toBe('PENDING');

      // Switch back to efficient
      server.setMode('efficient');

      // efficient: Write auto-approves again
      const eff2Res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-003',
          toolName: 'Write',
          toolInput: '{"file_path":"/ws/c.js"}',
          cwd: '/ws'
        })
      });
      expect(JSON.parse(eff2Res.body).status).toBe('APPROVED');
    });
  });

  describe('formatToolInput — approval notification preview', () => {
    it('formats Bash command for notification', () => {
      const preview = formatToolInput('Bash', '{"command":"rm -rf /tmp/old"}');
      expect(preview).toBe('rm -rf /tmp/old');
    });

    it('formats Write file path for notification', () => {
      const preview = formatToolInput('Write', '{"file_path":"/ws/src/app.js","content":"..."}');
      expect(preview).toBe('/ws/src/app.js');
    });

    it('truncates long commands', () => {
      const longCmd = 'a'.repeat(300);
      const preview = formatToolInput('Bash', `{"command":"${longCmd}"}`);
      expect(preview.length).toBe(200);
    });
  });

  describe('ApprovalStore — session-based queries', () => {
    it('findBySessionId returns all approvals for a session', async () => {
      // Create two PENDING approvals for the same session
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-001', toolName: 'Bash', toolInput: '{"command":"rm -rf /tmp"}', cwd: '/ws' })
      });
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-001', toolName: 'Bash', toolInput: '{"command":"sudo apt install"}', cwd: '/ws' })
      });
      // Create one for a different session
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-002', toolName: 'Bash', toolInput: '{"command":"curl example.com"}', cwd: '/ws2' })
      });

      const items = server.store.findBySessionId('sess-001');
      expect(items.length).toBe(2);
      expect(items.every(i => i.sessionId === 'sess-001')).toBe(true);
    });

    it('listPending returns all PENDING approvals across sessions', async () => {
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-001', toolName: 'Bash', toolInput: '{"command":"rm -rf"}', cwd: '/ws' })
      });
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-002', toolName: 'Bash', toolInput: '{"command":"sudo"}', cwd: '/ws2' })
      });

      const pending = server.store.listPending();
      expect(pending.length).toBe(2);
      expect(pending.every(i => i.status === 'PENDING')).toBe(true);
    });
  });

  describe('server stop — marks all PENDING as TIMEOUT', () => {
    it('marks pending approvals as TIMEOUT when server stops', async () => {
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-001', toolName: 'Bash', toolInput: '{"command":"rm -rf"}', cwd: '/ws' })
      });
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-002', toolName: 'Bash', toolInput: '{"command":"sudo"}', cwd: '/ws2' })
      });

      expect(server.store.listPending().length).toBe(2);

      server.stop();

      // All should be TIMEOUT now
      const allItems = [...server.store.requests.values()];
      expect(allItems.every(i => i.status === 'TIMEOUT')).toBe(true);
    });
  });

  describe('restart — TIMEOUT notification on reload', () => {
    it('sends notification when pending approvals remain after unclean shutdown', async () => {
      // Create pending approvals then simulate unclean shutdown
      // (don't call stop() — just close the server, leaving PENDING in the file)
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-001', toolName: 'Bash', toolInput: '{"command":"rm -rf"}', cwd: '/ws' })
      });

      // Flush the store (persist PENDING items) then close server without marking TIMEOUT
      server.store.flush();
      if (server.server) {
        server.server.close();
        server.server = null;
      }

      // Restart with a notification callback
      const notifyCb = jest.fn();
      const newServer = new ApprovalServer(tmpDir, 0, notifyCb, rules, 'efficient');
      await newServer.start();

      expect(notifyCb).toHaveBeenCalledWith(expect.objectContaining({
        type: 'restart_timeout',
        text: expect.stringContaining('1')
      }));

      newServer.stop();
    });
  });
});