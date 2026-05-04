// Tests for plugin/index.js — init, command registration, formatToolInput

const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock all core modules
jest.mock('../../src/core/claude-bridge');
jest.mock('../../src/core/approval-server');
jest.mock('../../src/core/approval-rules');
jest.mock('../../src/core/git-snapshot');
jest.mock('../../src/core/hook-inbox');
jest.mock('../../src/core/persistent-session-manager');
jest.mock('../../src/core/context-manager');

const { init, formatToolInput } = require('../../src/plugin/index');
const { ClaudeBridge } = require('../../src/core/claude-bridge');
const { ApprovalServer } = require('../../src/core/approval-server');
const { ApprovalRules } = require('../../src/core/approval-rules');
const { HookInbox } = require('../../src/core/hook-inbox');
const { PersistentSessionManager } = require('../../src/core/persistent-session-manager');
const { ContextManager } = require('../../src/core/context-manager');

describe('formatToolInput', () => {
  it('formats Bash tool input as command preview', () => {
    expect(formatToolInput('Bash', '{"command":"rm -rf /tmp"}')).toBe('rm -rf /tmp');
  });

  it('formats Write/Edit tool input as file path', () => {
    expect(formatToolInput('Write', '{"file_path":"/src/app.js"}')).toBe('/src/app.js');
    expect(formatToolInput('Edit', '{"file_path":"/src/app.js"}')).toBe('/src/app.js');
  });

  it('formats other tools as JSON string preview', () => {
    expect(formatToolInput('Read', '{"file_path":"/src/app.js"}')).toBe('{"file_path":"/src/app.js"}');
  });

  it('handles invalid JSON gracefully', () => {
    expect(formatToolInput('Bash', 'not json')).toBe('not json');
  });

  it('handles undefined input gracefully', () => {
    expect(formatToolInput('Bash', undefined)).toBe('(no content)');
  });

  it('truncates long command to 200 chars', () => {
    const longCmd = 'a'.repeat(300);
    expect(formatToolInput('Bash', `{"command":"${longCmd}"}`)).toHaveLength(200);
  });

  it('returns (no command) for Bash without command field', () => {
    expect(formatToolInput('Bash', '{"other":"field"}')).toBe('(no command)');
  });

  it('returns (no path) for Write without file_path field', () => {
    expect(formatToolInput('Write', '{"other":"field"}')).toBe('(no path)');
  });
});

describe('init', () => {
  it('initializes all modules and registers commands', () => {
    const mockApi = { registerCommand: jest.fn(), on: jest.fn() };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-plugin-'));
    const config = { dataDir: tmpDir };

    // Mock ApprovalServer.start to resolve immediately
    ApprovalServer.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(7890),
      getPort: jest.fn().mockReturnValue(7890),
      store: { findByShortId: jest.fn(), resolve: jest.fn(), findBySessionId: jest.fn().mockReturnValue([]), listPending: jest.fn().mockReturnValue([]) },
      setMode: jest.fn(),
      onApprovalNeeded: null
    }));

    init(mockApi, config);

    // Should register 10 commands (including /cc)
    expect(mockApi.registerCommand).toHaveBeenCalledTimes(10);

    // Should register lifecycle hooks
    expect(mockApi.on).toHaveBeenCalledWith('gateway_start', expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith('gateway_stop', expect.any(Function));

    // Check command names
    const commandNames = mockApi.registerCommand.mock.calls.map(c => c[0].name);
    expect(commandNames).toContain('cc');
    expect(commandNames).toContain('cc_start');
    expect(commandNames).toContain('cc_stop');
    expect(commandNames).toContain('cc_status');
    expect(commandNames).toContain('cc_answer');
    expect(commandNames).toContain('cc_approve');
    expect(commandNames).toContain('cc_deny');
    expect(commandNames).toContain('cc_revert');
    expect(commandNames).toContain('cc_context');
    expect(commandNames).toContain('cc_mode');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads config from api.pluginConfig when config not provided directly', () => {
    const mockApi = { registerCommand: jest.fn(), on: jest.fn(), pluginConfig: { defaultMode: 'strict' } };

    ApprovalServer.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(7890),
      getPort: jest.fn().mockReturnValue(7890),
      store: { findByShortId: jest.fn(), resolve: jest.fn() },
      setMode: jest.fn(),
      onApprovalNeeded: null
    }));

    init(mockApi);

    expect(mockApi.registerCommand).toHaveBeenCalledTimes(10);
  });
});

