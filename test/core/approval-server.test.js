// Tests for approval-server.js — HTTP server, request/status/respond routes, restart notification, rule-based pre-check

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { ApprovalServer } = require('../../src/core/approval-server');
const { ApprovalRules } = require('../../src/core/approval-rules');

describe('ApprovalServer', () => {
  let tmpDir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-server-'));
    server = new ApprovalServer(tmpDir, 0);
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    if (server && server.server) server.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

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

  describe('POST /api/approval/request', () => {
    it('creates a new approval and returns approvalId + PENDING', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"ls"}', cwd: '/ws', timestamp: Date.now() })
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.approvalId).toBeDefined();
      expect(data.status).toBe('PENDING');
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        body: 'not json'
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/approval/status', () => {
    it('returns PENDING status for an active approval', async () => {
      const createRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws', timestamp: Date.now() })
      });
      const { approvalId } = JSON.parse(createRes.body);

      const statusRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${approvalId}`);
      expect(statusRes.statusCode).toBe(200);
      const statusData = JSON.parse(statusRes.body);
      expect(statusData.status).toBe('PENDING');
    });

    it('returns 404 for unknown approval id', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/status?id=nonexistent`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/approval/respond', () => {
    it('approves a pending request', async () => {
      const createRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws', timestamp: Date.now() })
      });
      const { approvalId } = JSON.parse(createRes.body);

      const respondRes = await fetchUrl(`${baseUrl}/api/approval/respond?id=${approvalId}&action=approve`, { method: 'POST' });
      expect(respondRes.statusCode).toBe(200);

      const statusRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${approvalId}`);
      expect(JSON.parse(statusRes.body).status).toBe('APPROVED');
    });

    it('denies a pending request', async () => {
      const createRes = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws', timestamp: Date.now() })
      });
      const { approvalId } = JSON.parse(createRes.body);

      await fetchUrl(`${baseUrl}/api/approval/respond?id=${approvalId}&action=deny`, { method: 'POST' });

      const statusRes = await fetchUrl(`${baseUrl}/api/approval/status?id=${approvalId}`);
      expect(JSON.parse(statusRes.body).status).toBe('DENIED');
    });

    it('returns 403 when shared secret is configured and wrong auth header is provided', async () => {
      // Stop default server and create one with shared secret
      server.stop();
      const secretServer = new ApprovalServer(tmpDir, 0, null, null, 'efficient', 'my-secret-key');
      const secretPort = await secretServer.start();
      const secretBaseUrl = `http://127.0.0.1:${secretPort}`;

      const createRes = await fetchUrl(`${secretBaseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws', timestamp: Date.now() })
      });
      const { approvalId } = JSON.parse(createRes.body);

      // Without auth header — should be forbidden
      const badRes = await fetchUrl(`${secretBaseUrl}/api/approval/respond?id=${approvalId}&action=approve`, { method: 'POST' });
      expect(badRes.statusCode).toBe(403);

      // With correct auth header — should succeed
      const goodRes = await fetchUrl(`${secretBaseUrl}/api/approval/respond?id=${approvalId}&action=approve`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer my-secret-key' }
      });
      expect(goodRes.statusCode).toBe(200);

      secretServer.stop();
    });
  });

  describe('404 for unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const res = await fetchUrl(`${baseUrl}/unknown`, { method: 'GET' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('onApprovalNeeded callback', () => {
    it('invokes onApprovalNeeded when approval is created', async () => {
      const callback = jest.fn();
      server.onApprovalNeeded = callback;

      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' })
      });
      expect(callback).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ toolName: 'Bash' }));
    });
  });

  describe('stop', () => {
    it('marks all pending as TIMEOUT and closes server', async () => {
      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws' })
      });

      server.stop();
      expect(server.server).toBeNull();

      // Verify pending requests are now TIMEOUT
      const items = [...server.store.requests.values()];
      expect(items.every(i => i.status !== 'PENDING')).toBe(true);
    });
  });

  describe('notifyTimedOutRequests', () => {
    it('calls notifyCallback when timed out items exist on start', async () => {
      const notifyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-notify-'));
      const filePath = path.join(notifyTmpDir, 'approval-requests.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { id: 'test-1', sessionId: 's1', toolName: 'Bash', toolInput: '{}', cwd: '/ws', status: 'PENDING', createdAt: new Date().toISOString() }
      ]));

      const notifyCb = jest.fn();
      const notifyServer = new ApprovalServer(notifyTmpDir, 0, notifyCb);
      await notifyServer.start();

      expect(notifyCb).toHaveBeenCalledWith(expect.objectContaining({ type: 'restart_timeout' }));
      notifyServer.stop();
      fs.rmSync(notifyTmpDir, { recursive: true, force: true });
    });
  });

  describe('getPort', () => {
    it('returns the allocated port', () => {
      const port = server.getPort();
      expect(port).toBeGreaterThan(0);
    });
  });
});

describe('ApprovalServer — rule-based pre-check', () => {
  let tmpDir;
  let rulesDir;
  let rulesPath;
  let rules;
  let server;
  let baseUrl;

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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-rules-server-'));
    rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-rules-yml-'));
    rulesPath = path.join(rulesDir, 'rules.yml');

    // Write rules with auto_approve for Write/Edit, require_approval for Bash destructive
    fs.writeFileSync(rulesPath, yaml.dump({
      rules: [
        { tool: 'Write', action: 'auto_approve' },
        { tool: 'Edit', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^git status$', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^rm\\s+-rf', action: 'require_approval', sensitive: true },
        { tool: '*', action: 'require_approval' }
      ]
    }));

    rules = new ApprovalRules(rulesPath);
  });

  afterEach(() => {
    if (server && server.server) server.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(rulesDir, { recursive: true, force: true }); } catch {}
  });

  describe('efficient mode — auto_approve rules', () => {
    beforeEach(async () => {
      server = new ApprovalServer(tmpDir, 0, null, rules, 'efficient');
      const port = await server.start();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    it('auto-approves Write tool (rule match)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Write', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
      expect(data.approvalId).toBeNull();
    });

    it('auto-approves Edit tool (rule match)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Edit', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
    });

    it('auto-approves Bash git status (rule match)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"git status"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
    });

    it('creates PENDING for Bash rm -rf (require_approval)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"rm -rf /tmp"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
      expect(data.autoApproved).toBeUndefined();
    });

    it('creates PENDING for unknown Bash command (wildcard fallback)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"npm run build"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });

    it('does not invoke onApprovalNeeded for auto-approved requests', async () => {
      const callback = jest.fn();
      server.onApprovalNeeded = callback;

      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Write', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      expect(callback).not.toHaveBeenCalled();
    });

    it('invokes onApprovalNeeded for PENDING requests', async () => {
      const callback = jest.fn();
      server.onApprovalNeeded = callback;

      await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"rm -rf /tmp"}', cwd: '/ws' })
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('strict mode — override Write/Edit auto_approve', () => {
    beforeEach(async () => {
      server = new ApprovalServer(tmpDir, 0, null, rules, 'strict');
      const port = await server.start();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    it('creates PENDING for Write (strict overrides auto_approve)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Write', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });

    it('creates PENDING for Edit (strict overrides auto_approve)', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Edit', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });

    it('still auto-approves Bash git status in strict mode', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: '{"command":"git status"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('APPROVED');
      expect(data.autoApproved).toBe(true);
    });
  });

  describe('setMode', () => {
    it('changes mode from efficient to strict', () => {
      server = new ApprovalServer(tmpDir, 0, null, rules, 'efficient');
      expect(server.currentMode).toBe('efficient');
      server.setMode('strict');
      expect(server.currentMode).toBe('strict');
    });
  });

  describe('no ApprovalRules provided', () => {
    beforeEach(async () => {
      server = new ApprovalServer(tmpDir, 0, null, null, 'efficient');
      const port = await server.start();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    it('creates PENDING for all requests when no rules configured', async () => {
      const res = await fetchUrl(`${baseUrl}/api/approval/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', toolName: 'Write', toolInput: '{"file_path":"/ws/a.js"}', cwd: '/ws' })
      });
      const data = JSON.parse(res.body);
      expect(data.status).toBe('PENDING');
      expect(data.approvalId).toBeDefined();
    });
  });
});