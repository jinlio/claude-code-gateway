# CC Gateway Command Reference

Both OpenClaw and Hermes plugins must implement these 10 commands with identical behavior.

## Commands

### /cc <prompt>
- **Description**: Send a one-shot task to Claude Code, or send input to an existing persistent session
- **Arguments**: Required — the task description
- **Authorization**: None (any user can submit)
- **Behavior**:
  - If user has an active persistent session: write prompt to stdin, update activity
  - If no active session: spawn new one-shot session (`claude --print <prompt>`), forward output
- **Response**: `任务已提交 (ID: <8-char-session-id>)` or `已发送到持久会话。`

### /cc_start
- **Description**: Start a persistent Claude Code session
- **Arguments**: None
- **Authorization**: None (any user can start)
- **Behavior**:
  - If user already has an active session: return session status
  - Otherwise: spawn persistent session (no --print flag), activate in session manager, inject CLAUDE.md rules, create git snapshot, write hook config
- **Response**: `持久会话已启动 (ID: <8-char-id>)\n模式: <mode>\n审批服务端口: <port>\n快照: <created|未创建>`
- **Mode-specific**: In efficient mode, hook matcher = "Bash"; in strict mode, matcher = "Bash|Write|Edit"

### /cc_stop
- **Description**: Stop the active persistent session
- **Arguments**: None
- **Authorization**: Only the session creator (senderId must match)
- **Behavior**: Terminate process, deactivate session, drop git stash, cleanup CLAUDE.md rules, cleanup old stashes
- **Response**: `会话已停止 (ID: <8-char-id>)\n运行时长: <minutes> 分钟\n消息数: <count>`
- **Authorization failure**: `无权停止该会话，只有会话创建者可以停止。`

### /cc_status
- **Description**: View active session status
- **Arguments**: None
- **Authorization**: None (shows own session)
- **Behavior**: Find active session for sender, format status
- **Response format**:
  ```
  持久会话状态
  工作目录: <cwd>
  会话ID: <8-char-id>
  运行时长: <minutes> 分钟
  消息数: <count>
  最后活动: <minutes> 分钟前
  进程状态: 存活|已退出
  ```
- **No session**: `当前没有活跃的持久会话。`

### /cc_answer <text>
- **Description**: Answer a question from Claude Code
- **Arguments**: Required — the answer text
- **Authorization**: None (answers to own session)
- **Behavior**: Write answer text to session process stdin + newline
- **Response**: `已发送回答。` or `会话进程已退出，无法回答。`

### /cc_approve <id>
- **Description**: Approve a pending approval request
- **Arguments**: Required — short approval ID (8+ chars of UUID)
- **Authorization**: Only the session creator (senderId must match)
- **Behavior**: Find approval by short ID prefix match, resolve as APPROVED
- **Ambiguous ID**: `ID "<id>" 匹配到多个请求，请使用更长的ID。\n匹配: <ids>`
- **Already resolved**: `该请求已处理: <status>`
- **Authorization failure**: `无权审批该请求，只有会话创建者可以操作。`
- **Response**: `已批准 #<shortId>: <toolName>`

### /cc_deny <id>
- **Description**: Deny a pending approval request
- **Arguments**: Required — short approval ID
- **Authorization**: Only the session creator
- **Behavior**: Same as cc_approve but resolve as DENIED
- **Response**: `已拒绝 #<shortId>: <toolName>`

### /cc_revert
- **Description**: Rollback code changes to pre-task state (requires --confirm)
- **Arguments**: None (shows confirmation), `--confirm` (executes), `--cancel` (cancels)
- **Authorization**: None (reverts own session)
- **Behavior**:
  - Without --confirm: show confirmation prompt
  - With --confirm: revert to git stash snapshot (stash apply, not stash pop)
  - With --cancel: cancel the revert
- **No stash**: `无可用的快照，无法回滚。（可能已回滚过或启动时未创建快照）`
- **Success**: `已回滚到任务前状态。`
- **Failure**: `回滚失败: <message>`
- **Confirmation prompt**: `确认回滚？\n将恢复到上次 CC 任务前的状态。\n\n确认: /cc_revert --confirm\n取消: /cc_revert --cancel`

### /cc_context
- **Description**: View project context information
- **Arguments**: None
- **Authorization**: Requires active session
- **Behavior**: Build context prompt (git branch, recent files, directory listing)
- **Response**: `当前项目上下文:\n\n<context info>`
- **No session**: `没有活跃会话。`

### /cc_mode [efficient|strict]
- **Description**: Switch approval mode
- **Arguments**: `efficient` or `strict` (optional — shows current mode if omitted)
- **Authorization**: None (changes global mode for the plugin)
- **Behavior**: Update approval server mode, update hook config matcher
- **efficient**: Hook matcher = "Bash", auto-approve Write/Edit
- **strict**: Hook matcher = "Bash|Write|Edit", all operations require approval
- **Invalid mode**: Shows current mode + usage
- **Response**: `已切换到 <mode> 模式。`

## Approval Notification Format

When an approval request is created, the messenger sends this format to the session owner:

```
审批请求 #<8-char-id>
工具: <toolName>
内容: <inputPreview>
目录: <cwd>

批准: /cc_approve <8-char-id>
拒绝: /cc_deny <8-char-id>
```

## Session ID Format

`cc-{timestamp}-{random6}` where:
- `timestamp`: Unix epoch milliseconds (Date.now() / int(time.time() * 1000))
- `random6`: 6 random alphanumeric characters (base36 slice)

Example: `cc-1709123456789-a1b2c3`