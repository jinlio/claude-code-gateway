// Plugin entry point — CJS version for backward compat and testing
// OpenClaw plugin spec: register(api) pattern, inbound_claim hook for /cc commands
// ESM entry.mjs is the OpenClaw runtime entry; this CJS file mirrors the same logic

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

const CC_COMMANDS = ['cc', 'cc_start', 'cc_stop', 'cc_status', 'cc_answer', 'cc_approve', 'cc_deny', 'cc_revert', 'cc_context', 'cc_mode'];

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

  const defaultWorkspace = pluginConfig.workspace || process.cwd();

  if (api?.on) {
    api.on('gateway_start', async () => {
      await startServices(dataDir);
    });

    api.on('gateway_stop', () => {
      stopServices();
    });

    // Intercept /cc commands via inbound_claim hook
    api.on('inbound_claim', async (event, ctx) => {
      // OpenClaw inbound_claim uses CommandBody (PascalCase) for command text
      const content = (event.CommandBody || event.commandBody || event.content || '').trim();
      if (!content.startsWith('/')) return;

      const withoutSlash = content.slice(1);
      const spaceIdx = withoutSlash.indexOf(' ');
      const commandName = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);

      if (!CC_COMMANDS.includes(commandName)) return;

      const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

      const senderId = event.senderId || ctx.senderId;
      const accountId = ctx.accountId;
      const channelId = ctx.channelId;

      const result = await handleCommand(commandName, args, senderId, channelId, accountId);
      return { handled: true, reply: { text: result } };
    }, { priority: 100 });
  }
}

