// Unit tests for FeishuMessenger
// See: cc-bridge-v3-final-plan.md Section 7.2, 7.3

const { FeishuMessenger, MAX_MESSAGE_LENGTH } = require('../../src/core/feishu-messenger');

describe('FeishuMessenger', () => {
  let messenger;
  let sentMessages;
  let mockSendText;

  beforeEach(() => {
    sentMessages = [];
    mockSendText = jest.fn().mockImplementation(async (ctx) => {
      sentMessages.push({ to: ctx.to, text: ctx.text, accountId: ctx.accountId });
    });
    const api = {
      config: {},
      runtime: {
        channel: {
          outbound: {
            loadAdapter: jest.fn().mockResolvedValue({ sendText: mockSendText })
          }
        }
      }
    };
    messenger = new FeishuMessenger(api, { maxMessageLength: 100 });
  });

  describe('sendToUser', () => {
    test('sends short message in one chunk', async () => {
      const count = await messenger.sendToUser('user1', 'hello');
      expect(count).toBe(1);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({ to: 'user1', text: 'hello', accountId: undefined });
    });

    test('sends empty message', async () => {
      const count = await messenger.sendToUser('user1', '');
      expect(count).toBe(1);
      expect(sentMessages[0].text).toBe('');
    });

    test('sends null message as empty string', async () => {
      const count = await messenger.sendToUser('user1', null);
      expect(count).toBe(1);
      expect(sentMessages[0].text).toBe('');
    });

    test('splits long message into multiple chunks', async () => {
      const longText = 'a'.repeat(250);
      const count = await messenger.sendToUser('user1', longText);
      expect(count).toBe(3);
      expect(sentMessages).toHaveLength(3);
    });

    test('passes channelId and accountId options', async () => {
      await messenger.sendToUser('user1', 'hello', { channelId: 'feishu', accountId: 'acct1' });
      expect(sentMessages[0].accountId).toBe('acct1');
    });
  });

  describe('splitMessage', () => {
    test('returns single chunk for short text', () => {
      const chunks = messenger.splitMessage('short');
      expect(chunks).toEqual(['short']);
    });

    test('splits at newline boundaries when possible', () => {
      const line1 = 'x'.repeat(80);
      const line2 = 'y'.repeat(80);
      const text = `${line1}\n${line2}`;
      const chunks = messenger.splitMessage(text);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test('preserves code block boundaries', () => {
      const code = '```js\nconst x = 1;\n```';
      const padding = 'a'.repeat(80) + '\n';
      const text = padding + code;
      const chunks = messenger.splitMessage(text);
      // Code block should not be split across chunks
      const rejoined = chunks.join('');
      expect(rejoined).toBe(text);
    });

    test('handles text exactly at max length', () => {
      const text = 'a'.repeat(100);
      const chunks = messenger.splitMessage(text);
      expect(chunks).toEqual([text]);
    });

    test('handles text just over max length', () => {
      const text = 'a'.repeat(101);
      const chunks = messenger.splitMessage(text);
      expect(chunks.length).toBe(2);
    });

    test('hard splits when no newline found in search range', () => {
      const text = 'a'.repeat(300);
      const chunks = messenger.splitMessage(text);
      expect(chunks.length).toBe(3);
      const rejoined = chunks.join('');
      expect(rejoined).toBe(text);
    });
  });

  describe('formatCodeBlock', () => {
    test('formats code block with language', () => {
      const result = messenger.formatCodeBlock('const x = 1;', 'js');
      expect(result).toBe('```js\nconst x = 1;\n```');
    });

    test('formats code block without language', () => {
      const result = messenger.formatCodeBlock('echo hello', '');
      expect(result).toBe('```\necho hello\n```');
    });
  });

  describe('formatApprovalNotification', () => {
    test('formats complete notification', () => {
      const result = messenger.formatApprovalNotification(
        'abcd1234-5678-90ef-ghij-klmnopqrstuv',
        'Bash',
        'rm -rf /tmp/test',
        '/home/user/project'
      );
      expect(result).toContain('审批请求 #abcd1234');
      expect(result).toContain('工具: Bash');
      expect(result).toContain('内容: rm -rf /tmp/test');
      expect(result).toContain('目录: /home/user/project');
      expect(result).toContain('/cc_approve abcd1234');
      expect(result).toContain('/cc_deny abcd1234');
    });
  });

  describe('formatToolProgress', () => {
    test('formats success status', () => {
      const result = messenger.formatToolProgress('Read', 'success');
      expect(result).toContain('✓');
      expect(result).toContain('Read');
      expect(result).toContain('成功');
    });

    test('formats error status with detail', () => {
      const result = messenger.formatToolProgress('Bash', 'error', 'Command not found');
      expect(result).toContain('✗');
      expect(result).toContain('失败: Command not found');
    });

    test('formats in-progress status', () => {
      const result = messenger.formatToolProgress('Write', 'running', 'file.js');
      expect(result).toContain('→');
      expect(result).toContain('file.js');
    });

    test('truncates long error detail', () => {
      const longDetail = 'x'.repeat(200);
      const result = messenger.formatToolProgress('Bash', 'error', longDetail);
      expect(result.length).toBeLessThan(longDetail.length + 20);
    });
  });

  describe('formatErrorMessage', () => {
    test('formats string error', () => {
      const result = messenger.formatErrorMessage('Something went wrong');
      expect(result).toBe('错误: Something went wrong');
    });

    test('formats Error object', () => {
      const result = messenger.formatErrorMessage(new Error('test error'));
      expect(result).toBe('错误: test error');
    });

    test('formats null error', () => {
      const result = messenger.formatErrorMessage(null);
      expect(result).toBe('错误: 未知错误');
    });

    test('truncates long error message', () => {
      const longMsg = 'x'.repeat(600);
      const result = messenger.formatErrorMessage(longMsg);
      expect(result.length).toBeLessThan(longMsg.length);
    });
  });

  describe('formatSessionStatus', () => {
    test('formats active session', () => {
      const meta = {
        cwd: '/home/user/project',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 5
      };
      const proc = { exitCode: null };
      const result = messenger.formatSessionStatus(meta, proc, 'cc-1234567890-abcdef');
      expect(result).toContain('/home/user/project');
      expect(result).toContain('cc-12345');
      expect(result).toContain('存活');
      expect(result).toContain('5');
    });

    test('formats exited session', () => {
      const meta = {
        cwd: '/project',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0
      };
      const proc = { exitCode: 1 };
      const result = messenger.formatSessionStatus(meta, proc, 'cc-test');
      expect(result).toContain('已退出');
    });
  });

  describe('countCodeBlockMarkers', () => {
    test('counts zero markers', () => {
      expect(messenger.countCodeBlockMarkers('hello world')).toBe(0);
    });

    test('counts one opening marker', () => {
      expect(messenger.countCodeBlockMarkers('```js\ncode')).toBe(1);
    });

    test('counts paired markers', () => {
      expect(messenger.countCodeBlockMarkers('```js\ncode\n```')).toBe(2);
    });
  });
});
