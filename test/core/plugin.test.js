// Tests for plugin/index.js — register(api), command registration, formatToolInput

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

const { register, formatToolInput } = require('../../src/plugin/index');
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

describe('register(api)', () => {
  it('initializes all modules and registers commands', () => {
    const mockApi = { registerCommand: jest.fn(), on: jest.fn() };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-plugin-'));
    const config = { dataDir: tmpDir };

    ApprovalServer.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(7890),
      getPort: jest.fn().mockReturnValue(7890),
      store: { findByShortId: jest.fn(), resolve: jest.fn(), findBySessionId: jest.fn().mockReturnValue([]), listPending: jest.fn().mockReturnValue([]) },
      setMode: jest.fn(),
      onApprovalNeeded: null
    }));

    register({ ...mockApi, pluginConfig: config });

    expect(mockApi.registerCommand).toHaveBeenCalledTimes(10);

    expect(mockApi.on).toHaveBeenCalledWith('gateway_start', expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith('gateway_stop', expect.any(Function));

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

  it('reads config from api.pluginConfig', () => {
    const mockApi = { registerCommand: jest.fn(), on: jest.fn(), pluginConfig: { defaultMode: 'strict' } };

    ApprovalServer.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(7890),
      getPort: jest.fn().mockReturnValue(7890),
      store: { findByShortId: jest.fn(), resolve: jest.fn() },
      setMode: jest.fn(),
      onApprovalNeeded: null
    }));

    register(mockApi);

    expect(mockApi.registerCommand).toHaveBeenCalledTimes(10);
  });
});

describe('command execute handlers', () => {
  let mockApi;
  let commands;
  let tmpDir;

  beforeEach(() => {
    mockApi = {
      registerCommand: jest.fn(),
      on: jest.fn(),
      pluginConfig: { dataDir: '/tmp/cc-bridge-test' },
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

    register(mockApi);
    commands = {};
    for (const call of mockApi.registerCommand.mock.calls) {
      commands[call[0].name] = call[0].execute;
    }
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('cc_mode', () => {
    it('shows current mode when no valid arg given', async () => {
      const result = await commands.cc_mode({ userId: 'u1', input: '' });
      expect(result.output).toContain('当前模式');
      expect(result.output).toContain('efficient');
    });

    it('switches to efficient mode and syncs with server', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const modeExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_mode')[0].execute;

      const result = await modeExecute({ userId: 'u1', input: 'efficient' });
      expect(result.output).toContain('efficient');
    });

    it('switches to strict mode and syncs with server', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const modeExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_mode')[0].execute;

      const result = await modeExecute({ userId: 'u1', input: 'strict' });
      expect(result.output).toContain('strict');
    });
  });

  describe('cc_start', () => {
    it('shows session status when an active session already exists', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('existing');
      bridgeInstance.sessionMeta.set('existing', { cwd: '/ws', startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messageCount: 3 });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const startExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_start')[0].execute;

      const result = await startExecute({ userId: 'u1', workspace: '/ws' });
      expect(result.output).toContain('持久会话状态');
    });
  });

  describe('cc_stop', () => {
    it('returns message when no session exists', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const stopExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_stop')[0].execute;

      const result = await stopExecute({ userId: 'u1' });
      expect(result.output).toContain('没有持久会话');
    });
  });

  describe('cc_status', () => {
    it('returns no active session message', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const statusExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_status')[0].execute;

      const result = await statusExecute({ userId: 'u1' });
      expect(result.output).toContain('没有活跃');
    });
  });

  describe('cc_answer', () => {
    it('returns usage message when no answer provided', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const answerExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_answer')[0].execute;

      const result = await answerExecute({ userId: 'u1', input: '' });
      expect(result.output).toContain('用法');
    });
  });

  describe('cc_approve', () => {
    it('returns usage when no shortId provided', async () => {
      mockApi.registerCommand.mockClear();
      register(mockApi);
      const approveExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_approve')[0].execute;

      const result = await approveExecute({ input: '' });
      expect(result.output).toContain('用法');
    });
  });

  describe('cc_deny', () => {
    it('returns usage when no shortId provided', async () => {
      mockApi.registerCommand.mockClear();
      register(mockApi);
      const denyExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_deny')[0].execute;

      const result = await denyExecute({ input: '' });
      expect(result.output).toContain('用法');
    });
  });

  describe('cc_revert', () => {
    it('returns no session when no active session', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const revertExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].execute;

      const result = await revertExecute({ userId: 'u1', input: '' });
      expect(result.output).toContain('没有活跃');
    });

    it('shows confirmation prompt when no --confirm/--cancel', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: 'CC-snapshot-s1-123456' });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const revertExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].execute;

      const result = await revertExecute({ userId: 'u1', input: '' });
      expect(result.output).toContain('确认回滚');
    });

    it('shows no snapshot message when stashRef is null', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: null });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const revertExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].execute;

      const result = await revertExecute({ userId: 'u1', input: '' });
      expect(result.output).toContain('无可用的快照');
    });

    it('shows no snapshot message when --confirm but no stashRef', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true, stashRef: null });

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const revertExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].execute;

      const result = await revertExecute({ userId: 'u1', input: '--confirm' });
      expect(result.output).toContain('无可用的快照');
    });

    it('cancels revert when --cancel', async () => {
      mockApi.registerCommand.mockClear();
      register(mockApi);
      const revertExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_revert')[0].execute;

      const result = await revertExecute({ userId: 'u1', input: '--cancel' });
      expect(result.output).toContain('已取消');
    });
  });

  describe('cc_context', () => {
    it('returns no session when no active session', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue(null);

      mockApi.registerCommand.mockClear();
      register(mockApi);
      const ctxExecute = mockApi.registerCommand.mock.calls.find(c => c[0].name === 'cc_context')[0].execute;

      const result = await ctxExecute({ userId: 'u1' });
      expect(result.output).toContain('没有活跃');
    });
  });

  describe('onApprovalNeeded formatting', () => {
    it('formats approval notification with tool input preview', async () => {
      const bridgeInstance = new ClaudeBridge();
      bridgeInstance.findActiveSession.mockReturnValue('s1');
      bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', cwd: '/ws', active: true });

      mockApi.registerCommand.mockClear();
      register(mockApi);

      const gatewayStartCall = mockApi.on.mock.calls.find(c => c[0] === 'gateway_start');
      if (gatewayStartCall) {
        await gatewayStartCall[1]();
      }

      const latestResult = ApprovalServer.mock.results[ApprovalServer.mock.results.length - 1].value;
      latestResult.onApprovalNeeded('abc12345-6789', {
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: '{"command":"rm -rf /tmp"}',
        cwd: '/ws'
      });

      expect(mockApi.runtime.channel.outbound.loadAdapter).toHaveBeenCalled();
    });
  });
});