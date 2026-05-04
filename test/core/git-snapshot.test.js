// Tests for git-snapshot.js — stash create/revert, message positioning, session state validation, cleanup

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GitSnapshot } = require('../../src/core/git-snapshot');
const { ClaudeBridge } = require('../../src/core/claude-bridge');

const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe('GitSnapshot', () => {
  let tmpDir;
  let bridge;
  let sessionId;

  beforeAll(() => {
    if (!hasGit) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-git-'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'initial content');
    execSync('git add initial.txt', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'ignore' });

    bridge = new ClaudeBridge();
    sessionId = 'cc-1709000000-abc123';
    bridge.sessionMeta.set(sessionId, { cwd: tmpDir, active: true, stashRef: null });
  });

  afterAll(() => {
    if (!hasGit) return;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    if (!hasGit) return;
    bridge.sessionMeta.get(sessionId).stashRef = null;
    try { execSync('git stash clear', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
    // Restore clean working directory — checkout all tracked files
    try { execSync('git checkout -- .', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
    // Remove any untracked files from previous tests
    try { execSync('git clean -fd', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
  });

  (hasGit ? describe : describe.skip)('create', () => {
    it('creates a stash snapshot and records stashRef', () => {
      // Need working directory changes for stash to actually be created
      fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'new content');
      const snapshot = new GitSnapshot(bridge, sessionId);
      const result = snapshot.create();
      expect(result).toBe(true);
      expect(bridge.sessionMeta.get(sessionId).stashRef).toMatch(/^CC-snapshot-/);
    });

    it('returns false when session not found', () => {
      const snapshot = new GitSnapshot(bridge, 'nonexistent');
      expect(snapshot.create()).toBe(false);
    });

    it('captures working directory changes in stash', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      // File should be stashed away
      expect(fs.existsSync(path.join(tmpDir, 'change.txt'))).toBe(false);
    });

    it('returns false when git operations fail', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-nongit-'));
      bridge.sessionMeta.set('non-git-session', { cwd: nonGitDir, active: true, stashRef: null });
      const snapshot = new GitSnapshot(bridge, 'non-git-session');
      const result = snapshot.create();
      expect(result).toBe(false);
      try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
    });
  });

  (hasGit ? describe : describe.skip)('revert', () => {
    it('reverts to pre-task state using stashRef', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();

      const result = snapshot.revert();
      expect(result.success).toBe(true);
    });

    it('returns failure when no stashRef in meta', () => {
      const snapshot = new GitSnapshot(bridge, sessionId);
      const result = snapshot.revert();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/No matching snapshot/);
    });

    it('returns failure when stash has been manually deleted', () => {
      bridge.sessionMeta.get(sessionId).stashRef = 'CC-snapshot-test-session-1-12345';
      execSync('git stash clear', { cwd: tmpDir, stdio: 'ignore' });
      const snapshot = new GitSnapshot(bridge, sessionId);
      const result = snapshot.revert();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/manually deleted or missing/);
    });

    it('returns failure when revert command fails', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      const stashRef = bridge.sessionMeta.get(sessionId).stashRef;
      // Drop the stash but keep stashRef in meta
      execSync('git stash drop', { cwd: tmpDir, stdio: 'ignore' });
      bridge.sessionMeta.get(sessionId).stashRef = stashRef;

      const result = snapshot.revert();
      expect(result.success).toBe(false);
    });

    it('clears stashRef after successful revert', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      snapshot.revert();
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();
    });
  });

  (hasGit ? describe : describe.skip)('dropStash', () => {
    it('drops stash and clears stashRef', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      const result = snapshot.dropStash();
      expect(result.success).toBe(true);
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).not.toContain('CC-snapshot-');
    });

    it('returns failure when no stashRef', () => {
      const snapshot = new GitSnapshot(bridge, sessionId);
      const result = snapshot.dropStash();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/No matching snapshot/);
    });

    it('returns failure when stash already deleted', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      // Manually drop the stash, keep stashRef in meta
      execSync('git stash drop', { cwd: tmpDir, stdio: 'ignore' });

      const result = snapshot.dropStash();
      expect(result.success).toBe(false);
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();
    });
  });

  (hasGit ? describe : describe.skip)('cleanupOldStashes', () => {
    it('skips stashes belonging to active sessions', () => {
      fs.writeFileSync(path.join(tmpDir, 'change.txt'), 'changed');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();

      GitSnapshot.cleanupOldStashes(bridge, tmpDir);

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).toContain('CC-snapshot-');
    });

    it('drops stashes for inactive sessions older than 7 days', () => {
      // Create a stash with an old timestamp for an inactive session
      fs.writeFileSync(path.join(tmpDir, 'old-file.txt'), 'old content');
      const oldTimestamp = Date.now() - 8 * 24 * 3600000; // 8 days old
      const inactiveSessionId = 'cc-1709000000-xyz789';
      const oldStashRef = `CC-snapshot-${inactiveSessionId}-${oldTimestamp}`;
      execSync(`git stash push -u -m "${oldStashRef}"`, { cwd: tmpDir, stdio: 'ignore' });

      // Set session as inactive
      bridge.sessionMeta.set(inactiveSessionId, { cwd: tmpDir, active: false, stashRef: oldStashRef });

      GitSnapshot.cleanupOldStashes(bridge, tmpDir);

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).not.toContain('xyz789');
    });

    it('handles empty stash list gracefully', () => {
      execSync('git stash clear', { cwd: tmpDir, stdio: 'ignore' });
      GitSnapshot.cleanupOldStashes(bridge, tmpDir);
      // No crash
    });

    it('skips stash entries without CC-snapshot pattern', () => {
      // Modify an existing tracked file to create a stashable change
      fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'modified content');
      execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git stash push -m "regular-stash"', { cwd: tmpDir, stdio: 'ignore' });

      GitSnapshot.cleanupOldStashes(bridge, tmpDir);

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).toContain('regular-stash');
    });
  });
});