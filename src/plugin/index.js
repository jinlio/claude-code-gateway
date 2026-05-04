// Plugin entry point — command registration, session orchestration
// See: cc-bridge-v3-final-plan.md Sections 3, 7, 8

const { ClaudeBridge } = require('../core/claude-bridge');
const { ApprovalServer } = require('../core/approval-server');
const { ApprovalRules } = require('../core/approval-rules');
const { GitSnapshot } = require('../core/git-snapshot');
const { HookInbox } = require('../core/hook-inbox');
const { PersistentSessionManager } = require('../core/persistent-session-manager');
const { ContextManager } = require('../core/context-manager');

let bridge;
let approvalServer;
let approvalRules;
let hookInbox;
let sessionManager;
let contextManager;
let currentMode = 'efficient';

function init(api, config) {
  const dataDir = config.dataDir || './data';
  bridge = new ClaudeBridge();
  sessionManager = new PersistentSessionManager(dataDir);

  // Start approval server
  const notifyCallback = (info) => {
    api.sendMessage({
      channel: 'feishu',
      target: info.target,
      text: info.text
    });
  };

  approvalServer = new ApprovalServer(dataDir, config.approvalServerPort || 0, notifyCallback);
  approvalServer.start().then((port) => {
    hookInbox = new HookInbox();
    hookInbox.writeHookConfig(
      path.join(dataDir, 'hook-config.json'),
      port,
      currentMode === 'efficient' ? 'Bash' : 'Bash|Write|Edit'
    );
  });

  // Load approval rules
  const rulesPath = config.approvalRulesPath || path.join(__dirname, '../../config/cc-approval-rules.yml');
  approvalRules = new ApprovalRules(rulesPath);

  // Register commands
  registerCommands(api);
}

function registerCommands(api) {
  // /cc_start
  api.registerCommand({
    name: 'cc_start',
    description: '启动持久会话',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_stop
  api.registerCommand({
    name: 'cc_stop',
    description: '停止持久会话',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_status
  api.registerCommand({
    name: 'cc_status',
    description: '查看会话状态',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_approve
  api.registerCommand({
    name: 'cc_approve',
    description: '批准审批请求',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_deny
  api.registerCommand({
    name: 'cc_deny',
    description: '拒绝审批请求',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_revert
  api.registerCommand({
    name: 'cc_revert',
    description: '回滚代码变更',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_answer
  api.registerCommand({
    name: 'cc_answer',
    description: '回答 Claude Code 的问题',
    handler: async (ctx) => {
      // ... implementation
    }
  });

  // /cc_context
  api.registerCommand({
    name: 'cc_context',
    description: '查看项目上下文信息',
    handler: async (ctx) => {
      // ... implementation
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
      hookInbox.updateMatcher(matcher);
      currentMode = mode;
      return { text: `已切换到 ${mode} 模式。` };
    }
  });
}

module.exports = { init };