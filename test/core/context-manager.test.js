// Tests for context-manager.js — CLAUDE.md injection, orphaned rules cleanup, removeInjectedRules, buildContextPrompt

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ContextManager } = require('../../src/core/context-manager');
const { ClaudeBridge } = require('../../src/core/claude-bridge');

// Mock execSync for buildContextPrompt tests
jest.mock('child_process', () => ({
  execSync: jest.fn().mockImplementation((cmd) => {
    if (cmd.includes('git branch')) return 'main\n';
    if (cmd.includes('git diff')) return 'src/file1.js\nsrc/file2.js\n';
    if (cmd.includes('ls -la') || cmd.includes('dir /b')) return 'file1\nfile2\n';
    throw new Error('unknown command');
  })
}));

describe('ContextManager', () => {
  let tmpDir;
  let cm;
  let claudeMdPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-context-'));
    claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    // Create a minimal CLAUDE.md
    fs.writeFileSync(claudeMdPath, '# Project Rules\n\nSome existing rules.');
    cm = new ContextManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('injectRules', () => {
    it('appends rules section with markers to CLAUDE.md', () => {
      cm.injectRules();
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      expect(content).toContain('<!-- CC-BRIDGE-RULES:START -->');
      expect(content).toContain('<!-- CC-BRIDGE-RULES:END -->');
    });

    it('does not duplicate rules if injectRules called twice', () => {
      cm.injectRules();
      cm.injectRules();
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      const startCount = content.split('<!-- CC-BRIDGE-RULES:START -->').length - 1;
      expect(startCount).toBe(1);
    });

    it('creates CLAUDE.md if it does not exist', () => {
      fs.rmSync(claudeMdPath);
      cm.injectRules();
      expect(fs.existsSync(claudeMdPath)).toBe(true);
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      expect(content).toContain('<!-- CC-BRIDGE-RULES:START -->');
    });
  });

  describe('removeInjectedRules', () => {
    it('removes injected rules section from content', () => {
      cm.injectRules();
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      const cleaned = cm.removeInjectedRules(content);
      expect(cleaned).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
      expect(cleaned).toContain('# Project Rules');
    });

    it('returns content unchanged when no markers present', () => {
      const original = '# No markers here';
      expect(cm.removeInjectedRules(original)).toBe(original.trim());
    });
  });

  describe('cleanup', () => {
    it('removes injected rules from CLAUDE.md', () => {
      cm.injectRules();
      cm.cleanup();
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      expect(content).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
      expect(content).toContain('# Project Rules');
    });

    it('does nothing if CLAUDE.md does not exist', () => {
      fs.rmSync(claudeMdPath);
      cm.cleanup();
      // No crash
    });
  });

  describe('cleanOrphanedRules', () => {
    it('removes orphaned rules when no active session exists', () => {
      cm.injectRules();
      const bridge = new ClaudeBridge();
      const result = cm.cleanOrphanedRules(bridge);
      expect(result).toBe(true);
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      expect(content).not.toContain('<!-- CC-BRIDGE-RULES:START -->');
    });

    it('preserves rules when an active session exists in the workspace', () => {
      cm.injectRules();
      const bridge = new ClaudeBridge();
      bridge.sessionMeta.set('s1', { senderId: 'u1', cwd: tmpDir, active: true });
      const result = cm.cleanOrphanedRules(bridge);
      expect(result).toBe(false);
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      expect(content).toContain('<!-- CC-BRIDGE-RULES:START -->');
    });

    it('returns false when no markers exist', () => {
      const bridge = new ClaudeBridge();
      expect(cm.cleanOrphanedRules(bridge)).toBe(false);
    });

    it('returns false when CLAUDE.md does not exist', () => {
      fs.rmSync(claudeMdPath);
      const bridge = new ClaudeBridge();
      expect(cm.cleanOrphanedRules(bridge)).toBe(false);
    });
  });

  describe('buildContextPrompt', () => {
    it('builds context with branch, recent files, and listing', () => {
      const prompt = cm.buildContextPrompt(tmpDir);
      expect(prompt).toContain('当前分支:');
      expect(prompt).toContain('最近修改的文件:');
      expect(prompt).toContain('工作目录内容:');
    });

    it('returns partial context when some commands fail', () => {
      const { execSync } = require('child_process');
      execSync.mockImplementation(() => { throw new Error('fail'); });
      const prompt = cm.buildContextPrompt(tmpDir);
      expect(prompt).toBe('');
    });

    it('uses platform-appropriate directory listing command', () => {
      const { execSync } = require('child_process');
      execSync.mockClear();
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('git branch')) return 'main\n';
        if (cmd.includes('git diff')) return 'src/file.js\n';
        if (cmd.includes('ls -la') || cmd.includes('dir /b')) return 'file1\n';
        throw new Error('unknown');
      });

      cm.buildContextPrompt(tmpDir);

      const listingCmd = process.platform === 'win32' ? 'dir /b' : 'ls -la';
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining(listingCmd),
        expect.any(Object)
      );
    });
  });
});