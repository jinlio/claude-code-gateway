// Plugin entry point — command registration, session orchestration, message forwarding
// See: cc-bridge-v3-final-plan.md Sections 3, 7, 8
// OpenClaw plugin spec: definePluginEntry pattern, api.registerCommand, api.on lifecycle

const path = require('path');
const { ClaudeBridge } = require('../core/claude-bridge');
const { ApprovalServer } = require('../core/approval-server');
const { ApprovalRules } = require('../core/approval-rules');
const { GitSnapshot } = require('../core/git-snapshot');
const { HookInbox } = require('../core/hook-inbox');
const { PersistentSessionManager } = require('../core/persistent-session-manager');
const { ContextManager } = require('../core/context-manager');
const { FeishuMessenger } = require('../core/feishu-messenger');
const { CommandParser } = require('../core/command-parser');

let bridge;
let approvalServer;
let approvalRules;
let hookInbox;
let sessionManager;
let contextManagers = new Map(); // workspace → ContextManager
let messenger;
let commandParser;
let currentMode = 'efficient';
let pluginConfig = {};

function init(api, config) {
  pluginConfig = config || api?.pluginConfig || {};

  const dataDir = pluginConfig.dataDir || './data';
  const bridgeOptions = {};
  if (pluginConfig.sessionTimeout) bridgeOptions.sessionTimeout = pluginConfig.sessionTimeout * 60000;
  if (pluginConfig.heartbeatInterval) bridgeOptions.heartbeatInterval = pluginConfig.heartbeatInterval * 1000;
  bridge = new ClaudeBridge(bridgeOptions);
  sessionManager = new PersistentSessionManager(dataDir);
  messenger = new FeishuMessenger(api, { maxMessageLength: pluginConfig.maxMessageLength || 4000 });
  commandParser = new CommandParser();

  // Load approval rules first (needed by server)
  const rulesPath = pluginConfig.approvalRulesPath || path.join(__dirname, '../../config/cc-approval-rules.yml');
  approvalRules = new ApprovalRules(rulesPath);

  if (pluginConfig.defaultMode === 'efficient' || pluginConfig.defaultMode === 'strict') {
    currentMode = pluginConfig.defaultMode;
  }

  // Register gateway lifecycle hooks
  if (api?.on) {
    api.on('gateway_start', async () => {
      await startServices(dataDir);
    });

    api.on('gateway_stop', () => {
      stopServices();
    });
  }

  // Register commands
  registerCommands(api);
}

async function startServices(dataDir) {
  const notifyCallback = (info) => {
    if (info.type === 'restart_timeout') {
      for (const [sid, meta] of bridge.sessionMeta) {
        if (meta.active) {
          messenger.sendToUser(meta.senderId, info.text);
        }
      }
    }
  };

  approvalServer = new ApprovalServer(dataDir, pluginConfig.approvalServerPort || 0, notifyCallback, approvalRules, currentMode, pluginConfig.sharedSecret || null);
  approvalServer.onApprovalNeeded = (id, params) => {
    const inputPreview = formatToolInput(params.toolName, params.toolInput);
    // Look up senderId directly from sessionMeta by sessionId (not senderId)
    const meta = bridge.sessionMeta.get(params.sessionId);
    const senderId = meta?.senderId || params.sessionId;
    const notification = messenger.formatApprovalNotification(id, params.toolName, inputPreview, params.cwd);
    messenger.sendToUser(senderId, notification);
  };

  const port = await approvalServer.start();
  hookInbox = new HookInbox();
}

function stopServices() {
  if (approvalServer) {
    approvalServer.stop();
  }
  if (bridge) {
    bridge.stopHeartbeat();
  }
  for (const cm of contextManagers.values()) {
    cm.cleanup();
  }
  contextManagers.clear();
}

function formatToolInput(toolName, rawInput) {
  try {
    const input = JSON.parse(rawInput);
    if (toolName === 'Bash') return input.command?.slice(0, 200) || '(no command)';
    if (toolName === 'Write' || toolName === 'Edit') return input.file_path || '(no path)';
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return rawInput?.slice(0, 200) || '(no content)';
  }
}

