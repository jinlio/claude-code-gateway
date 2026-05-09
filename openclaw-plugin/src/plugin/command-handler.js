// Shared command handler logic — used by both CJS (index.js) and ESM (entry.mjs) plugin entries
// Extracted to eliminate duplication of formatToolInput, storeSessionRoute, setupProcessForwarding,
// and all 10 command handlers.

const path = require('path');
const { GitSnapshot } = require('../core/git-snapshot');
const { ContextManager } = require('../core/context-manager');

/**
 * Format a tool's raw JSON input into a human-readable preview string.
 * @param {string} toolName - Tool name (Bash, Write, Edit, etc.)
 * @param {string} rawInput - Raw JSON string of the tool input
 * @returns {string} Truncated preview of the tool input
 */
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

/**
 * Store routing info for a session so output/error messages can be delivered
 * to the correct user, channel, and account.
 * @param {Map} sessionRoutes - Map of sessionId -> { senderId, channelId, accountId }
 * @param {string} sessionId
 * @param {string} senderId
 * @param {string} channelId
 * @param {string} accountId
 */
function storeSessionRoute(sessionRoutes, sessionId, senderId, channelId, accountId) {
  sessionRoutes.set(sessionId, {
    senderId,
    channelId,
    accountId,
  });
}

/**
 * Forward stdout/stderr from a Claude CLI process to the user via messenger,
 * and clean up the session route on process exit.
 * @param {object} messenger - FeishuMessenger instance
 * @param {object} bridge - ClaudeBridge instance
 * @param {Map} sessionRoutes - Map of sessionId -> route info
 * @param {ChildProcess} proc - The spawned Claude CLI process
 * @param {string} sessionId
 */
function setupProcessForwarding(messenger, bridge, sessionRoutes, proc, sessionId) {
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
        }).catch(err => {
          console.error('[cc-bridge] Message delivery failed:', err.message);
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
      }).catch(err => {
        console.error('[cc-bridge] Message delivery failed:', err.message);
      });
    }
  });

  proc.on('exit', (code) => {
    if (outputBuffer.trim() && target) {
      messenger.sendToUser(target, outputBuffer.trim(), {
        channelId: route?.channelId,
        accountId: route?.accountId
      }).catch(err => {
        console.error('[cc-bridge] Message delivery failed:', err.message);
      });
      outputBuffer = '';
    }

    if (code !== 0 && code !== null && target) {
      messenger.sendToUser(target, `会话进程退出 (code: ${code})`, {
        channelId: route?.channelId,
        accountId: route?.accountId
      }).catch(err => {
        console.error('[cc-bridge] Message delivery failed:', err.message);
      });
    }

    sessionRoutes.delete(sessionId);
  });
}

/**
 * Handle a /cc command and return a text reply.
 *
 * @param {object} deps - All runtime dependencies
 * @param {object} deps.bridge          - ClaudeBridge instance
 * @param {object} deps.approvalServer  - ApprovalServer instance (may be null before gateway_start)
 * @param {object} deps.sessionManager  - PersistentSessionManager instance
 * @param {object} deps.messenger       - FeishuMessenger instance
 * @param {object} deps.commandParser   - CommandParser instance
 * @param {Map}    deps.contextManagers - Map<workspace, ContextManager>
 * @param {Map}    deps.sessionRoutes   - Map<sessionId, route>
 * @param {object} deps.hookInbox       - HookInbox instance (may be null before gateway_start)
 * @param {object} deps.pluginConfig    - Plugin config object
 * @param {string} deps.defaultWorkspace - Default workspace path
 * @param {string} deps.currentMode     - 'efficient' or 'strict' (mutable via deps reference)
 * @param {string} commandName - One of: cc, cc_start, cc_stop, cc_status, cc_answer, cc_approve, cc_deny, cc_revert, cc_context, cc_mode
 * @param {string} args       - Command arguments (everything after the command name)
 * @param {string} senderId   - User who sent the command
 * @param {string} channelId  - Channel where the command was sent
 * @param {string} accountId  - Account context
 * @returns {Promise<string>} Reply text
 */
async function handleCommand(deps, commandName, args, senderId, channelId, accountId) {
  const {
    bridge,
    approvalServer,
    sessionManager,
    messenger,
    commandParser,
    contextManagers,
    sessionRoutes,
    hookInbox,
    pluginConfig,
    defaultWorkspace,
    currentMode,
  } = deps;

  // /cc <prompt> — one-shot task
  if (commandName === 'cc') {
    const prompt = args.trim();
    if (!prompt) return '用法: /cc <任务描述>';

    const workspace = defaultWorkspace;
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
    storeSessionRoute(sessionRoutes, sessionId, senderId, channelId, accountId);
    const proc = bridge.processMap.get(sessionId);
    if (proc) setupProcessForwarding(messenger, bridge, sessionRoutes, proc, sessionId);

    return `任务已提交 (ID: ${sessionId.slice(0, 8)})`;
  }

  // /cc_start — start persistent session
  if (commandName === 'cc_start') {
    const workspace = defaultWorkspace;
    const existing = bridge.findActiveSession(senderId);
    if (existing) {
      const meta = bridge.sessionMeta.get(existing);
      const proc = bridge.processMap.get(existing);
      return messenger.formatSessionStatus(meta, proc, existing);
    }

    const { sessionId } = await bridge.spawnSession(senderId, workspace, '');
    storeSessionRoute(sessionRoutes, sessionId, senderId, channelId, accountId);
    sessionManager.activate(senderId, workspace, sessionId);

    const proc = bridge.processMap.get(sessionId);
    if (proc) setupProcessForwarding(messenger, bridge, sessionRoutes, proc, sessionId);

    let cm = contextManagers.get(workspace);
    if (!cm) {
      cm = new ContextManager(workspace);
      contextManagers.set(workspace, cm);
    }
    cm.cleanOrphanedRules(bridge);
    cm.injectRules();

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
    // Mutate via deps reference so caller sees the update
    deps.currentMode = mode;
    return `已切换到 ${mode} 模式。`;
  }

  return `未知命令: ${commandName}\n\n${commandParser.getHelpText()}`;
}

module.exports = { formatToolInput, storeSessionRoute, setupProcessForwarding, handleCommand };