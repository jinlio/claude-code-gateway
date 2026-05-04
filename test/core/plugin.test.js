// Tests for plugin/index.js — register(api), inbound_claim hook, handleCommand

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

const { register, formatToolInput, handleCommand } = require('../../src/plugin/index');
const { ClaudeBridge } = require('../../src/core/claude-bridge');
const { ApprovalServer } = require('../../src/core/approval-server');
const { ApprovalRules } = require('../../src/core/approval-rules');
const { HookInbox } = require('../../src/core/hook-inbox');
const { PersistentSessionManager } = require('../../src/core/persistent-session-manager');
const { ContextManager } = require('../../src/core/context-manager');

function createMockApi(extraConfig = {}) {
  return {
    on: jest.fn(),
    pluginConfig: { dataDir: '/tmp/cc-bridge-test', ...extraConfig },
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
}

function setupMocks() {
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
}

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
  beforeEach(setupMocks);

  it('initializes modules and registers inbound_claim hook', () => {
    const mockApi = createMockApi();
    register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith('gateway_start', expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith('gateway_stop', expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith('inbound_claim', expect.any(Function), expect.any(Object));
  });

  it('reads config from api.pluginConfig', () => {
    const mockApi = createMockApi({ defaultMode: 'strict' });
    register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith('inbound_claim', expect.any(Function), expect.any(Object));
  });
});

describe('inbound_claim handler', () => {
  beforeEach(setupMocks);

  it('ignores non-slash messages', async () => {
    const mockApi = createMockApi();
    register(mockApi);
    const handler = mockApi.on.mock.calls.find(c => c[0] === 'inbound_claim')[1];

    const result = await handler({ content: 'hello', senderId: 'u1' }, { channelId: 'feishu' });
    expect(result).toBeUndefined();
  });

  it('ignores non-CC commands', async () => {
    const mockApi = createMockApi();
    register(mockApi);
    const handler = mockApi.on.mock.calls.find(c => c[0] === 'inbound_claim')[1];

    const result = await handler({ content: '/help', senderId: 'u1' }, { channelId: 'feishu' });
    expect(result).toBeUndefined();
  });

  it('claims /cc commands with reply', async () => {
    const mockApi = createMockApi();
    register(mockApi);
    const handler = mockApi.on.mock.calls.find(c => c[0] === 'inbound_claim')[1];

    const result = await handler({ content: '/cc_mode', senderId: 'u1' }, { channelId: 'feishu' });
    expect(result).toEqual({ handled: true, reply: expect.objectContaining({ text: expect.any(String) }) });
    expect(result.reply.text).toContain('当前模式');
  });

  it('claims /cc <prompt> command', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue(null);
    bridgeInstance.spawnSession.mockResolvedValue({ sessionId: 'cc-1234567890-abcd' });
    register(mockApi);
    const handler = mockApi.on.mock.calls.find(c => c[0] === 'inbound_claim')[1];

    const result = await handler({ content: '/cc 检查项目状态', senderId: 'u1' }, { channelId: 'feishu', senderId: 'u1' });
    expect(result.handled).toBe(true);
    expect(result.reply.text).toContain('任务已提交');
  });
});

describe('handleCommand', () => {
  beforeEach(setupMocks);

  it('returns usage for /cc without prompt', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue(null);
    register(mockApi);

    const result = await handleCommand('cc', '', 'u1', 'feishu', null);
    expect(result).toContain('用法');
  });

  it('returns no session for /cc_stop without session', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue(null);
    register(mockApi);

    const result = await handleCommand('cc_stop', '', 'u1', 'feishu', null);
    expect(result).toContain('没有持久会话');
  });

  it('returns no session for /cc_status without session', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue(null);
    register(mockApi);

    const result = await handleCommand('cc_status', '', 'u1', 'feishu', null);
    expect(result).toContain('没有活跃');
  });

  it('returns usage for /cc_answer without answer', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue(null);
    register(mockApi);

    const result = await handleCommand('cc_answer', '', 'u1', 'feishu', null);
    expect(result).toContain('用法');
  });

  it('returns usage for /cc_approve without shortId', async () => {
    const mockApi = createMockApi();
    register(mockApi);

    const result = await handleCommand('cc_approve', '', 'u1', 'feishu', null);
    expect(result).toContain('用法');
  });

  it('returns usage for /cc_deny without shortId', async () => {
    const mockApi = createMockApi();
    register(mockApi);

    const result = await handleCommand('cc_deny', '', 'u1', 'feishu', null);
    expect(result).toContain('用法');
  });

  it('switches to efficient mode', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue('s1');
    bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });
    register(mockApi);

    // Start services to initialize approvalServer
    const gatewayStartCall = mockApi.on.mock.calls.find(c => c[0] === 'gateway_start');
    if (gatewayStartCall) await gatewayStartCall[1]();

    const result = await handleCommand('cc_mode', 'efficient', 'u1', 'feishu', null);
    expect(result).toContain('efficient');
  });

  it('switches to strict mode', async () => {
    const mockApi = createMockApi();
    const bridgeInstance = new ClaudeBridge();
    bridgeInstance.findActiveSession.mockReturnValue('s1');
    bridgeInstance.sessionMeta.set('s1', { senderId: 'u1', active: true });
    register(mockApi);

    const gatewayStartCall = mockApi.on.mock.calls.find(c => c[0] === 'gateway_start');
    if (gatewayStartCall) await gatewayStartCall[1]();

    const result = await handleCommand('cc_mode', 'strict', 'u1', 'feishu', null);
    expect(result).toContain('strict');
  });

  it('returns cancel message for /cc_revert --cancel', async () => {
    const mockApi = createMockApi();
    register(mockApi);

    const result = await handleCommand('cc_revert', '--cancel', 'u1', 'feishu', null);
    expect(result).toContain('已取消');
  });
});