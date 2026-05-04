// HookInbox — hook config writer with OS-aware script selection and mode support
// See: cc-bridge-v3-final-plan.md Section 3.7, 3.8

const fs = require('fs');
const path = require('path');
const { atomicWriteSync, safeLoadJson } = require('./utils');

class HookInbox {
  constructor() {
    this.hookConfigPath = null;
  }

  writeHookConfig(outputPath, approvalServerPort, matcher = 'Bash') {
    const bridgeUrl = `http://127.0.0.1:${approvalServerPort}`;

    const hookScriptPath = process.platform === 'win32'
      ? path.join(__dirname, '../../scripts/cc-bridge-approval-hook.mjs')
      : path.join(__dirname, '../../scripts/cc-bridge-approval-hook.sh');

    // Build the command — on Windows use node explicitly, quote paths for spaces
    const commandPrefix = process.platform === 'win32' ? 'node ' : '';
    const hookCommand = `${commandPrefix}"${hookScriptPath}"`;

    const newConfig = {
      hooks: {
        PreToolUse: [{
          matcher,
          hooks: [{
            type: 'command',
            command: hookCommand
          }]
        }]
      },
      env: {
        CC_BRIDGE_URL: bridgeUrl
      }
    };

    // Merge with existing config instead of overwriting
    const existing = safeLoadJson(outputPath);
    const merged = {
      ...existing,
      hooks: {
        ...(existing.hooks || {}),
        PreToolUse: newConfig.hooks.PreToolUse
      },
      env: {
        ...(existing.env || {}),
        ...newConfig.env
      }
    };

    atomicWriteSync(outputPath, JSON.stringify(merged, null, 2));
    this.hookConfigPath = outputPath;
  }

  updateMatcher(matcher) {
    if (!this.hookConfigPath) return;
    const config = safeLoadJson(this.hookConfigPath);
    if (config.hooks?.PreToolUse?.[0]) {
      config.hooks.PreToolUse[0].matcher = matcher;
      atomicWriteSync(this.hookConfigPath, JSON.stringify(config, null, 2));
    }
  }
}

module.exports = { HookInbox };
