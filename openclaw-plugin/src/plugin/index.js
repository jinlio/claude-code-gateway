// Plugin entry point — CJS version for backward compat and testing
// OpenClaw plugin spec: register(api) pattern, inbound_claim hook for /cc commands
// ESM entry.mjs is the OpenClaw runtime entry; this CJS file mirrors the same logic

const path = require('path');
const { ClaudeBridge } = require('../core/claude-bridge');
const { ApprovalServer } = require('../core/approval-server');
const { ApprovalRules } = require('../core/approval-rules');
const { HookInbox } = require('../core/hook-inbox');
const { PersistentSessionManager } = require('../core/persistent-session-manager');
const { FeishuMessenger } = require('../core/feishu-messenger');
const { CommandParser } = require('../core/command-parser');
const { formatToolInput, storeSessionRoute, setupProcessForwarding, handleCommand } = require('./command-handler');

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
let defaultWorkspace = process.cwd();

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

  defaultWorkspace = pluginConfig.workspace || process.cwd();

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

      const deps = { bridge, approvalServer, sessionManager, messenger, commandParser, contextManagers, sessionRoutes, hookInbox, pluginConfig, defaultWorkspace, currentMode };
      const result = await handleCommand(deps, commandName, args, senderId, channelId, accountId);
      // Sync mutable primitives back from deps (currentMode may change in cc_mode)
      currentMode = deps.currentMode;
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
          }).catch(err => {
            console.error('[cc-bridge] Message delivery failed:', err.message);
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
    }).catch(err => {
      console.error('[cc-bridge] Message delivery failed:', err.message);
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

// (formatToolInput, storeSessionRoute, setupProcessForwarding, handleCommand
//  are imported from ./command-handler.js — no local definitions needed)

const pluginDefinition = {
  id: 'claude-code-gateway',
  name: 'Claude Code Gateway',
  description: 'A gateway bridge connecting Claude Code CLI to messaging platforms with approval control, session management, and rollback support',
  register
};

module.exports = { register, pluginDefinition, formatToolInput, handleCommand, storeSessionRoute, setupProcessForwarding, FeishuMessenger, CommandParser };