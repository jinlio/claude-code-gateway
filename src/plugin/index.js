// Plugin entry point — command registration, session orchestration, message forwarding
// OpenClaw plugin spec: register(api) pattern, api.registerCommand with execute() handler
// CJS version kept for backward compatibility and testing; ESM entry.mjs is the OpenClaw runtime entry

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
let messenger;
let commandParser;
let contextManagers = new Map();
let sessionRoutes = new Map();
let currentMode = 'efficient';
let pluginConfig = {};

function register(api) {
  pluginConfig = api?.pluginConfig || {};

  const dataDir = pluginConfig.dataDir || './data';
  const bridgeOptions = {};
  if (pluginConfig.sessionTimeout) bridgeOptions.sessionTimeout = pluginConfig.sessionTimeout * 60000;
  if (pluginConfig.heartbeatInterval) bridgeOptions.heartbeatInterval = pluginConfig.heartbeatInterval * 1000;
  bridge = new ClaudeBridge(bridgeOptions);
  sessionManager = new PersistentSessionManager(dataDir);
  messenger = new FeishuMessenger(api, { maxMessageLength: pluginConfig.maxMessageLength || 4000 });
  commandParser = new CommandParser();

  const rulesPath = pluginConfig.approvalRulesPath || path.join(__dirname, '../../config/cc-approval-rules.yml');
  approvalRules = new ApprovalRules(rulesPath);

  if (pluginConfig.defaultMode === 'efficient' || pluginConfig.defaultMode === 'strict') {
    currentMode = pluginConfig.defaultMode;
  }

  if (api?.on) {
    api.on('gateway_start', async () => {
      await startServices(dataDir);
    });

    api.on('gateway_stop', () => {
      stopServices();
    });
  }

  registerCommands(api);
}

async function startServices(dataDir) {
  const notifyCallback = (info) => {
    if (info.type === 'restart_timeout') {
      for (const [sid, meta] of [...bridge.sessionMeta.entries()]) {
        if (meta.active) {
          const route = sessionRoutes.get(sid);
          messenger.sendToUser(route?.userId || meta.senderId, info.text, {
            channelId: route?.channelId,
            accountId: route?.accountId
          });
        }
      }
    }
  };

  approvalServer = new ApprovalServer(
    dataDir,
    pluginConfig.approvalServerPort || 0,
    notifyCallback,
    approvalRules,
    currentMode,
    pluginConfig.sharedSecret || null
  );

  approvalServer.onApprovalNeeded = (id, params) => {
    const inputPreview = formatToolInput(params.toolName, params.toolInput);
    const meta = bridge.sessionMeta.get(params.sessionId);
    const route = sessionRoutes.get(params.sessionId);
    const target = route?.userId || meta?.senderId || params.sessionId;
    const notification = messenger.formatApprovalNotification(id, params.toolName, inputPreview, params.cwd);
    messenger.sendToUser(target, notification, {
      channelId: route?.channelId,
      accountId: route?.accountId
    });
  };

  const port = await approvalServer.start();
  hookInbox = new HookInbox();
}

function stopServices() {
  if (approvalServer) approvalServer.stop();
  if (bridge) bridge.stopHeartbeat();
  for (const cm of contextManagers.values()) cm.cleanup();
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
    return { output: `未知命令: ${parsed.args}\n\n${commandParser.getHelpText()}` };
  }

  return parsed;
}

function storeSessionRoute(sessionId, ctx) {
  sessionRoutes.set(sessionId, {
    channelId: ctx.channelId || ctx.channel,
    userId: ctx.userId || ctx.senderId,
    accountId: ctx.accountId || ctx.config?.accountId
  });
}

