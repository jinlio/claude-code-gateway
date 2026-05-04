// Tests for hook-inbox.js — hook config writing, OS-aware script selection, matcher update

const fs = require('fs');
const path = require('path');
const os = require('os');
const { HookInbox } = require('../../src/core/hook-inbox');

describe('HookInbox', () => {
  let tmpDir;
  let hookInbox;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-hook-'));
    hookInbox = new HookInbox();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeHookConfig', () => {
    it('writes valid JSON config file', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      expect(fs.existsSync(outputPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.hooks).toBeDefined();
      expect(config.hooks.PreToolUse).toBeDefined();
    });

    it('uses Bash matcher by default (efficient mode)', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.hooks.PreToolUse[0].matcher).toBe('Bash');
    });

    it('uses custom matcher when provided (strict mode)', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890, 'Bash|Write|Edit');
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit');
    });

    it('includes bridge URL env var with correct port', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 9999);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.env.CC_BRIDGE_URL).toBe('http://127.0.0.1:9999');
    });

    it('stores hookConfigPath after write', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      expect(hookInbox.hookConfigPath).toBe(outputPath);
    });

    it('selects .mjs script on Windows platform', () => {
      const originalPlatform = process.platform;
      // We can't easily change process.platform, but we can verify the logic
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const command = config.hooks.PreToolUse[0].hooks[0].command;
      // On Windows, command should contain .mjs; on other platforms, .sh
      if (originalPlatform === 'win32') {
        expect(command).toContain('.mjs');
      } else {
        expect(command).toContain('.sh');
      }
    });
  });

  describe('updateMatcher', () => {
    it('updates matcher in existing config file', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);

      hookInbox.updateMatcher('Bash|Write|Edit');
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit');
    });

    it('does nothing when hookConfigPath is not set', () => {
      hookInbox.updateMatcher('Bash|Write|Edit');
      // No crash, no side effect
    });
  });
});