describe('command handlers', () => {
  let mockApi;
  let commands;
  let tmpDir;

  beforeEach(() => {
    mockApi = {
      registerCommand: jest.fn(),
      on: jest.fn(),
      config: {},
      runtime: {
        channel: {
          outbound: {
            loadAdapter: jest.fn().mockResolvedValue({
              sendText: jest.fn().mockResolvedValue(undefined)
            })
          }
        }
      }
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-plugin-'));

    // Setup mocks
    const mockBridge = {
      findActiveSession: jest.fn(),
      sessionMeta: new Map(),
      processMap: new Map(),
      spawnSession: jest.fn(),
      terminateSession: jest.fn(),
      updateActivity: jest.fn(),
      stopHeartbeat: jest.fn()
    };
    ClaudeBridge.mockImplementation(() => mockBridge);

    const mockStore = {
      findByShortId: jest.fn(),
      resolve: jest.fn(),
      findBySessionId: jest.fn().mockReturnValue([]),
      listPending: jest.fn().mockReturnValue([])
    };
    ApprovalServer.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(7890),
      getPort: jest.fn().mockReturnValue(7890),
      store: mockStore,
      setMode: jest.fn(),
      onApprovalNeeded: null
    }));

    ApprovalRules.mockImplementation(() => ({ rules: [], match: jest.fn() }));
    HookInbox.mockImplementation(() => ({
      writeHookConfig: jest.fn(),
      updateMatcher: jest.fn(),
      hookConfigPath: null
    }));
    PersistentSessionManager.mockImplementation(() => ({
      activate: jest.fn(),
      deactivate: jest.fn(),
      getActive: jest.fn()
    }));
    ContextManager.mockImplementation(() => ({
      injectRules: jest.fn(),
      cleanup: jest.fn(),
      buildContextPrompt: jest.fn().mockReturnValue('test context')
    }));

    init(mockApi, config);
    commands = {};
    for (const call of mockApi.registerCommand.mock.calls) {
      commands[call[0].name] = call[0].handler;
    }
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const config = { dataDir: '/tmp/cc-bridge-test' };

  describe('cc_mode', () => {
    it('shows current mode when no valid arg given', async () => {
      const result = await commands.cc_mode({ senderId: 'u1', args: '' });
      expect(result.text).toContain('当前模式');
      expect(result.text).toContain('efficient');
    });

    it('switches to efficient mode and syncs with server', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const modeHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_mode')[0].handler;

      const result = await modeHandler({ senderId: 'u1', args: 'efficient' });
      expect(result.text).toContain('efficient');
    });

    it('switches to strict mode and syncs with server', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const modeHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_mode')[0].handler;

      const result = await modeHandler({ senderId: 'u1', args: 'strict' });
      expect(result.text).toContain('strict');
    });
  });

  describe('cc_start', () => {
    it('shows session status when an active session already exists', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('existing');
      bridgeInstance.sessionMeta.set('existing', { cwd: '/ws', startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messageCount: 3 });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const startHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_start')[0].handler;

      const result = await startHandler({ senderId: 'u1', workspace: '/ws' });
      expect(result.text).toContain('持久会话状态');
    });
  });

  describe('cc_stop', () => {
    it('returns message when no session exists', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const stopHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_stop')[0].handler;

      const result = await stopHandler({ senderId: 'u1' });
      expect(result.text).toContain('没有持久会话');
    });
  });

  describe('cc_status', () => {
    it('returns no active session message', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const statusHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_status')[0].handler;

      const result = await statusHandler({ senderId: 'u1' });
      expect(result.text).toContain('没有活跃');
    });
  });

  describe('cc_answer', () => {
    it('returns usage message when no answer provided', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const answerHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_answer')[0].handler;

      const result = await answerHandler({ senderId: 'u1', args: '' });
      expect(result.text).toContain('用法');
    });
  });

  describe('cc_approve', () => {
    it('returns usage when no shortId provided', async () => {
      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const approveHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_approve')[0].handler;

      const result = await approveHandler({ args: '' });
      expect(result.text).toContain('用法');
    });
  });

  describe('cc_deny', () => {
    it('returns usage when no shortId provided', async () => {
      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const denyHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_deny')[0].handler;

      const result = await denyHandler({ args: '' });
      expect(result.text).toContain('用法');
    });
  });

  describe('cc_revert', () => {
    it('returns no session when no active session', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const revertHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].handler;

      const result = await revertHandler({ senderId: 'u1', args: '' });
      expect(result.text).toContain('没有活跃');
    });

    it('shows confirmation prompt when no --confirm/--cancel', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: 'CC-snapshot-s1-123456' });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const revertHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].handler;

      const result = await revertHandler({ senderId: 'u1', args: '' });
      expect(result.text).toContain('确认回滚');
    });

    it('shows no snapshot message when stashRef is null', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: null });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const revertHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].handler;

      const result = await revertHandler({ senderId: 'u1', args: '' });
      expect(result.text).toContain('无可用的快照');
    });

    it('shows no snapshot message when --confirm but no stashRef', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: null });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const revertHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].handler;

      const result = await revertHandler({ senderId: 'u1', args: '--confirm' });
      expect(result.text).toContain('无可用的快照');
    });

    it('cancels revert when --cancel', async () => {
      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const revertHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].handler;

      const result = await revertHandler({ senderId: 'u1', args: '--cancel' });
      expect(result.text).toContain('已取消');
    });
  });

  describe('cc_context', () => {
    it('returns no session when no active session', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      init(mockApi, config);
      const ctxHandler = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_context')[0].handler;

      const result = await ctxHandler({ senderId: 'u1' });
      expect(result.text).toContain('没有活跃');
    });
  });

  describe('onApprovalNeeded formatting', () => {
    it('formats approval notification with tool input preview', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true });

      mockApi.registerCommand.mockClear();
      init(mockApi, config);

      // Manually trigger startServices to set up approvalServer and onApprovalNeeded
      const gatewayStartCall = mockApi.on.mock.calls.find(c => c[0] === 'gateway_start');
      if (gatewayStartCall) {
        await gatewayStartCall[1]();
      }

      // Get the latest server instance
      const latestResult = ApprovalServer.mock.results[ApprovalServer.mock.results.length - 1].value;
      latestResult.onApprovalNeeded('abc12345-6789', {
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: '{"command":"rm -rf /tmp"}',
        cwd: '/ws'
      });

      // The notification should be sent via the outbound adapter
      expect(mockApi.runtime.channel.outbound.loadAdapter).toHaveBeenCalled();
    });
  });
});
