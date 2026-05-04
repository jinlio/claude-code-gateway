// Unit tests for CommandParser
// See: cc-bridge-v3-final-plan.md Section 7.1

const { CommandParser, COMMANDS } = require('../../src/core/command-parser');

describe('CommandParser', () => {
  let parser;

  beforeEach(() => {
    parser = new CommandParser();
  });

  describe('parse', () => {
    test('parses /cc_start command without args', () => {
      const result = parser.parse('/cc_start');
      expect(result).toEqual({ command: 'cc_start', args: '', unknown: false });
    });

    test('parses /cc_stop command', () => {
      const result = parser.parse('/cc_stop');
      expect(result).toEqual({ command: 'cc_stop', args: '', unknown: false });
    });

    test('parses /cc_status command', () => {
      const result = parser.parse('/cc_status');
      expect(result).toEqual({ command: 'cc_status', args: '', unknown: false });
    });

    test('parses /cc_answer with args', () => {
      const result = parser.parse('/cc_answer this is my answer');
      expect(result).toEqual({ command: 'cc_answer', args: 'this is my answer', unknown: false });
    });

    test('parses /cc_approve with id', () => {
      const result = parser.parse('/cc_approve abcd1234');
      expect(result).toEqual({ command: 'cc_approve', args: 'abcd1234', unknown: false });
    });

    test('parses /cc_deny with id', () => {
      const result = parser.parse('/cc_deny efgh5678');
      expect(result).toEqual({ command: 'cc_deny', args: 'efgh5678', unknown: false });
    });

    test('parses /cc_revert --confirm', () => {
      const result = parser.parse('/cc_revert --confirm');
      expect(result).toEqual({ command: 'cc_revert', args: '--confirm', unknown: false });
    });

    test('parses /cc_context command', () => {
      const result = parser.parse('/cc_context');
      expect(result).toEqual({ command: 'cc_context', args: '', unknown: false });
    });

    test('parses /cc_mode efficient', () => {
      const result = parser.parse('/cc_mode efficient');
      expect(result).toEqual({ command: 'cc_mode', args: 'efficient', unknown: false });
    });

    test('parses /cc_mode strict', () => {
      const result = parser.parse('/cc_mode strict');
      expect(result).toEqual({ command: 'cc_mode', args: 'strict', unknown: false });
    });

    test('parses /cc with prompt', () => {
      const result = parser.parse('/cc fix the bug in auth module');
      expect(result).toEqual({ command: 'cc', args: 'fix the bug in auth module', unknown: false });
    });

    test('parses /cc without prompt', () => {
      const result = parser.parse('/cc');
      expect(result).toEqual({ command: 'cc', args: '', unknown: false });
    });

    test('returns null for non-command text', () => {
      const result = parser.parse('hello world');
      expect(result).toBeNull();
    });

    test('returns null for empty string', () => {
      const result = parser.parse('');
      expect(result).toBeNull();
    });

    test('returns null for null input', () => {
      const result = parser.parse(null);
      expect(result).toBeNull();
    });

    test('returns null for undefined input', () => {
      const result = parser.parse(undefined);
      expect(result).toBeNull();
    });

    test('marks unknown command', () => {
      const result = parser.parse('/unknown_cmd test');
      expect(result).toEqual({ command: null, args: '/unknown_cmd test', unknown: true });
    });

    test('handles command with extra whitespace', () => {
      const result = parser.parse('/cc_answer   my answer here');
      expect(result.command).toBe('cc_answer');
      expect(result.args).toBe('my answer here');
    });

    test('handles command with leading/trailing whitespace', () => {
      const result = parser.parse('  /cc_start  ');
      expect(result).toEqual({ command: 'cc_start', args: '', unknown: false });
    });
  });

  describe('getCommands', () => {
    test('returns all 10 commands', () => {
      const commands = parser.getCommands();
      expect(commands).toHaveLength(10);
      expect(commands).toContain('cc');
      expect(commands).toContain('cc_start');
      expect(commands).toContain('cc_stop');
      expect(commands).toContain('cc_status');
      expect(commands).toContain('cc_answer');
      expect(commands).toContain('cc_approve');
      expect(commands).toContain('cc_deny');
      expect(commands).toContain('cc_revert');
      expect(commands).toContain('cc_context');
      expect(commands).toContain('cc_mode');
    });

    test('returns a copy (not the original array)', () => {
      const commands1 = parser.getCommands();
      const commands2 = parser.getCommands();
      expect(commands1).not.toBe(commands2);
      expect(commands1).toEqual(commands2);
    });
  });

  describe('getHelpText', () => {
    test('includes all command names', () => {
      const help = parser.getHelpText();
      for (const cmd of COMMANDS) {
        expect(help).toContain(`/${cmd}`);
      }
    });

    test('starts with header', () => {
      const help = parser.getHelpText();
      expect(help).toContain('CC Bridge 命令列表');
    });
  });

  describe('COMMANDS constant', () => {
    test('exports correct command list', () => {
      expect(COMMANDS).toEqual([
        'cc', 'cc_start', 'cc_stop', 'cc_status',
        'cc_answer', 'cc_approve', 'cc_deny',
        'cc_revert', 'cc_context', 'cc_mode'
      ]);
    });
  });
});