function handleIncomingMessage(senderId, workspace, text) {
  const parsed = commandParser.parse(text);
  if (!parsed) return null;

  if (parsed.unknown) {
    return { text: `未知命令: ${parsed.args}\n\n${commandParser.getHelpText()}` };
  }

  return parsed;
}

function setupProcessForwarding(proc, sessionId, senderId) {
  let outputBuffer = '';

  proc.stdout.on('data', (chunk) => {
    outputBuffer += chunk.toString();
    bridge.updateActivity(sessionId);

    // Flush complete lines
    const lines = outputBuffer.split('\n');
    if (lines.length > 1) {
      outputBuffer = lines.pop();
      const completeLines = lines.join('\n');
      if (completeLines.trim()) {
        messenger.sendToUser(senderId, completeLines);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      messenger.sendToUser(senderId, messenger.formatErrorMessage(text));
    }
  });

  proc.on('exit', (code) => {
    // Flush remaining buffer
    if (outputBuffer.trim()) {
      messenger.sendToUser(senderId, outputBuffer.trim());
      outputBuffer = '';
    }

    if (code !== 0 && code !== null) {
      messenger.sendToUser(senderId, `会话进程退出 (code: ${code})`);
    }
  });
}

function registerCommands(api) {
  // /cc <prompt> — one-shot task (non-persistent session)
  api.registerCommand({
    name: 'cc',
    description: '发送任务到 Claude Code',
    handler: async (ctx) => {
      const prompt = ctx.args?.trim();
      if (!prompt) {
        return { text: '用法: /cc <任务描述>' };
      }

      const senderId = ctx.senderId;
      const workspace = ctx.workspace;

      // If there's an active persistent session, send to it
      const existingSessionId = bridge.findActiveSession(senderId);
      if (existingSessionId) {
        const proc = bridge.processMap.get(existingSessionId);
        if (proc && proc.exitCode === null) {
          proc.stdin.write(prompt + '\n');
          bridge.updateActivity(existingSessionId);
          return { text: '已发送到持久会话。' };
        }
      }

      // Create a one-shot session
      const { sessionId } = await bridge.spawnSession(senderId, workspace, prompt);
      const proc = bridge.processMap.get(sessionId);
      if (proc) {
        setupProcessForwarding(proc, sessionId, senderId);
      }

      return { text: `任务已提交 (ID: ${sessionId.slice(0, 8)})` };
    }
  });

  // /cc_start
  api.registerCommand({
    name: 'cc_start',
    description: '启动持久会话',
    handler: async (ctx) => {
      const senderId = ctx.senderId;
      const workspace = ctx.workspace;

      const existing = bridge.findActiveSession(senderId);
      if (existing) {
        const meta = bridge.sessionMeta.get(existing);
        const proc = bridge.processMap.get(existing);
        return { text: messenger.formatSessionStatus(meta, proc, existing) };
      }

      const { sessionId } = await bridge.spawnSession(senderId, workspace, '');
      sessionManager.activate(senderId, workspace, sessionId);

      const proc = bridge.processMap.get(sessionId);
      if (proc) {
        setupProcessForwarding(proc, sessionId, senderId);
      }

      // Clean orphaned rules from previous sessions
      let contextManager = contextManagers.get(workspace);
      if (!contextManager) {
        contextManager = new ContextManager(workspace);
        contextManagers.set(workspace, contextManager);
      }
      contextManager.cleanOrphanedRules(bridge);

      // Inject context rules for this session
      contextManager.injectRules();

      // Create git snapshot for rollback safety
      const gitSnapshotEnabled = pluginConfig.gitSnapshotEnabled !== false;
      const snapshot = new GitSnapshot(bridge, sessionId);
      const snapshotCreated = gitSnapshotEnabled ? snapshot.create() : false;

      const port = approvalServer?.getPort();
      if (port && hookInbox) {
        hookInbox.writeHookConfig(
          path.join(workspace, '.claude', 'settings.local.json'),
          port,
          currentMode === 'efficient' ? 'Bash' : 'Bash|Write|Edit'
        );
      }

      return { text: `持久会话已启动 (ID: ${sessionId.slice(0, 8)})\n模式: ${currentMode}\n审批服务端口: ${port}\n快照: ${snapshotCreated ? '已创建' : '未创建（非Git目录）'}` };
    }
  });

  // /cc_stop
  api.registerCommand({
    name: 'cc_stop',
    description: '停止持久会话',
    handler: async (ctx) => {
      const senderId = ctx.senderId;
      const sessionId = bridge.findActiveSession(senderId);
      if (!sessionId || !bridge.sessionMeta.get(sessionId)?.active) {
        return { text: '当前没有持久会话。' };
      }

      // Check permission: only the session owner can stop it
      const meta = bridge.sessionMeta.get(sessionId);
      if (meta.senderId !== ctx.senderId) {
        return { text: '无权停止该会话，只有会话创建者可以停止。' };
      }

      bridge.terminateSession(sessionId);
      sessionManager.deactivate(senderId);

      // Drop git snapshot if exists
      const snapshot = new GitSnapshot(bridge, sessionId);
      if (meta.stashRef) {
        snapshot.dropStash();
      }

      // Clean up injected rules
      const cm = contextManagers.get(meta.cwd);
      if (cm) {
        cm.cleanup();
        contextManagers.delete(meta.cwd);
      }

      // Cleanup old stashes periodically
      GitSnapshot.cleanupOldStashes(bridge, meta.cwd);

      const runtime = Math.round((Date.now() - new Date(meta.startedAt).getTime()) / 60000);
      return { text: `会话已停止 (ID: ${sessionId.slice(0, 8)})\n运行时长: ${runtime} 分钟\n消息数: ${meta.messageCount}` };
    }
  });

  // /cc_status
  api.registerCommand({
    name: 'cc_status',
    description: '查看会话状态',
    handler: async (ctx) => {
      const sessionId = bridge.findActiveSession(ctx.senderId);
      if (!sessionId) {
        return { text: '当前没有活跃的持久会话。' };
      }
      const meta = bridge.sessionMeta.get(sessionId);
      const proc = bridge.processMap.get(sessionId);
      return { text: messenger.formatSessionStatus(meta, proc, sessionId) };
    }
  });

  // /cc_answer
  api.registerCommand({
    name: 'cc_answer',
    description: '回答 Claude Code 的问题',
    handler: async (ctx) => {
      const answer = ctx.args?.trim();
      if (!answer) {
        return { text: '用法: /cc_answer <回答内容>' };
      }

      const sessionId = bridge.findActiveSession(ctx.senderId);
      if (!sessionId) {
        return { text: '没有活跃会话。' };
      }

      // Forward answer to the Claude process stdin
      const proc = bridge.processMap.get(sessionId);
      if (proc && proc.exitCode === null) {
        proc.stdin.write(answer + '\n');
        bridge.updateActivity(sessionId);
        return { text: '已发送回答。' };
      }
      return { text: '会话进程已退出，无法回答。' };
    }
  });

  // /cc_approve
  api.registerCommand({
    name: 'cc_approve',
    description: '批准审批请求',
    handler: async (ctx) => {
      const shortId = ctx.args?.trim();
      if (!shortId) return { text: '用法: /cc_approve <审批ID>' };

      const item = approvalServer.store.findByShortId(shortId);
      if (!item) return { text: '未找到该审批请求。' };
      if (item.ambiguous) return { text: `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}` };
      if (item.status !== 'PENDING') return { text: `该请求已处理: ${item.status}` };

      // Ownership check: only the session owner can approve
      const meta = bridge.sessionMeta.get(item.sessionId);
      if (meta && meta.senderId !== ctx.senderId) {
        return { text: '无权审批该请求，只有会话创建者可以操作。' };
      }

      approvalServer.store.resolve(item.id, 'APPROVED');
      return { text: `已批准 #${shortId}: ${item.toolName}` };
    }
  });

  // /cc_deny
  api.registerCommand({
    name: 'cc_deny',
    description: '拒绝审批请求',
    handler: async (ctx) => {
      const shortId = ctx.args?.trim();
      if (!shortId) return { text: '用法: /cc_deny <审批ID>' };

      const item = approvalServer.store.findByShortId(shortId);
      if (!item) return { text: '未找到该审批请求。' };
      if (item.ambiguous) return { text: `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}` };
      if (item.status !== 'PENDING') return { text: `该请求已处理: ${item.status}` };

      // Ownership check: only the session owner can deny
      const meta = bridge.sessionMeta.get(item.sessionId);
      if (meta && meta.senderId !== ctx.senderId) {
        return { text: '无权审批该请求，只有会话创建者可以操作。' };
      }

      approvalServer.store.resolve(item.id, 'DENIED');
      return { text: `已拒绝 #${shortId}: ${item.toolName}` };
    }
  });

  // /cc_revert
  api.registerCommand({
    name: 'cc_revert',
    description: '回滚代码变更',
    handler: async (ctx) => {
      const args = ctx.args?.trim();

      if (args === '--confirm') {
        const sessionId = bridge.findActiveSession(ctx.senderId);
        if (!sessionId) return { text: '没有活跃的会话。' };

        const meta = bridge.sessionMeta.get(sessionId);
        if (!meta?.stashRef) return { text: '无可用的快照，无法回滚。（可能已回滚过或启动时未创建快照）' };

        const snapshot = new GitSnapshot(bridge, sessionId);
        const result = snapshot.revert();
        return { text: result.success ? '已回滚到任务前状态。' : `回滚失败: ${result.message}` };
      }

      if (args === '--cancel') {
        return { text: '已取消回滚。' };
      }

      const sessionId = bridge.findActiveSession(ctx.senderId);
      if (!sessionId) return { text: '没有活跃的会话。' };

      const meta = bridge.sessionMeta.get(sessionId);
      if (!meta?.stashRef) return { text: '无可用的快照。（可能已回滚过或启动时未创建快照）' };

      return {
        text: `确认回滚？\n将恢复到上次 CC 任务前的状态。\n\n确认: /cc_revert --confirm\n取消: /cc_revert --cancel`
      };
    }
  });

  // /cc_context
  api.registerCommand({
    name: 'cc_context',
    description: '查看项目上下文信息',
    handler: async (ctx) => {
      const sessionId = bridge.findActiveSession(ctx.senderId);
      if (!sessionId) return { text: '没有活跃会话。' };

      const meta = bridge.sessionMeta.get(sessionId);
      const cm = contextManagers.get(meta.cwd);
      const context = cm?.buildContextPrompt(meta.cwd) || '(无上下文)';
      return { text: `当前项目上下文:\n\n${context}` };
    }
  });

  // /cc_mode
  api.registerCommand({
    name: 'cc_mode',
    description: '切换审批模式',
    handler: async (ctx) => {
      const mode = ctx.args?.trim();
      if (!mode || (mode !== 'efficient' && mode !== 'strict')) {
        return {
          text: `当前模式: ${currentMode}\nefficient — Edit/Write 免审批，仅 Bash 需审批\nstrict — 全部操作需审批\n\n切换: /cc_mode efficient 或 /cc_mode strict`
        };
      }

      const matcher = mode === 'efficient' ? 'Bash' : 'Bash|Write|Edit';
      if (hookInbox) hookInbox.updateMatcher(matcher);
      if (approvalServer) approvalServer.setMode(mode);
      currentMode = mode;
      return { text: `已切换到 ${mode} 模式。` };
    }
  });
}

module.exports = { init, formatToolInput, handleIncomingMessage, setupProcessForwarding, FeishuMessenger, CommandParser };
