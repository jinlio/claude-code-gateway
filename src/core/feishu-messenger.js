// FeishuMessenger — bidirectional message forwarding with formatting
// See: cc-bridge-v3-final-plan.md Section 7.2, 7.3

const MAX_MESSAGE_LENGTH = 4000;
const CODE_BLOCK_MARKER = '```';

class FeishuMessenger {
  constructor(api, options = {}) {
    this.api = api;
    this.maxMessageLength = options.maxMessageLength || MAX_MESSAGE_LENGTH;
  }

  sendToUser(target, text) {
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      this.api.sendMessage({
        channel: 'feishu',
        target,
        text: chunk
      });
    }
    return chunks.length;
  }

  formatCodeBlock(code, language = '') {
    const marker = CODE_BLOCK_MARKER;
    return `${marker}${language}\n${code}\n${marker}`;
  }

  formatApprovalNotification(approvalId, toolName, inputPreview, cwd) {
    const shortId = approvalId.slice(0, 8);
    return [
      `审批请求 #${shortId}`,
      `工具: ${toolName}`,
      `内容: ${inputPreview}`,
      `目录: ${cwd}`,
      '',
      `批准: /cc_approve ${shortId}`,
      `拒绝: /cc_deny ${shortId}`
    ].join('\n');
  }

  formatToolProgress(toolName, status, detail = '') {
    const icon = status === 'success' ? '✓' : status === 'error' ? '✗' : '→';
    const summary = status === 'error'
      ? `失败: ${detail.slice(0, 80) || '未知错误'}`
      : status === 'success'
        ? '成功'
        : detail;
    return `${icon} ${toolName}: ${summary}`;
  }

  formatErrorMessage(error) {
    const msg = typeof error === 'string' ? error : error?.message || '未知错误';
    return `错误: ${msg.slice(0, 500)}`;
  }

  formatSessionStatus(meta, proc, sessionId) {
    const runtime = Math.round(
      (Date.now() - new Date(meta.startedAt).getTime()) / 60000
    );
    const lastActive = Math.round(
      (Date.now() - new Date(meta.lastActiveAt).getTime()) / 60000
    );
    return [
      '持久会话状态',
      `工作目录: ${meta.cwd}`,
      `会话ID: ${sessionId.slice(0, 8)}`,
      `运行时长: ${runtime} 分钟`,
      `消息数: ${meta.messageCount}`,
      `最后活动: ${lastActive} 分钟前`,
      `进程状态: ${proc?.exitCode === null ? '存活' : '已退出'}`
    ].join('\n');
  }

  splitMessage(text) {
    if (!text || text.length <= this.maxMessageLength) {
      return [text || ''];
    }

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= this.maxMessageLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = this.findSplitPoint(remaining, this.maxMessageLength);

      // Preserve code blocks across splits
      const beforeSplit = remaining.slice(0, splitAt);
      const codeBlockCount = this.countCodeBlockMarkers(beforeSplit);
      if (codeBlockCount % 2 !== 0) {
        const lastMarker = beforeSplit.lastIndexOf(CODE_BLOCK_MARKER);
        if (lastMarker > 0) {
          splitAt = lastMarker;
        }
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    return chunks;
  }

  findSplitPoint(text, maxLength) {
    const searchStart = Math.max(0, maxLength - 200);
    const searchEnd = Math.min(text.length, maxLength);

    for (let i = searchEnd; i >= searchStart; i--) {
      if (text[i] === '\n') return i + 1;
    }

    return maxLength;
  }

  countCodeBlockMarkers(text) {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(CODE_BLOCK_MARKER, pos)) !== -1) {
      count++;
      pos += CODE_BLOCK_MARKER.length;
    }
    return count;
  }
}

module.exports = { FeishuMessenger, MAX_MESSAGE_LENGTH };