async function startServices(dataDir) {
  const notifyCallback = (info) => {
    if (info.type === 'restart_timeout') {
      for (const [sid, meta] of [...bridge.sessionMeta.entries()]) {
        if (meta.active) {
          const route = sessionRoutes.get(sid);
          messenger.sendToUser(route?.senderId || meta.senderId, info.text, {
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
    const target = route?.senderId || meta?.senderId || params.sessionId;
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

function storeSessionRoute(sessionId, senderId, channelId, accountId) {
  sessionRoutes.set(sessionId, {
    senderId,
    channelId,
    accountId,
  });
}

function setupProcessForwarding(proc, sessionId) {
  const route = sessionRoutes.get(sessionId);
  const target = route?.senderId;
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

async function handleCommand(commandName, args, senderId, channelId, accountId) {
  // /cc <prompt> — one-shot task
  if (commandName === 'cc') {
    const prompt = args.trim();
    if (!prompt) return '用法: /cc <任务描述>';

    const workspace = pluginConfig.workspace || process.cwd();
    const existingSessionId = bridge.findActiveSession(senderId);
    if (existingSessionId) {
      const proc = bridge.processMap.get(existingSessionId);
      if (proc && proc.exitCode === null) {
        proc.stdin.write(prompt + '\n');
        bridge.updateActivity(existingSessionId);
        return '已发送到持久会话。';
      }
    }

    const { sessionId } = await bridge.spawnSession(senderId, workspace, prompt);
    storeSessionRoute(sessionId, senderId, channelId, accountId);
    const proc = bridge.processMap.get(sessionId);
    if (proc) setupProcessForwarding(proc, sessionId);

    return `任务已提交 (ID: ${sessionId.slice(0, 8)})`;
  }

  // /cc_start — start persistent session
  if (commandName === 'cc_start') {
    const workspace = pluginConfig.workspace || process.cwd();
    const existing = bridge.findActiveSession(senderId);
    if (existing) {
      const meta = bridge.sessionMeta.get(existing);
      const proc = bridge.processMap.get(existing);
      return messenger.formatSessionStatus(meta, proc, existing);
    }

    const { sessionId } = await bridge.spawnSession(senderId, workspace, '');
    storeSessionRoute(sessionId, senderId, channelId, accountId);
    sessionManager.activate(senderId, workspace, sessionId);

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

    return `持久会话已启动 (ID: ${sessionId.slice(0, 8)})\n模式: ${currentMode}\n审批服务端口: ${port}\n快照: ${snapshotCreated ? '已创建' : '未创建（非Git目录）'}`;
  }

  // /cc_stop — stop persistent session
  if (commandName === 'cc_stop') {
    const sessionId = bridge.findActiveSession(senderId);
    if (!sessionId || !bridge.sessionMeta.get(sessionId)?.active) {
      return '当前没有持久会话。';
    }

    const meta = bridge.sessionMeta.get(sessionId);
    if (meta.senderId !== senderId) {
      return '无权停止该会话，只有会话创建者可以停止。';
    }

    bridge.terminateSession(sessionId);
    sessionManager.deactivate(senderId);
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
    return `会话已停止 (ID: ${sessionId.slice(0, 8)})\n运行时长: ${runtime} 分钟\n消息数: ${meta.messageCount}`;
  }

  // /cc_status — check session status
  if (commandName === 'cc_status') {
    const sessionId = bridge.findActiveSession(senderId);
    if (!sessionId) return '当前没有活跃的持久会话。';
    const meta = bridge.sessionMeta.get(sessionId);
    const proc = bridge.processMap.get(sessionId);
    return messenger.formatSessionStatus(meta, proc, sessionId);
  }

  // /cc_answer — reply to Claude's question
  if (commandName === 'cc_answer') {
    const answer = args.trim();
    if (!answer) return '用法: /cc_answer <回答内容>';

    const sessionId = bridge.findActiveSession(senderId);
    if (!sessionId) return '没有活跃会话。';

    const proc = bridge.processMap.get(sessionId);
    if (proc && proc.exitCode === null) {
      proc.stdin.write(answer + '\n');
      bridge.updateActivity(sessionId);
      return '已发送回答。';
    }
    return '会话进程已退出，无法回答。';
  }

  // /cc_approve — approve a pending request
  if (commandName === 'cc_approve') {
    const shortId = args.trim();
    if (!shortId) return '用法: /cc_approve <审批ID>';

    const item = approvalServer.store.findByShortId(shortId);
    if (!item) return '未找到该审批请求。';
    if (item.ambiguous) return `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}`;
    if (item.status !== 'PENDING') return `该请求已处理: ${item.status}`;

    const meta = bridge.sessionMeta.get(item.sessionId);
    if (meta && meta.senderId !== senderId) {
      return '无权审批该请求，只有会话创建者可以操作。';
    }

    approvalServer.store.resolve(item.id, 'APPROVED');
    return `已批准 #${shortId}: ${item.toolName}`;
  }

  // /cc_deny — deny a pending request
  if (commandName === 'cc_deny') {
    const shortId = args.trim();
    if (!shortId) return '用法: /cc_deny <审批ID>';

    const item = approvalServer.store.findByShortId(shortId);
    if (!item) return '未找到该审批请求。';
    if (item.ambiguous) return `ID "${shortId}" 匹配到多个请求，请使用更长的ID。\n匹配: ${item.matches.map(m => m.id.slice(0, 12)).join(', ')}`;
    if (item.status !== 'PENDING') return `该请求已处理: ${item.status}`;

    const meta = bridge.sessionMeta.get(item.sessionId);
    if (meta && meta.senderId !== senderId) {
      return '无权审批该请求，只有会话创建者可以操作。';
    }

    approvalServer.store.resolve(item.id, 'DENIED');
    return `已拒绝 #${shortId}: ${item.toolName}`;
  }

  // /cc_revert — rollback code changes
  if (commandName === 'cc_revert') {
    const revertArgs = args.trim();

    if (revertArgs === '--confirm') {
      const sessionId = bridge.findActiveSession(senderId);
      if (!sessionId) return '没有活跃的会话。';

      const meta = bridge.sessionMeta.get(sessionId);
      if (!meta?.stashRef) return '无可用的快照，无法回滚。（可能已回滚过或启动时未创建快照）';

      const snapshot = new GitSnapshot(bridge, sessionId);
      const result = snapshot.revert();
      return result.success ? '已回滚到任务前状态。' : `回滚失败: ${result.message}`;
    }

    if (revertArgs === '--cancel') return '已取消回滚。';

    const sessionId = bridge.findActiveSession(senderId);
    if (!sessionId) return '没有活跃的会话。';

    const meta = bridge.sessionMeta.get(sessionId);
    if (!meta?.stashRef) return '无可用的快照。（可能已回滚过或启动时未创建快照）';

    return `确认回滚？\n将恢复到上次 CC 任务前的状态。\n\n确认: /cc_revert --confirm\n取消: /cc_revert --cancel`;
  }

  // /cc_context — view project context
  if (commandName === 'cc_context') {
    const sessionId = bridge.findActiveSession(senderId);
    if (!sessionId) return '没有活跃会话。';

    const meta = bridge.sessionMeta.get(sessionId);
    const cm = contextManagers.get(meta.cwd);
    const contextInfo = cm?.buildContextPrompt(meta.cwd) || '(无上下文)';
    return `当前项目上下文:\n\n${contextInfo}`;
  }

  // /cc_mode — switch approval mode
  if (commandName === 'cc_mode') {
    const mode = args.trim();
    if (!mode || (mode !== 'efficient' && mode !== 'strict')) {
      return `当前模式: ${currentMode}\nefficient — Edit/Write 免审批，仅 Bash 需审批\nstrict — 全部操作需审批\n\n切换: /cc_mode efficient 或 /cc_mode strict`;
    }

    const matcher = mode === 'efficient' ? 'Bash' : 'Bash|Write|Edit';
    if (hookInbox) hookInbox.updateMatcher(matcher);
    if (approvalServer) approvalServer.setMode(mode);
    currentMode = mode;
    return `已切换到 ${mode} 模式。`;
  }

  return `未知命令: ${commandName}\n\n${commandParser.getHelpText()}`;
}

const pluginDefinition = {
  id: 'claude-code-gateway',
  name: 'Claude Code Gateway',
  description: 'A gateway bridge connecting Claude Code CLI to messaging platforms with approval control, session management, and rollback support',
  register
};

module.exports = { register, pluginDefinition, formatToolInput, handleCommand, storeSessionRoute, setupProcessForwarding, FeishuMessenger, CommandParser };