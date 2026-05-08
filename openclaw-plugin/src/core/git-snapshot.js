// GitSnapshot — stash-based snapshot with message positioning and session state validation
// See: cc-bridge-v3-final-plan.md Section 5

const { execSync } = require('child_process');

// Regex for sessionId format: cc-<timestamp>-<random>
const SESSION_ID_REGEX = /CC-snapshot-(cc-\d+-[a-z0-9]+)-(\d+)/;

class GitSnapshot {
  constructor(bridge, sessionId) {
    this.bridge = bridge;
    this.sessionId = sessionId;
  }

  create() {
    const meta = this.bridge.sessionMeta.get(this.sessionId);
    if (!meta) return false;

    const stashRef = `CC-snapshot-${this.sessionId}-${Date.now()}`;

    // Sanitize stashRef to prevent shell injection
    const safeRef = stashRef.replace(/[^a-zA-Z0-9_.-]/g, '_');

    try {
      execSync('git add -A', { cwd: meta.cwd, stdio: 'ignore' });
      execSync(`git stash push -u -m "${safeRef}"`, { cwd: meta.cwd, stdio: 'ignore' });
      meta.stashRef = safeRef;
      return true;
    } catch (e) {
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

      if (idx === -1 || !Number.isInteger(idx) || idx < 0) {
        return { success: false, message: 'Snapshot manually deleted or missing' };
      }

      // Discard current working tree changes before applying stash
      try { execSync('git checkout -- .', { cwd: meta.cwd, stdio: 'ignore' }); } catch {}
      try { execSync('git clean -fd', { cwd: meta.cwd, stdio: 'ignore' }); } catch {}

      execSync(`git stash apply stash@{${idx}}`, { cwd: meta.cwd });

      // Clear stashRef to prevent duplicate revert
      meta.stashRef = null;
      return { success: true, message: 'Rolled back to pre-task state' };
    } catch (err) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  dropStash() {
    const meta = this.bridge.sessionMeta.get(this.sessionId);
    if (!meta || !meta.stashRef) {
      return { success: false, message: 'No matching snapshot found' };
    }

    try {
      const stashList = execSync('git stash list', { cwd: meta.cwd }).toString();
      const entries = stashList.split('\n');
      const idx = entries.findIndex(line => line.includes(meta.stashRef));

      if (idx === -1 || !Number.isInteger(idx) || idx < 0) {
        meta.stashRef = null;
        return { success: false, message: 'Snapshot manually deleted or missing' };
      }

      execSync(`git stash drop stash@{${idx}}`, { cwd: meta.cwd });
      meta.stashRef = null;
      return { success: true, message: 'Snapshot dropped' };
    } catch (err) {
      return { success: false, message: `Drop failed: ${err.message}` };
    }
  }

  static cleanupOldStashes(bridge, cwd, cleanupDays = 7) {
    try {
      const stashList = execSync('git stash list', { cwd }).toString();
      const cutoff = Date.now() - cleanupDays * 24 * 3600000;
      const entries = stashList.split('\n').filter(Boolean);

      // Collect indices to drop (iterate forward, but apply in reverse)
      const toDrop = [];
      for (let i = 0; i < entries.length; i++) {
        const line = entries[i];
        if (!line.includes('CC-snapshot-')) continue;

        const sessionIdMatch = line.match(SESSION_ID_REGEX);
        if (!sessionIdMatch) continue;

        const sessionId = sessionIdMatch[1];
        const timestamp = parseInt(sessionIdMatch[2]);

        // Safety check: skip active sessions
        const meta = bridge.sessionMeta.get(sessionId);
        if (meta && meta.active) continue;

        if (timestamp < cutoff) {
          toDrop.push(i);
        }
      }

      // Drop in reverse order to preserve indices
      for (let i = toDrop.length - 1; i >= 0; i--) {
        try {
          execSync(`git stash drop stash@{${toDrop[i]}}`, { cwd });
        } catch {}
      }
    } catch {}
  }
}

module.exports = { GitSnapshot };
