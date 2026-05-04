// Tests for hook-inbox.js — hook config writing, OS-aware script selection, matcher update, config merge

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

    it('does not include CLAUDE_SESSION_ID literal in env', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(config.env.CLAUDE_SESSION_ID).toBeUndefined();
    });

    it('stores hookConfigPath after write', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      expect(hookInbox.hookConfigPath).toBe(outputPath);
    });

    it('selects .mjs script on Windows platform', () => {
      const originalPlatform = process.platform;
      const outputPath = path.join(tmpDir, 'hook-config.json');
      hookInbox.writeHookConfig(outputPath, 7890);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const command = config.hooks.PreToolUse[0].hooks[0].command;
      if (originalPlatform === 'win32') {
        expect(command).toContain('.mjs');
      } else {
        expect(command).toContain('.sh');
      }
    });

    it('merges with existing config instead of overwriting', () => {
      const outputPath = path.join(tmpDir, 'hook-config.json');

      // Write an existing config with custom settings
      const existingConfig = {
        permissions: {
          allow: ['Bash(git *)']
        },
        hooks: {
          PostToolUse: [{
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'formatter' }]
          }]
        },
        env: {
          MY_VAR: 'my_value'
        }
      };
      fs.writeFileSync(outputPath, JSON.stringify(existingConfig, null, 2));

      hookInbox.writeHookConfig(outputPath, 7890);
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

      // Existing settings should be preserved
      expect(config.permissions).toBeDefined();
      expect(config.permissions.allow).toContain('Bash(git *)');
      expect(config.hooks.PostToolUse).toBeDefined();
      expect(config.env.MY_VAR).toBe('my_value');

      // New settings should be added
      expect(config.hooks.PreToolUse).toBeDefined();
      expect(config.hooks.PreToolUse[0].matcher).toBe('Bash');
      expect(config.env.CC_BRIDGE_URL).toBe('http://127.0.0.1:7890');
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
