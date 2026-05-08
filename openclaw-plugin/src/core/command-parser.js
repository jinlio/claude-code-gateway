// CommandParser — parse Feishu commands for Claude Code gateway
// See: cc-bridge-v3-final-plan.md Section 7.1

const COMMANDS = [
  'cc',
  'cc_start',
  'cc_stop',
  'cc_status',
  'cc_answer',
  'cc_approve',
  'cc_deny',
  'cc_revert',
  'cc_context',
  'cc_mode'
];

class CommandParser {
  parse(text) {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('/')) return null;

    const withoutSlash = trimmed.slice(1);
    const spaceIdx = withoutSlash.indexOf(' ');
    const commandName = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

    if (!COMMANDS.includes(commandName)) {
      return { command: null, args: trimmed, unknown: true };
    }

    return { command: commandName, args, unknown: false };
  }

  getCommands() {
    return [...COMMANDS];
  }

  getHelpText() {
    return [
      'CC Bridge 命令列表:',
      '/cc <prompt> — 发送任务到 Claude Code',
      '/cc_start — 启动持久会话',
      '/cc_stop — 停止持久会话',
      '/cc_status — 查看会话状态',
      '/cc_answer <text> — 回答 Claude Code 的问题',
      '/cc_approve <id> — 批准审批请求',
      '/cc_deny <id> — 拒绝审批请求',
      '/cc_revert — 回滚代码变更',
      '/cc_context — 查看项目上下文',
      '/cc_mode [efficient|strict] — 切换审批模式'
    ].join('\n');
  }
}

module.exports = { CommandParser, COMMANDS };
