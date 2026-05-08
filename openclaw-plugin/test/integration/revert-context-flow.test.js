// Integration tests for revert + context flow
// Tests end-to-end: snapshot creation, CLAUDE.md injection, revert, cleanup, orphaned rules

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { GitSnapshot } = require('../../src/core/git-snapshot');
const { ContextManager } = require('../../src/core/context-manager');
const { ClaudeBridge } = require('../../src/core/claude-bridge');

const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe('Revert + Context — end-to-end integration', () => {
  let tmpDir;
  let bridge;

  beforeAll(() => {
    if (!hasGit) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-revert-'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'initial content');
    execSync('git add initial.txt', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterAll(() => {
    if (!hasGit) return;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    if (!hasGit) return;
    bridge = new ClaudeBridge();
    try { execSync('git stash clear', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
    try { execSync('git checkout -- .', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
    try { execSync('git clean -fd', { cwd: tmpDir, stdio: 'ignore' }); } catch {}
    // Remove any CLAUDE.md from previous tests
    try { fs.unlinkSync(path.join(tmpDir, 'CLAUDE.md')); } catch {}
    // Remove any test files from previous tests
    for (const f of ['feature.txt', 'new-feature.txt', 'another-file.txt', 'temp.txt', 'active.txt', 'old.txt', 'new-file.txt']) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
    }
  });

  (hasGit ? describe : describe.skip)('snapshot + revert lifecycle', () => {
    it('creates snapshot on session start, reverts changes, and clears stashRef', () => {
      const sessionId = 'revert-test-1';
      bridge.sessionMeta.set(sessionId, { cwd: tmpDir, active: true, stashRef: null, senderId: 'u1' });

      // Create an initial file and commit it so stash can track changes
      fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'initial state');
      execSync('git add feature.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "add feature"', { cwd: tmpDir, stdio: 'ignore' });

      // Step 1: Create snapshot (simulates cc_start)
      const snapshot = new GitSnapshot(bridge, sessionId);
      // Modify tracked file for stash to capture
      fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'modified before snapshot');
      const created = snapshot.create();
      expect(created).toBe(true);
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      // Step 2: Simulate CC making more changes to tracked file
      fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'modified by CC');

      // Step 3: Revert (simulates /cc_revert --confirm)
      const result = snapshot.revert();
      expect(result.success).toBe(true);

      // stashRef should be cleared after revert
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();

      // Second revert should fail (no snapshot)
      const result2 = snapshot.revert();
      expect(result2.success).toBe(false);
    });

    it('dropStash cleans up snapshot after session ends', () => {
      const sessionId = 'drop-test-1';
      bridge.sessionMeta.set(sessionId, { cwd: tmpDir, active: true, stashRef: null, senderId: 'u1' });

      fs.writeFileSync(path.join(tmpDir, 'temp.txt'), 'temp');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      // Simulate cc_stop: drop the stash
      const dropResult = snapshot.dropStash();
      expect(dropResult.success).toBe(true);
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();

      // Verify stash is gone
      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).not.toContain('CC-snapshot-');
    });
  });

  (hasGit ? describe : describe.skip)('CLAUDE.md injection lifecycle', () => {
    it('injects rules on session start and cleans up on stop', () => {
      const sessionId = 'context-test-1';
      bridge.sessionMeta.set(sessionId, { cwd: tmpDir, active: true, senderId: 'u1' });
      const cm = new ContextManager(tmpDir);

      // Step 1: Inject rules (simulates cc_start)
      cm.injectRules();
      let content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
      expect(content).toContain('<!-- CC-BRIDGE-RULES:START -->');
      expect(content).toContain('CC Gateway 项目规则');

      // Step 2: Cleanup (simulates cc_stop)
      cm.cleanup();
      content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
      expect(content).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
    });

    it('cleans up orphaned rules on new session start', () => {
      const cm = new ContextManager(tmpDir);

      // Simulate previous session left orphaned rules
      cm.injectRules();
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toContain('<!-- CC-BRIDGE-RULES:START -->');

      // New bridge with no active sessions
      const freshBridge = new ClaudeBridge();
      const cleaned = cm.cleanOrphanedRules(freshBridge);
      expect(cleaned).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
    });

    it('preserves orphaned rules when another active session exists', () => {
      const sessionId = 'context-test-2';
      bridge.sessionMeta.set(sessionId, { cwd: tmpDir, active: true, senderId: 'u1' });
      const cm = new ContextManager(tmpDir);
      cm.injectRules();

      // Another active session in the same workspace
      const otherBridge = new ClaudeBridge();
      otherBridge.sessionMeta.set('other-session', { cwd: tmpDir, active: true, senderId: 'u2' });

      const cleaned = cm.cleanOrphanedRules(otherBridge);
      expect(cleaned).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toContain('<!-- CC-BRIDGE-RULES:START -->');
    });
  });

  (hasGit ? describe : describe.skip)('full cc_start → cc_revert → cc_stop flow', () => {
    it('complete lifecycle with snapshot, context injection, and cleanup', () => {
      const sessionId = 'lifecycle-test-1';
      bridge.sessionMeta.set(sessionId, {
        cwd: tmpDir, active: true, stashRef: null, senderId: 'u1'
      });
      const cm = new ContextManager(tmpDir);

      // cc_start: inject rules + create snapshot
      cm.cleanOrphanedRules(bridge);
      cm.injectRules();

      // Verify context is injected (before snapshot, so CLAUDE.md is committed)
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toContain('<!-- CC-BRIDGE-RULES:START -->');

      // Commit CLAUDE.md so stash can track it properly
      execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "add CLAUDE.md"', { cwd: tmpDir, stdio: 'ignore' });

      // Create snapshot with a modification to a tracked file
      fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'initial state');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();

      // Verify snapshot exists
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      // Simulate CC work: modify tracked files
      fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'modified by CC');

      // cc_revert --confirm: roll back changes
      const revertResult = snapshot.revert();
      expect(revertResult.success).toBe(true);
      expect(bridge.sessionMeta.get(sessionId).stashRef).toBeNull();

      // cc_stop: cleanup context
      cm.cleanup();
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
    });

    it('cc_stop with stashRef drops the stash', () => {
      const sessionId = 'stop-test-1';
      bridge.sessionMeta.set(sessionId, {
        cwd: tmpDir, active: true, stashRef: null, senderId: 'u1'
      });

      fs.writeFileSync(path.join(tmpDir, 'temp.txt'), 'temp');
      const snapshot = new GitSnapshot(bridge, sessionId);
      snapshot.create();
      expect(bridge.sessionMeta.get(sessionId).stashRef).not.toBeNull();

      // cc_stop: drop stash
      const dropResult = snapshot.dropStash();
      expect(dropResult.success).toBe(true);

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      expect(stashList).not.toContain('CC-snapshot-');
    });
  });

  (hasGit ? describe : describe.skip)('cleanupOldStashes integration', () => {
    it('drops old inactive stashes but keeps active ones', () => {
      const activeSessionId = 'cc-1709000000-act1111';
      const inactiveSessionId = 'cc-1709000000-ina2222';

      bridge.sessionMeta.set(activeSessionId, { cwd: tmpDir, active: true, stashRef: null, senderId: 'u1' });

      // Create an active session stash
      fs.writeFileSync(path.join(tmpDir, 'active.txt'), 'active');
      const activeSnapshot = new GitSnapshot(bridge, activeSessionId);
      activeSnapshot.create();

      // Create an old inactive stash manually
      const oldTimestamp = Date.now() - 8 * 24 * 3600000;
      const oldStashRef = `CC-snapshot-${inactiveSessionId}-${oldTimestamp}`;
      fs.writeFileSync(path.join(tmpDir, 'old.txt'), 'old');
      execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
      execSync(`git stash push -u -m "${oldStashRef}"`, { cwd: tmpDir, stdio: 'ignore' });

      // Register the inactive session
      bridge.sessionMeta.set(inactiveSessionId, { cwd: tmpDir, active: false, stashRef: oldStashRef, senderId: 'u2' });

      GitSnapshot.cleanupOldStashes(bridge, tmpDir);

      const stashList = execSync('git stash list', { cwd: tmpDir }).toString();
      // Active session's stash should be preserved
      expect(stashList).toContain('act1111');
      // Old inactive stash should be dropped
      expect(stashList).not.toContain('ina2222');
    });
  });

  (hasGit ? describe : describe.skip)('buildContextPrompt integration', () => {
    it('returns branch info and recent files for a git repo', () => {
      const cm = new ContextManager(tmpDir);
      const context = cm.buildContextPrompt(tmpDir);
      expect(context).toContain('当前分支:');
    });

    it('handles non-git directory gracefully', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-nongit-'));
      const cm = new ContextManager(nonGitDir);
      const context = cm.buildContextPrompt(nonGitDir);
      // Should not crash, may return empty or partial
      expect(typeof context).toBe('string');
      try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
    });
  });
});