function setupProcessForwarding(proc, sessionId) {
  const route = sessionRoutes.get(sessionId);
  const target = route?.userId;
  let outputBuffer = '';

  proc.stdout.on('data', (chunk) => {
    outputBuffer += chunk.toString();
    bridge.updateActivity(sessionId);

    const lines = outputBuffer.split('\n');
    if (lines.length > 1) {
      outputBuffer = lines.pop();
      const completeLines = lines.join('\n');
      if (completeLines.trim() && target) {
        messenger.sendToUser(target, completeLines, {
          channelId: route?.channelId,
          accountId: route?.accountId
        });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text && target) {
      messenger.sendToUser(target, messenger.formatErrorMessage(text), {
        channelId: route?.channelId,
        accountId: route?.accountId
      });
    }
  });

  proc.on('exit', (code) => {
    if (outputBuffer.trim() && target) {
      messenger.sendToUser(target, outputBuffer.trim(), {
        channelId: route?.channelId,
        accountId: route?.accountId
      });
      outputBuffer = '';
    }

    if (code !== 0 && code !== null && target) {
      messenger.sendToUser(target, `会话进程退出 (code: ${code})`, {
        channelId: route?.channelId,
        accountId: route?.accountId
      });
    }

    sessionRoutes.delete(sessionId);
  });
}

function registerCommands(api) {
  // /cc <prompt> — one-shot task
  api.registerCommand({
    name: 'cc',
    description: '发送任务到 Claude Code',
    execute: async (ctx) => {
      const prompt = (ctx.input || ctx.args)?.trim();
      if (!prompt) {
        return { output: '用法: /cc <任务描述>' };
      }

      const userId = ctx.userId || ctx.senderId;
      const workspace = ctx.workspace || process.cwd();

      const existingSessionId = bridge.findActiveSession(userId);
      if (existingSessionId) {
        const proc = bridge.processMap.get(existingSessionId);
        if (proc && proc.exitCode === null) {
          proc.stdin.write(prompt + '\n');
          bridge.updateActivity(existingSessionId);
          return { output: '已发送到持久会话。' };
        }
      }

      const { sessionId } = await bridge.spawnSession(userId, workspace, prompt);
      storeSessionRoute(sessionId, ctx);
      const proc = bridge.processMap.get(sessionId);
      if (proc) setupProcessForwarding(proc, sessionId);

      return { output: `任务已提交 (ID: ${sessionId.slice(0, 8)})` };
    }
  });

  // /cc_start — start persistent session
  api.registerCommand({
    name: 'cc_start',
    description: '启动持久会话',
    execute: async (ctx) => {
      const userId = ctx.userId || ctx.senderId;
      const workspace = ctx.workspace || process.cwd();

      const existing = bridge.findActiveSession(userId);
      if (existing) {
        const meta = bridge.sessionMeta.get(existing);
        const proc = bridge.processMap.get(existing);
        return { output: messenger.formatSessionStatus(meta, proc, existing) };
      }

      const { sessionId } = await bridge.spawnSession(userId, workspace, '');
      storeSessionRoute(sessionId, ctx);
      sessionManager.activate(userId, workspace, sessionId);

      const proc = bridge.processMap.get(sessionId);
      if (proc) setupProcessForwarding(proc, sessionId);

      let contextManager = contextManagers.get(workspace);
      if (!contextManager) {
        contextManager = new ContextManager(workspace);
        contextManagers.set(workspace, contextManager);
      }
      contextManager.cleanOrphanedRules(bridge);
      contextManager.injectRules();

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

      return {
        output: `持久会话已启动 (ID: ${sessionId.slice(0, 8)})\n模式: ${currentMode}\n审批服务端口: ${port}\n快照: ${snapshotCreated ? '已创建' : '未创建（非Git目录）'}`
      };
    }
  });

  // /cc_stop — stop persistent session
  api.registerCommand({
    name: 'cc_stop',
    description: '停止持久会话',
    execute: async (ctx) => {
      const userId = ctx.userId || ctx.senderId;
      const sessionId = bridge.findActiveSession(userId);
      if (!sessionId || !bridge.sessionMeta.get(sessionId)?.active) {
        return { output: '当前没有持久会话。' };
      }

      const meta = bridge.sessionMeta.get(sessionId);
      if (meta.senderId !== userId) {
        return { output: '无权停止该会话，只有会话创建者可以停止。' };
      }

      bridge.terminateSession(sessionId);
      sessionManager.deactivate(userId);
      sessionRoutes.delete(sessionId);

      const snapshot = new GitSnapshot(bridge, sessionId);
      if (meta.stashRef) snapshot.dropStash();

      const cm = contextManagers.get(meta.cwd);
      if (cm) {
        cm.cleanup();
        contextManagers.delete(meta.cwd);
      }

      GitSnapshot.cleanupOldStashes(bridge, meta.cwd);

      const runtime = Math.round((Date.now() - new Date(meta.startedAt).getTime()) / 60000);
      return { output: `会话已停止 (ID: ${sessionId.slice(0, 8)})\n运行时长: ${runtime} 分钟\n消息数: ${meta.messageCount}` };
    }
  });

  // /cc_status — check session status
  api.registerCommand({
    name: 'cc_status',
    description: '查看会话状态',
    execute: async (ctx) => {
      const userId = ctx.userId || ctx.senderId;
      const sessionId = bridge.findActiveSession(userId);
      if (!sessionId) {
        return { output: '当前没有活跃的持久会话。' };
      }
      const meta = bridge.sessionMeta.get(sessionId);
      const proc = bridge.processMap.get(sessionId);
      return { output: messenger.formatSessionStatus(meta, proc, sessionId) };
    }
  });

  // /cc_answer — reply to Claude's question
  api.registerCommand({
    name: 'cc_answer',
    description: '回答 Claude Code 的问题',
    execute: async (ctx) => {
      const answer = (ctx.input || ctx.args)?.trim();
      if (!answer) {
        return { output: '用法: /cc_answer <回答内容>' };
      }

      const userId = ctx.userId || ctx.senderId;
      const sessionId = bridge.findActiveSession(userId);
      if (!sessionId) {
        return { output: '没有活跃会话。' };
      }

      const proc = bridge.processMap.get(sessionId);
      if (proc && proc.exitCode === null) {
        proc.stdin.write(answer + '\n');
        bridge.updateActivity(sessionId);
        return { output: '已发送回答。' };
      }
      return { output: '会话进程已退出，无法回答。' };
    }
  });

  // /cc_approve — approve a pending request
  api.registerCommand({
    name: 'cc_approve',
    description: '批准审批请求',
    execute: async (ctx) => {
      const shortId = (ctx.input || ctx.args)?.trim();
      if (!shortId) return { output: '用法: /cc_approve <审批ID>' };

      const item = approvalServer.store.findByShortId(shortId);
      if (!item) return { output: '未找到该审批请求。' };
      if (item.ambiguous) return { output: `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}` };
      if (item.status !== 'PENDING') return { output: `该请求已处理: ${item.status}` };

      const userId = ctx.userId || ctx.senderId;
      const meta = bridge.sessionMeta.get(item.sessionId);
      if (meta && meta.senderId !== userId) {
        return { output: '无权审批该请求，只有会话创建者可以操作。' };
      }

      approvalServer.store.resolve(item.id, 'APPROVED');
      return { output: `已批准 #${shortId}: ${item.toolName}` };
    }
  });

  // /cc_deny — deny a pending request
  api.registerCommand({
    name: 'cc_deny',
    description: '拒绝审批请求',
    execute: async (ctx) => {
      const shortId = (ctx.input || ctx.args)?.trim();
      if (!shortId) return { output: '用法: /cc_deny <审批ID>' };

      const item = approvalServer.store.findByShortId(shortId);
      if (!item) return { output: '未找到该审批请求。' };
      if (item.ambiguous) return { output: `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}` };
      if (item.status !== 'PENDING') return { output: `该请求已处理: ${item.status}` };

      const userId = ctx.userId || ctx.senderId;
      const meta = bridge.sessionMeta.get(item.sessionId);
      if (meta && meta.senderId !== userId) {
        return { output: '无权审批该请求，只有会话创建者可以操作。' };
      }

      approvalServer.store.resolve(item.id, 'DENIED');
      return { output: `已拒绝 #${shortId}: ${item.toolName}` };
    }
  });

  // /cc_revert — rollback code changes
  api.registerCommand({
    name: 'cc_revert',
    description: '回滚代码变更',
    execute: async (ctx) => {
      const args = (ctx.input || ctx.args)?.trim();

      if (args === '--confirm') {
        const userId = ctx.userId || ctx.senderId;
        const sessionId = bridge.findActiveSession(userId);
        if (!sessionId) return { output: '没有活跃的会话。' };

        const meta = bridge.sessionMeta.get(sessionId);
        if (!meta?.stashRef) return { output: '无可用的快照，无法回滚。（可能已回滚过或启动时未创建快照）' };

        const snapshot = new GitSnapshot(bridge, sessionId);
        const result = snapshot.revert();
        return { output: result.success ? '已回滚到任务前状态。' : `回滚失败: ${result.message}` };
      }

      if (args === '--cancel') {
        return { output: '已取消回滚。' };
      }

      const userId = ctx.userId || ctx.senderId;
      const sessionId = bridge.findActiveSession(userId);
      if (!sessionId) return { output: '没有活跃的会话。' };

      const meta = bridge.sessionMeta.get(sessionId);
      if (!meta?.stashRef) return { output: '无可用的快照。（可能已回滚过或启动时未创建快照）' };

      return {
        output: `确认回滚？\n将恢复到上次 CC 任务前的状态。\n\n确认: /cc_revert --confirm\n取消: /cc_revert --cancel`
      };
    }
  });

  // /cc_context — view project context
  api.registerCommand({
    name: 'cc_context',
    description: '查看项目上下文信息',
    execute: async (ctx) => {
      const userId = ctx.userId || ctx.senderId;
      const sessionId = bridge.findActiveSession(userId);
      if (!sessionId) return { output: '没有活跃会话。' };

      const meta = bridge.sessionMeta.get(sessionId);
      const cm = contextManagers.get(meta.cwd);
      const contextInfo = cm?.buildContextPrompt(meta.cwd) || '(无上下文)';
      return { output: `当前项目上下文:\n\n${contextInfo}` };
    }
  });

  // /cc_mode — switch approval mode
  api.registerCommand({
    name: 'cc_mode',
    description: '切换审批模式',
    execute: async (ctx) => {
      const mode = (ctx.input || ctx.args)?.trim();
      if (!mode || (mode !== 'efficient' && mode !== 'strict')) {
        return {
          output: `当前模式: ${currentMode}\nefficient — Edit/Write 免审批，仅 Bash 需审批\nstrict — 全部操作需审批\n\n切换: /cc_mode efficient 或 /cc_mode strict`
        };
      }

      const matcher = mode === 'efficient' ? 'Bash' : 'Bash|Write|Edit';
      if (hookInbox) hookInbox.updateMatcher(matcher);
      if (approvalServer) approvalServer.setMode(mode);
      currentMode = mode;
      return { output: `已切换到 ${mode} 模式。` };
    }
  });
}

// Expose plugin definition and helpers for testing
const pluginDefinition = {
  id: 'claude-code-gateway',
  name: 'Claude Code Gateway',
  description: 'A gateway bridge connecting Claude Code CLI to messaging platforms with approval control, session management, and rollback support',
  register
};

module.exports = { register, pluginDefinition, formatToolInput, handleIncomingMessage, setupProcessForwarding, FeishuMessenger, CommandParser };