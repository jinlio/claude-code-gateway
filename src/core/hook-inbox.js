// HookInbox — hook config writer with OS-aware script selection and mode support
// See: cc-bridge-v3-final-plan.md Section 3.7, 3.8

const fs = require('fs');
const path = require('path');

class HookInbox {
  constructor() {
    this.hookConfigPath = null;
  }

  writeHookConfig(outputPath, approvalServerPort, matcher = 'Bash') {
    const bridgeUrl = `http://127.0.0.1:${approvalServerPort}`;

    const hookScriptPath = process.platform === 'win32'
      ? path.join(__dirname, '../../scripts/cc-bridge-approval-hook.mjs')
      : path.join(__dirname, '../../scripts/cc-bridge-approval-hook.sh');

    const config = {
      hooks: {
        PreToolUse: [{
          matcher,
          hooks: [{
            type: 'command',
            command: `${hookScriptPath} $CLAUDE_TOOL_NAME $CLAUDE_TOOL_INPUT`
          }]
        }]
      },
      env: {
        CC_BRIDGE_URL: bridgeUrl,
        CLAUDE_SESSION_ID: '$CLAUDE_SESSION_ID'
      }
    };

    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
    this.hookConfigPath = outputPath;
  }

  updateMatcher(matcher) {
    if (!this.hookConfigPath) return;
    const config = JSON.parse(fs.readFileSync(this.hookConfigPath, 'utf8'));
    config.hooks.PreToolUse[0].matcher = matcher;
    fs.writeFileSync(this.hookConfigPath, JSON.stringify(config, null, 2));
  }
}

module.exports = { HookInbox };