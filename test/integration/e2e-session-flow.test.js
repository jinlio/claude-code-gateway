// End-to-end integration test for Feishu messaging + session lifecycle
// See: cc-bridge-v3-final-plan.md Section 7

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ApprovalServer } = require('../../src/core/approval-server');
const { ApprovalRules } = require('../../src/core/approval-rules');
const { ApprovalStore } = require('../../src/core/approval-store');
const { FeishuMessenger } = require('../../src/core/feishu-messenger');
const { CommandParser } = require('../../src/core/command-parser');
const { ClaudeBridge } = require('../../src/core/claude-bridge');
const { HookInbox } = require('../../src/core/hook-inbox');

describe('E2E: Command parsing + Approval flow + Messenger formatting', () => {
  let server;
  let store;
  let messenger;
  let parser;
  let sentMessages;
  let tmpDir;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
    const rulesPath = path.join(__dirname, '../../config/cc-approval-rules.yml');
    const rules = new ApprovalRules(rulesPath);

    sentMessages = [];
    const mockApi = {
      sendMessage: (msg) => { sentMessages.push(msg); }
    };

    messenger = new FeishuMessenger(mockApi, { maxMessageLength: 4000 });
    parser = new CommandParser();

    const notifyCallback = (info) => {
      messenger.sendToUser('user1', info.text);
    };

    server = new ApprovalServer(tmpDir, 0, notifyCallback, rules, 'efficient');
    await server.start();
    store = server.store;
  });

  afterAll(() => {
    server?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    sentMessages = [];
  });

  describe('Full command parse → approval request → approve flow', () => {
    test('complete approval lifecycle via command parsing', async () => {
      // 1. User sends /cc_approve command (simulated)
      const parsed = parser.parse('/cc_approve abc12345');
      expect(parsed.command).toBe('cc_approve');
      expect(parsed.args).toBe('abc12345');

      // 2. Hook sends approval request for a Bash command
      const requestBody = JSON.stringify({
        sessionId: 'cc-test-123',
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'rm -rf /tmp/test' }),
        cwd: '/home/user/project',
        timestamp: Date.now()
      });

      const requestResult = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );

      expect(requestResult.status).toBe('PENDING');
      expect(requestResult.approvalId).toBeTruthy();

      // 3. Messenger formats the approval notification
      const notification = messenger.formatApprovalNotification(
        requestResult.approvalId,
        'Bash',
        'rm -rf /tmp/test',
        '/home/user/project'
      );
      expect(notification).toContain('审批请求');
      expect(notification).toContain('Bash');
      expect(notification).toContain('rm -rf /tmp/test');

      // 4. Messenger sends the notification
      messenger.sendToUser('user1', notification);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].target).toBe('user1');

      // 5. User approves via parsed command
      const shortId = requestResult.approvalId.slice(0, 8);
      const item = store.findByShortId(shortId);
      expect(item).toBeTruthy();
      expect(item.status).toBe('PENDING');

      store.resolve(item.id, 'APPROVED');

      // 6. Verify the approval is reflected in status
      const statusResult = await getJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/status?id=${requestResult.approvalId}`
      );
      expect(statusResult.status).toBe('APPROVED');
    });

    test('complete denial lifecycle', async () => {
      const requestBody = JSON.stringify({
        sessionId: 'cc-deny-test',
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'sudo apt-get install something' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const requestResult = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(requestResult.status).toBe('PENDING');

      const shortId = requestResult.approvalId.slice(0, 8);
      const item = store.findByShortId(shortId);
      store.resolve(item.id, 'DENIED');

      const statusResult = await getJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/status?id=${requestResult.approvalId}`
      );
      expect(statusResult.status).toBe('DENIED');
    });
  });

  describe('Auto-approve by rules', () => {
    test('Write tool auto-approved in efficient mode', async () => {
      const requestBody = JSON.stringify({
        sessionId: 'cc-auto-test',
        toolName: 'Write',
        toolInput: JSON.stringify({ file_path: '/src/app.js' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const result = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(result.status).toBe('APPROVED');
      expect(result.autoApproved).toBe(true);
    });

    test('safe git command auto-approved', async () => {
      const requestBody = JSON.stringify({
        sessionId: 'cc-git-test',
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'git status' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const result = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(result.status).toBe('APPROVED');
      expect(result.autoApproved).toBe(true);
    });
  });

  describe('Message formatting and splitting', () => {
    test('long Claude output is split and sent in chunks', () => {
      const longOutput = 'line\n'.repeat(1000);
      const count = messenger.sendToUser('user1', longOutput);
      expect(count).toBeGreaterThan(1);

      const rejoined = sentMessages.map(m => m.text).join('');
      expect(rejoined).toBe(longOutput);
    });

    test('error messages are formatted properly', () => {
      const formatted = messenger.formatErrorMessage('Build failed: syntax error');
      expect(formatted).toContain('错误:');
      expect(formatted).toContain('Build failed');
    });

    test('tool progress is formatted for success and error', () => {
      const success = messenger.formatToolProgress('Read', 'success');
      expect(success).toContain('✓');

      const error = messenger.formatToolProgress('Bash', 'error', 'command not found');
      expect(error).toContain('✗');
      expect(error).toContain('command not found');
    });
  });

  describe('Command parsing edge cases', () => {
    test('all 10 commands are recognized', () => {
      const commands = parser.getCommands();
      expect(commands).toHaveLength(10);

      for (const cmd of commands) {
        const result = parser.parse(`/${cmd} test_args`);
        expect(result.unknown).toBe(false);
        expect(result.command).toBe(cmd);
      }
    });

    test('/cc command with prompt is parsed correctly', () => {
      const result = parser.parse('/cc implement user authentication');
      expect(result.command).toBe('cc');
      expect(result.args).toBe('implement user authentication');
    });

    test('unknown command returns unknown flag', () => {
      const result = parser.parse('/unknown_cmd');
      expect(result.unknown).toBe(true);
    });

    test('non-command text returns null', () => {
      expect(parser.parse('just a regular message')).toBeNull();
    });
  });

  describe('Mode switching affects approval behavior', () => {
    test('strict mode makes Write require approval', async () => {
      server.setMode('strict');

      const requestBody = JSON.stringify({
        sessionId: 'cc-strict-test',
        toolName: 'Write',
        toolInput: JSON.stringify({ file_path: '/src/app.js' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const result = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(result.status).toBe('PENDING');

      // Cleanup: resolve the pending request
      if (result.approvalId) {
        store.resolve(result.approvalId, 'APPROVED');
      }

      // Reset to efficient
      server.setMode('efficient');
    });

    test('efficient mode auto-approves Write', async () => {
      server.setMode('efficient');

      const requestBody = JSON.stringify({
        sessionId: 'cc-efficient-test',
        toolName: 'Write',
        toolInput: JSON.stringify({ file_path: '/src/app.js' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const result = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(result.status).toBe('APPROVED');
      expect(result.autoApproved).toBe(true);
    });
  });

  describe('Session timeout notification', () => {
    test('server restart sends timeout notification for pending requests', async () => {
      // Create a pending request
      const requestBody = JSON.stringify({
        sessionId: 'cc-timeout-test',
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'npm run build:prod' }),
        cwd: '/project',
        timestamp: Date.now()
      });

      const result = await postJSON(
        `http://127.0.0.1:${server.getPort()}/api/approval/request`,
        requestBody
      );
      expect(result.status).toBe('PENDING');

      // Simulate abnormal shutdown: close server without calling stop()
      // This leaves PENDING requests on disk (not marked as TIMEOUT)
      if (server.server) {
        server.server.close();
        server.server = null;
      }
      // Flush to ensure data is persisted with PENDING status
      store.flush();

      // Start a new server to detect pending requests from crash
      const rulesPath = path.join(__dirname, '../../config/cc-approval-rules.yml');
      const rules = new ApprovalRules(rulesPath);

      const restartMessages = [];
      const restartApi = { sendMessage: (msg) => { restartMessages.push(msg); } };
      const restartMessenger = new FeishuMessenger(restartApi, { maxMessageLength: 4000 });
      const newNotifyCallback = (info) => {
        restartMessenger.sendToUser('user1', info.text);
      };

      const newServer = new ApprovalServer(tmpDir, 0, newNotifyCallback, rules, 'efficient');
      await newServer.start();

      // Check that timeout notification was sent
      expect(restartMessages.length).toBeGreaterThan(0);
      const notificationText = restartMessages.find(m => m.text?.includes('超时中断'));
      expect(notificationText).toBeTruthy();

      newServer.stop();

      // Restore original server for remaining tests
      const restoreRules = new ApprovalRules(rulesPath);
      const restoreNotifyCallback = (info) => {
        messenger.sendToUser('user1', info.text);
      };
      server = new ApprovalServer(tmpDir, 0, restoreNotifyCallback, restoreRules, 'efficient');
      await server.start();
      store = server.store;
    });
  });
});

// HTTP helper functions
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'ERROR', raw: data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    http.get({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'ERROR', raw: data }); }
      });
    }).on('error', reject);
  });
}
