// OpenClaw plugin entry — ESM format, register(api) pattern
// Compatible with OpenClaw plugin SDK >= 2026.3.24-beta.2
// Commands handled via inbound_claim hook (not registerCommand)

import { fileURLToPath } from 'url';
import path from 'path';
import { ClaudeBridge } from '../core/claude-bridge.js';
import { ApprovalServer } from '../core/approval-server.js';
import { ApprovalRules } from '../core/approval-rules.js';
import { HookInbox } from '../core/hook-inbox.js';
import { PersistentSessionManager } from '../core/persistent-session-manager.js';
import { FeishuMessenger } from '../core/feishu-messenger.js';
import { CommandParser } from '../core/command-parser.js';
import { formatToolInput, storeSessionRoute, setupProcessForwarding, handleCommand } from './command-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CC_COMMANDS = ['cc', 'cc_start', 'cc_stop', 'cc_status', 'cc_answer', 'cc_approve', 'cc_deny', 'cc_revert', 'cc_context', 'cc_mode'];

const plugin = {
  id: 'claude-code-gateway',
  name: 'Claude Code Gateway',
  description: 'A gateway bridge connecting Claude Code CLI to messaging platforms with approval control, session management, and rollback support',

  register(api) {
    const config = api.pluginConfig || {};

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

    const dataDir = config.dataDir || './data';
    const bridgeOptions = {};
    if (config.sessionTimeout) bridgeOptions.sessionTimeout = config.sessionTimeout * 60000;
    if (config.heartbeatInterval) bridgeOptions.heartbeatInterval = config.heartbeatInterval * 1000;
    bridge = new ClaudeBridge(bridgeOptions);
    sessionManager = new PersistentSessionManager(dataDir);
    messenger = new FeishuMessenger(api, { maxMessageLength: config.maxMessageLength || 4000 });
    commandParser = new CommandParser();

    const rulesPath = config.approvalRulesPath || path.join(__dirname, '../../config/cc-approval-rules.yml');
    approvalRules = new ApprovalRules(rulesPath);

    if (config.defaultMode === 'efficient' || config.defaultMode === 'strict') {
      currentMode = config.defaultMode;
    }

    const defaultWorkspace = config.workspace || process.cwd();

    // Start async services on gateway startup
    api.on('gateway_start', async () => {
      const notifyCallback = (info) => {
        if (info.type === 'restart_timeout') {
          for (const [sid, meta] of [...bridge.sessionMeta.entries()]) {
            if (meta.active) {
              const route = sessionRoutes.get(sid);
              messenger.sendToUser(route?.senderId || meta.senderId, info.text, {
                channelId: route?.channelId,
                accountId: route?.accountId
              }).catch(err => {
                console.error('[cc-bridge] Message delivery failed:', err.message);
              });
            }
          }
        }
      };

      approvalServer = new ApprovalServer(
        dataDir,
        config.approvalServerPort || 0,
        notifyCallback,
        approvalRules,
        currentMode,
        config.sharedSecret || null
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
        }).catch(err => {
          console.error('[cc-bridge] Message delivery failed:', err.message);
        });
      };

      await approvalServer.start();
      hookInbox = new HookInbox();
    });

    // Cleanup on gateway stop
    api.on('gateway_stop', () => {
      if (approvalServer) approvalServer.stop();
      if (bridge) bridge.stopHeartbeat();
      for (const cm of contextManagers.values()) cm.cleanup();
      contextManagers.clear();
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

      const deps = { bridge, approvalServer, sessionManager, messenger, commandParser, contextManagers, sessionRoutes, hookInbox, pluginConfig: config, defaultWorkspace, currentMode };
      const result = await handleCommand(deps, commandName, args, senderId, channelId, accountId);
      // Sync mutable primitives back from deps (currentMode may change in cc_mode)
      currentMode = deps.currentMode;
      return { handled: true, reply: { text: result } };
    }, { priority: 100 });

    // (formatToolInput, storeSessionRoute, setupProcessForwarding, handleCommand
  //  are imported from ./command-handler.js — no local definitions needed)
  }
};

export default plugin;