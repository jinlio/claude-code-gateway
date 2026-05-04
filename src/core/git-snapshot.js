// GitSnapshot — stash-based snapshot with message positioning and session state validation
// See: cc-bridge-v3-final-plan.md Section 5

const { execSync } = require('child_process');

class GitSnapshot {
  constructor(bridge, sessionId) {
    this.bridge = bridge;
    this.sessionId = sessionId;
  }

  create() {
    const meta = this.bridge.sessionMeta.get(this.sessionId);
    if (!meta) return false;

    const stashRef = `CC-snapshot-${this.sessionId}-${Date.now()}`;

    try {
      execSync('git add -A', { cwd: meta.cwd, stdio: 'ignore' });
      execSync(`git stash push -u -m "${stashRef}"`, { cwd: meta.cwd, stdio: 'ignore' });
      meta.stashRef = stashRef;
      return true;
    } catch (e) {
      console.error('[GitSnapshot] Failed to create:', e.message);
      return false;
    }
  }

  revert() {
    const meta = this.bridge.sessionMeta.get(this.sessionId);
    if (!meta || !meta.stashRef) {
      return { success: false, message: 'No matching snapshot found' };
    }

    try {
      const stashList = execSync('git stash list', { cwd: meta.cwd }).toString();
      const idx = stashList.split('\n').findIndex(line =>
        line.includes(meta.stashRef)
      );

      if (idx === -1) {
        return { success: false, message: 'Snapshot manually deleted or missing' };
      }

      execSync(`git stash apply stash@{${idx}}`, { cwd: meta.cwd });
      return { success: true, message: 'Rolled back to pre-task state' };
    } catch (err) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  static cleanupOldStashes(bridge, cwd) {
    try {
      const stashList = execSync('git stash list', { cwd }).toString();
      const cutoff = Date.now() - 7 * 24 * 3600000;

      for (const line of stashList.split('\n')) {
        if (!line.includes('CC-snapshot-')) continue;

        const sessionIdMatch = line.match(/CC-snapshot-(\w+)-(\d+)/);
        if (!sessionIdMatch) continue;

        const sessionId = sessionIdMatch[1];
        const timestamp = parseInt(sessionIdMatch[2]);

        // Safety check: skip active sessions
        const meta = bridge.sessionMeta.get(sessionId);
        if (meta && meta.active) continue;

        if (timestamp < cutoff) {
          const idx = stashList.split('\n').indexOf(line);
          execSync(`git stash drop stash@{${idx}}`, { cwd });
        }
      }
    } catch {}
  }
}

module.exports = { GitSnapshot };