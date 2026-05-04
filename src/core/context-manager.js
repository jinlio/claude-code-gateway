// ContextManager — CLAUDE.md marker injection + temporary context
// See: cc-bridge-v3-final-plan.md Section 6

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { atomicWriteSync } = require('./utils');

const RULES_START = '<!-- CC-BRIDGE-RULES:START -->';
const RULES_END = '<!-- CC-BRIDGE-RULES:END -->';

class ContextManager {
  constructor(workspace) {
    this.workspace = workspace;
    this.claudeMdPath = path.join(workspace, 'CLAUDE.md');
    this.rulesContent = this.loadBridgeRules();
  }

  loadBridgeRules() {
    const rulesPath = path.join(__dirname, 'bridge-rules-template.md');
    if (fs.existsSync(rulesPath)) {
      return fs.readFileSync(rulesPath, 'utf8');
    }
    return '';
  }

  injectRules() {
    let content = '';
    if (fs.existsSync(this.claudeMdPath)) {
      content = fs.readFileSync(this.claudeMdPath, 'utf8');
    }

    content = this.removeInjectedRules(content);

    const injected = `${RULES_START}\n${this.rulesContent}\n${RULES_END}`;
    content += `\n\n${injected}`;

    atomicWriteSync(this.claudeMdPath, content);
  }

  cleanOrphanedRules(bridge) {
    if (!fs.existsSync(this.claudeMdPath)) return false;

    const content = fs.readFileSync(this.claudeMdPath, 'utf8');
    if (!content.includes(RULES_START)) return false;

    const hasActiveSession = [...bridge.sessionMeta.values()].some(
      meta => meta.active && meta.cwd === this.workspace
    );

    if (!hasActiveSession) {
      const cleaned = this.removeInjectedRules(content);
      atomicWriteSync(this.claudeMdPath, cleaned);
      return true;
    }
    return false;
  }

  removeInjectedRules(content) {
    const regex = new RegExp(
      `${RULES_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'gs'
    );
    return content.replace(regex, '').trim();
  }

  cleanup() {
    if (!fs.existsSync(this.claudeMdPath)) return;
    const content = fs.readFileSync(this.claudeMdPath, 'utf8');
    const cleaned = this.removeInjectedRules(content);
    atomicWriteSync(this.claudeMdPath, cleaned);
  }

  buildContextPrompt(workspace) {
    const parts = [];

    try {
      const branch = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
      parts.push(`当前分支: ${branch}`);
    } catch {}

    try {
      const files = execSync('git diff --name-only HEAD~5', { cwd: workspace }).toString().trim();
      if (files) {
        parts.push(`最近修改的文件:\n${files.split('\n').slice(0, 20).join('\n')}`);
      }
    } catch {}

    try {
      const listing = execSync(
        process.platform === 'win32' ? 'dir /b' : 'ls -la',
        { cwd: workspace }
      ).toString().trim();
      parts.push(`工作目录内容:\n${listing}`);
    } catch {}

    return parts.join('\n\n');
  }
}

module.exports = { ContextManager };