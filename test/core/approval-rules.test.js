// Tests for approval-rules.js — YAML loading, regex safety, rule matching

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { ApprovalRules, hasNestedQuantifiers, hasBackReference } = require('../../src/core/approval-rules');

describe('hasNestedQuantifiers', () => {
  it('detects nested quantifiers', () => {
    expect(hasNestedQuantifiers('(a+)+')).toBe(true);
    expect(hasNestedQuantifiers('(a*)*')).toBe(true);
    expect(hasNestedQuantifiers('(a{1,2}){3,4}')).toBe(true);
  });

  it('passes for non-nested patterns', () => {
    expect(hasNestedQuantifiers('^rm\\s+-rf')).toBe(false);
    expect(hasNestedQuantifiers('^sudo')).toBe(false);
    expect(hasNestedQuantifiers('^git')).toBe(false);
    expect(hasNestedQuantifiers('^npm test$')).toBe(false);
  });
});

describe('hasBackReference', () => {
  it('detects back references', () => {
    expect(hasBackReference('(a)\\1')).toBe(true);
    expect(hasBackReference('\\2')).toBe(true);
  });

  it('passes for patterns without back references', () => {
    expect(hasBackReference('^rm\\s+-rf')).toBe(false);
    expect(hasBackReference('^npm test$')).toBe(false);
  });
});

describe('ApprovalRules', () => {
  let tmpDir;
  let rulesPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-rules-'));
    rulesPath = path.join(tmpDir, 'rules.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRules(rules) {
    fs.writeFileSync(rulesPath, yaml.dump({ rules }));
  }

  describe('loadRules', () => {
    it('loads valid YAML rules', () => {
      writeRules([
        { tool: 'Write', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^npm test$', action: 'auto_approve' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.rules.length).toBe(2);
    });

    it('throws on regex too long (>100 chars)', () => {
      writeRules([
        { tool: 'Bash', command_pattern: 'a' + 'b'.repeat(101), action: 'auto_approve' }
      ]);
      expect(() => new ApprovalRules(rulesPath)).toThrow(/too long/);
    });

    it('throws on nested quantifiers', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '(a+)+', action: 'auto_approve' }
      ]);
      expect(() => new ApprovalRules(rulesPath)).toThrow(/nested quantifiers/);
    });

    it('throws on back references', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '(a)\\1', action: 'auto_approve' }
      ]);
      expect(() => new ApprovalRules(rulesPath)).toThrow(/back reference/);
    });

    it('throws on regex compilation failure', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '[invalid(', action: 'auto_approve' }
      ]);
      expect(() => new ApprovalRules(rulesPath)).toThrow(/compilation failed/);
    });

    it('accepts valid command patterns', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '^rm\\s+-rf\\s+.*', action: 'require_approval', sensitive: true },
        { tool: 'Bash', command_pattern: '^git status$', action: 'auto_approve' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.rules.length).toBe(2);
    });
  });

  describe('match', () => {
    it('matches auto_approve for Write tool', () => {
      writeRules([
        { tool: 'Write', action: 'auto_approve' },
        { tool: '*', action: 'require_approval' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Write')).toEqual({ action: 'auto_approve', sensitive: false });
    });

    it('matches require_approval for unknown tool via wildcard', () => {
      writeRules([
        { tool: 'Write', action: 'auto_approve' },
        { tool: '*', action: 'require_approval' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('UnknownTool')).toEqual({ action: 'require_approval', sensitive: false });
    });

    it('matches Bash by command pattern', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '^npm test$', action: 'auto_approve' },
        { tool: 'Bash', command_pattern: '^rm\\s+-rf', action: 'require_approval', sensitive: true },
        { tool: '*', action: 'require_approval' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Bash', { command: 'npm test' })).toEqual({ action: 'auto_approve', sensitive: false });
      expect(rules.match('Bash', { command: 'rm -rf /tmp' })).toEqual({ action: 'require_approval', sensitive: true });
    });

    it('skips rule when command_pattern does not match command', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '^npm test$', action: 'auto_approve' },
        { tool: '*', action: 'require_approval' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Bash', { command: 'npm run build' })).toEqual({ action: 'require_approval', sensitive: false });
    });

    it('matches by path_pattern using minimatch', () => {
      writeRules([
        { tool: 'Write', path_pattern: 'src/**/*.md', action: 'auto_approve' },
        { tool: '*', action: 'require_approval' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Write', { filePath: 'src/core/README.md' })).toEqual({ action: 'auto_approve', sensitive: false });
      expect(rules.match('Write', { filePath: 'src/core/app.js' })).toEqual({ action: 'require_approval', sensitive: false });
    });

    it('returns require_approval as default when no rule matches', () => {
      writeRules([
        { tool: 'Write', action: 'auto_approve' }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Bash', { command: 'anything' })).toEqual({ action: 'require_approval', sensitive: false });
    });

    it('returns sensitive flag when rule has it', () => {
      writeRules([
        { tool: 'Bash', command_pattern: '^sudo', action: 'require_approval', sensitive: true }
      ]);
      const rules = new ApprovalRules(rulesPath);
      expect(rules.match('Bash', { command: 'sudo rm' })).toEqual({ action: 'require_approval', sensitive: true });
    });
  });
});