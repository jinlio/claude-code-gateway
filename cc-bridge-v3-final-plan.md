# openclaw-cc-bridge v3.0 增强开发计划（最终版）

> 修订日期：2026-05-04
> 基于 v3.0 原始方案，经三轮审查修订后定稿

---

## 修订历史

| 版本 | 修订内容 |
|------|----------|
| v3.0 原始 | 4 处代码错误修复 + 6 个设计加固 + 3 个增强优化 |
| 第一修订版 | HTTP 长连接→轮询、命令参数判断、exitCode 优先、stash apply、CLAUDE.md 分层、正则静态防御、时间调整 |
| 第二修订版 | 补 hook 脚本、审批持久化、stash message 定位、独立 bridge-rules.md、命名统一、审批卡片细节 |
| **最终版** | Hook 传递工具输入、飞书命令式审批、原子写入、CLAUDE.md 注入机制、Node hook 脚本、嵌套量词检测函数、stashRef 完整流程 |
| **最终版补丁** | 审批重启飞书摘要通知、CLAUDE.md 启动时残留清理、Stash 清理前会话状态验证 |
| **最终版补丁2** | 自动 Accept Edits 模式（Write/Edit 默认免审批，Bash 保留审批） |

---

## 一、代码错误修复（源自 v2.0）

### 1.1 `/cc_stop` 权限检查逻辑修复

```js
// v2.0 错误：== 匹配时反而提示无会话
if (!persistent?.active || persistent.senderId == ctx.senderId) {
  return { text: "当前没有持久会话。" };
}

// 修复：!== 匹配时才提示无会话
if (!persistent?.active || persistent.senderId !== ctx.senderId) {
  return { text: "当前没有持久会话。" };
}
```

### 1.2 `/cc_start` 运行时计算括号修复

```js
// v2.0 错误：缺少闭合括号导致 NaN
const runtime = Math.round((Date.now() - new Date(persistent.startedAt).getTime() / 60000);

// 修复：括号闭合
const runtime = Math.round((Date.now() - new Date(persistent.startedAt).getTime()) / 60000);
```

### 1.3 `/cc_answer` 拼写错误修复

```js
// v2.0 错误：ctx.sendId + 多余参数
const pq = sessions.getPendingQuestion(ctx.sendId, workspace, workspace);

// 修复：ctx.senderId + 去掉多余参数
const pq = sessions.getPendingQuestion(ctx.senderId, workspace);
```

### 1.4 补充 `/cc_status` 命令实现

```js
api.registerCommand({
  name: "cc_status",
  description: "查看会话状态",
  handler: async (ctx) => {
    const meta = bridge.sessionMeta.get(
      bridge.findActiveSession(ctx.senderId)
    );
    if (!meta) {
      return { text: "当前没有活跃的持久会话。" };
    }
    const proc = bridge.processMap.get(meta.sessionId);
    const runtime = Math.round(
      (Date.now() - new Date(meta.startedAt).getTime()) / 60000
    );
    const lastActive = Math.round(
      (Date.now() - new Date(meta.lastActiveAt).getTime()) / 60000
    );
    return {
      text: ` 持久会话状态
工作目录: ${meta.cwd}
会话ID: ${meta.sessionId?.slice(0, 8) || "(未创建)"}
运行时长: ${runtime} 分钟
消息数: ${meta.messageCount}
最后活动: ${lastActive} 分钟前
进程状态: ${proc?.exitCode === null ? " 存活" : " 已退出"}`
    };
  }
});
```

---

## 二、多实例进程管理

### 2.1 双 Map 架构

两个 Map 职责明确，不混用：

| Map | Key | Value | 用途 |
|-----|-----|-------|------|
| `processMap` | sessionId | ChildProcess | 进程存活检测、强制终止 |
| `sessionMeta` | sessionId | `{ cwd, startedAt, senderId, stashRef, messageCount, lastActiveAt }` | 业务逻辑、回滚定位、状态查询 |

```js
class ClaudeBridge {
  constructor() {
    this.processMap = new Map();  // sessionId → ChildProcess
    this.sessionMeta = new Map(); // sessionId → metadata object
  }

  findActiveSession(senderId) {
    for (const [sid, meta] of this.sessionMeta) {
      if (meta.senderId === senderId && meta.active) return sid;
    }
    return null;
  }
}
```

### 2.2 进程存活检测（exitCode 优先）

```js
checkSessionAlive(sessionId) {
  const proc = this.processMap.get(sessionId);
  if (!proc) {
    this.sessionMeta.delete(sessionId);
    return { alive: false };
  }

  // 优先用 exitCode（跨平台可靠）
  if (proc.exitCode !== null) {
    this.processMap.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    return { alive: false };
  }

  return { alive: true };
}
```

同时保留 `child.on('exit')` 监听做主动清理：

```js
child.on('exit', (code) => {
  if (sessionId) {
    this.processMap.delete(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.processAlive = false;
      meta.exitCode = code;
    }
  }
});
```

### 2.3 文件锁机制

使用 `proper-lockfile` 实现工作目录级别互斥：

```js
const lockfile = require('proper-lockfile');

async acquireWorkspaceLock(workspace) {
  return await lockfile.lock(workspace, {
    retries: { retries: 5, minTimeout: 100 }
  });
}

async releaseWorkspaceLock(release) {
  await release();
}
```

---

## 三、审批系统

### 3.1 两阶段轮询架构

**第一阶段：创建审批请求**

```
POST /api/approval/request
Body: { sessionId, toolName, toolInput, cwd, timestamp }
Response: { approvalId, status: "PENDING" }
```

立即返回，不阻塞连接。`toolInput` 包含完整的工具操作参数，供飞书展示。

**第二阶段：轮询状态**

```
GET /api/approval/status?id={approvalId}
间隔: 2 秒 | 最大次数: 150 次 | 总计: 5 分钟超时
Response: { approvalId, status: "PENDING"|"APPROVED"|"DENIED"|"TIMEOUT" }
```

### 3.2 完整 Hook 脚本 — Bash 版

```bash
#!/bin/bash
# cc-bridge approval hook (bash)
# Claude Code PreToolUse hook 调用此脚本
# 参数: $1=tool_name, $2=tool_input_json

BRIDGE_URL="${CC_BRIDGE_URL:-http://127.0.0.1:7890}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
TOOL_NAME="$1"
TOOL_INPUT="$2"
CWD="$(pwd)"
TIMESTAMP="$(date +%s)"

# 第一阶段：创建审批请求
RESPONSE=$(curl -s -f -X POST "${BRIDGE_URL}/api/approval/request" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"toolName\":\"${TOOL_NAME}\",\"toolInput\":\"${TOOL_INPUT}\",\"cwd\":\"${CWD}\",\"timestamp\":\"${TIMESTAMP}\"}" \
  --connect-timeout 5 --max-time 10 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "[cc-bridge] 审批服务不可达，默认放行" >&2
  exit 0
fi

APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.approvalId // empty')
if [ -z "$APPROVAL_ID" ]; then
  echo "[cc-bridge] 未获取审批ID，默认放行" >&2
  exit 0
fi

# 第二阶段：轮询审批状态
for i in $(seq 1 150); do
  sleep 2
  STATUS_RESPONSE=$(curl -s -f \
    "${BRIDGE_URL}/api/approval/status?id=${APPROVAL_ID}" \
    --connect-timeout 5 --max-time 5 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$STATUS_RESPONSE" ]; then
    sleep 2  # 连接失败，额外等待后重试
    continue
  fi

  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status // "UNKNOWN"')
  case "$STATUS" in
    APPROVED) exit 0;;
    DENIED)   exit 2;;
    TIMEOUT)  exit 3;;
  esac
done

exit 3  # 超时
```

### 3.3 完整 Hook 脚本 — Node 版（跨平台）

```js
// cc-bridge-approval-hook.mjs
// Claude Code PreToolUse hook 调用此脚本

const BRIDGE_URL = process.env.CC_BRIDGE_URL || 'http://127.0.0.1:7890';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'unknown';
const TOOL_NAME = process.argv[2] || 'unknown';
const TOOL_INPUT = process.argv[3] || '{}';
const CWD = process.cwd();

async function requestApproval() {
  // 第一阶段：创建审批请求
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/api/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        toolName: TOOL_NAME,
        toolInput: TOOL_INPUT,
        cwd: CWD,
        timestamp: Date.now()
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    // 服务不可达，默认放行
    process.exit(0);
  }

  const data = await res.json();
  if (!data.approvalId) {
    process.exit(0);  // 未获取审批ID，默认放行
  }

  // 第二阶段：轮询审批状态
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const statusRes = await fetch(
        `${BRIDGE_URL}/api/approval/status?id=${data.approvalId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      const statusData = await statusRes.json();

      switch (statusData.status) {
        case 'APPROVED': process.exit(0);
        case 'DENIED':   process.exit(2);
        case 'TIMEOUT':  process.exit(3);
      }
    } catch {
      // 连接失败，继续重试
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
  }

  process.exit(3);  // 超时
}

requestApproval();
```

### 3.4 ApprovalServer — 含原子持久化

```js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ApprovalServer {
  constructor(dataDir, port = 0, notifyCallback = null) {
    this.port = port;
    this.dataDir = dataDir;
    this.server = null;
    this.store = new ApprovalStore(dataDir);
    this.notifyCallback = notifyCallback;
  }

  async start() {
    // 加载持久化数据，获取被超时中断的数量
    const timedOutCount = this.store._loadTimedOutCount();
    if (timedOutCount > 0) {
      this.notifyTimedOutRequests(timedOutCount);
    }
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);

        if (req.method === 'POST' && url.pathname === '/api/approval/request') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            try {
              const params = JSON.parse(body);
              const id = this.store.create(params);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ approvalId: id, status: 'PENDING' }));
              // 通知飞书展示审批信息
              this.onApprovalNeeded?.(id, params);
            } catch (e) {
              res.writeHead(400);
              res.end(e.message);
            }
          });

        } else if (req.method === 'GET' && url.pathname === '/api/approval/status') {
          const id = url.searchParams.get('id');
          const item = this.store.get(id);
          if (!item) {
            res.writeHead(404);
            res.end('NOT FOUND');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              approvalId: id,
              status: item.status
            }));
          }

        } else if (req.method === 'POST' && url.pathname === '/api/approval/respond') {
          // 供飞书命令回调使用
          const id = url.searchParams.get('id');
          const action = url.searchParams.get('action'); // approve | deny
          const newStatus = action === 'approve' ? 'APPROVED' : 'DENIED';
          this.store.resolve(id, newStatus);
          res.writeHead(200);
          res.end('OK');

        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    this.store.markAllPendingAsTimeout();
    this.store.flush();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // 重启时通知用户有审批被超时中断
  notifyTimedOutRequests(timedOutCount) {
    if (timedOutCount > 0 && this.notifyCallback) {
      this.notifyCallback({
        type: 'restart_timeout',
        text: `⚠ 审批服务重启，有 ${timedOutCount} 条审批请求已超时中断。`
      });
    }
  }

  getPort() {
    return this.port;
  }
}
```

### 3.5 ApprovalStore — 原子持久化

```js
class ApprovalStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'approval-requests.json');
    this.requests = new Map();
    this._load();
  }

  _load() {
    this._timedOutOnLoad = 0;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const items = JSON.parse(raw);
        for (const item of items) {
          if (item.status === 'PENDING') {
            item.status = 'TIMEOUT';
            this._timedOutOnLoad++;
          }
          this.requests.set(item.id, item);
        }
      }
    } catch {
      // 文件损坏或不存在，从空开始
    }
  }

  // 返回本次加载中被超时中断的请求数量
  _loadTimedOutCount() {
    this._load();
    return this._timedOutOnLoad;
  }

  _flush() {
    // 原子写入：先写临时文件，再 rename
    const tmp = this.filePath + '.tmp';
    const data = JSON.stringify([...this.requests.values()], null, 2);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  create(params) {
    const id = crypto.randomUUID();
    this.requests.set(id, {
      id,
      sessionId: params.sessionId,
      toolName: params.toolName,
      toolInput: params.toolInput,
      cwd: params.cwd,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    });
    this._flush();
    return id;
  }

  get(id) {
    return this.requests.get(id);
  }

  resolve(id, status) {
    const item = this.requests.get(id);
    if (item) {
      item.status = status;
      item.resolvedAt = new Date().toISOString();
      this._flush();
    }
    return item;
  }

  markAllPendingAsTimeout() {
    for (const item of this.requests.values()) {
      if (item.status === 'PENDING') {
        item.status = 'TIMEOUT';
      }
    }
  }

  // 清理超过 1 小时的已决记录
  cleanup() {
    const cutoff = Date.now() - 3600000;
    for (const [id, item] of this.requests) {
      if (item.status !== 'PENDING' &&
          new Date(item.resolvedAt || item.createdAt).getTime() < cutoff) {
        this.requests.delete(id);
      }
    }
    this._flush();
  }
}
```

### 3.6 飞书审批 — 命令式交互

不使用卡片按钮回调（需要公网 HTTPS），改为**卡片展示信息 + 命令式审批**：

```js
// 审批请求到达时，发送飞书消息卡片（仅展示，无交互按钮）
onApprovalNeeded(id, params) {
  const inputPreview = formatToolInput(params.toolName, params.toolInput);
  api.sendMessage({
    channel: 'feishu',
    target: params.sessionId关联的senderId,
    text: ` 审批请求 #${id.slice(0, 8)}
工具: ${params.toolName}
内容: ${inputPreview}
目录: ${params.cwd}

批准: /cc_approve ${id.slice(0, 8)}
拒绝: /cc_deny ${id.slice(0, 8)}`
  });
}
```

```js
// 审批命令
api.registerCommand({
  name: "cc_approve",
  description: "批准审批请求",
  handler: async (ctx) => {
    const shortId = ctx.args?.trim();
    if (!shortId) return { text: "用法: /cc_approve <审批ID>" };

    const item = findApprovalByShortId(shortId);
    if (!item) return { text: "未找到该审批请求。" };
    if (item.status !== 'PENDING') return { text: `该请求已处理: ${item.status}` };

    approvalStore.resolve(item.id, 'APPROVED');
    return { text: ` 已批准 #${shortId}: ${item.toolName}` };
  }
});

api.registerCommand({
  name: "cc_deny",
  description: "拒绝审批请求",
  handler: async (ctx) => {
    const shortId = ctx.args?.trim();
    if (!shortId) return { text: "用法: /cc_deny <审批ID>" };

    const item = findApprovalByShortId(shortId);
    if (!item) return { text: "未找到该审批请求。" };
    if (item.status !== 'PENDING') return { text: `该请求已处理: ${item.status}` };

    approvalStore.resolve(item.id, 'DENIED');
    return { text: ` 已拒绝 #${shortId}: ${item.toolName}` };
  }
});
```

工具输入格式化（截断过长内容）：

```js
function formatToolInput(toolName, rawInput) {
  try {
    const input = JSON.parse(rawInput);
    if (toolName === 'Bash') return input.command?.slice(0, 200) || '(无命令)';
    if (toolName === 'Write' || toolName === 'Edit') return input.file_path || '(无路径)';
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return rawInput?.slice(0, 200) || '(无内容)';
  }
}
```

### 3.7 Hook 配置写入

```js
// hook-inbox.js
writeHookConfig(outputPath, approvalServerPort) {
  const bridgeUrl = `http://127.0.0.1:${approvalServerPort}`;

  // 根据 OS 选择 hook 脚本
  const hookScriptPath = process.platform === 'win32'
    ? path.join(__dirname, 'scripts', 'cc-bridge-approval-hook.mjs')
    : path.join(__dirname, 'scripts', 'cc-bridge-approval-hook.sh');

  const config = {
    hooks: {
      PreToolUse: [{
        matcher: "Bash|Write|Edit",
        hooks: [{
          type: "command",
          command: `${hookScriptPath} $CLAUDE_TOOL_NAME $CLAUDE_TOOL_INPUT`
        }]
      }]
    },
    env: {
      CC_BRIDGE_URL: bridgeUrl,
      CLAUDE_SESSION_ID: "$CLAUDE_SESSION_ID"
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
}
```

### 3.8 自动 Accept Edits 模式

启动 cc 会话时自动开启 Claude Code 的 accept edits 模式，Write/Edit 操作免审批，仅 Bash 需要审批。这大幅减少开发过程中的审批中断，同时保留对命令执行的安全管控。

**设计要点：**

- Write/Edit 在审批规则中默认 `auto_approve`，不需要走 hook 轮询流程
- Bash 命令仍需审批，尤其是破坏性命令（rm、sudo 等）
- 用户可通过 `/cc_mode` 命令切换模式：`strict`（全部需审批）vs `efficient`（Edit 免审批）
- Hook matcher 仅匹配 Bash，不再拦截 Write/Edit，减少 hook 调用开销

**启动时配置注入：**

```js
// cc_start 时自动写入 accept edits 配置
async function applyAcceptEditsMode(workspace) {
  // 方案 A：通过 Claude Code 的 --allowedTools 参数
  // 启动 claude 时传入允许的工具列表
  const args = [
    '--allowedTools', 'Edit,Write,Read,Glob,Grep,Bash',
    // Edit/Write 在 efficient 模式下自动放行
  ];

  // 方案 B：通过审批规则引擎配置
  // Write/Edit 默认 auto_approve（见 4.1 规则 DSL）
  // 无需额外操作，规则引擎已覆盖
}
```

**Hook matcher 优化 — 仅拦截 Bash：**

```js
// efficient 模式：只拦截 Bash，Edit/Write 免审批
const config = {
  hooks: {
    PreToolUse: [{
      matcher: "Bash",  // 仅 Bash 走审批 hook
      hooks: [{
        type: "command",
        command: `${hookScriptPath} $CLAUDE_TOOL_NAME $CLAUDE_TOOL_INPUT`
      }]
    }]
  }
};

// strict 模式：全部拦截
const configStrict = {
  hooks: {
    PreToolUse: [{
      matcher: "Bash|Write|Edit",
      hooks: [{
        type: "command",
        command: `${hookScriptPath} $CLAUDE_TOOL_NAME $CLAUDE_TOOL_INPUT`
      }]
    }]
  }
};
```

**`/cc_mode` 命令：**

```js
api.registerCommand({
  name: "cc_mode",
  description: "切换审批模式",
  handler: async (ctx) => {
    const mode = ctx.args?.trim();  // efficient | strict

    if (!mode || (mode !== 'efficient' && mode !== 'strict')) {
      return {
        text: `当前模式: ${currentMode}
efficient — Edit/Write 免审批，仅 Bash 需审批（推荐开发时使用）
strict — 全部操作需审批（推荐审查/部署时使用）

切换: /cc_mode efficient 或 /cc_mode strict`
      };
    }

    // 更新 Hook 配置
    const sessionId = bridge.findActiveSession(ctx.senderId);
    if (!sessionId) return { text: "没有活跃会话。" };

    const meta = bridge.sessionMeta.get(sessionId);
    const matcher = mode === 'efficient' ? 'Bash' : 'Bash|Write|Edit';
    hookInbox.writeHookConfig(hookConfigPath, approvalServer.getPort(), matcher);

    currentMode = mode;
    return { text: ` 已切换到 ${mode} 模式。` };
  }
});
```

**Hook 配置写入支持 matcher 参数：**

```js
// hook-inbox.js — writeHookConfig 增加 matcher 参数
writeHookConfig(outputPath, approvalServerPort, matcher = 'Bash') {
  const bridgeUrl = `http://127.0.0.1:${approvalServerPort}`;

  const hookScriptPath = process.platform === 'win32'
    ? path.join(__dirname, 'scripts', 'cc-bridge-approval-hook.mjs')
    : path.join(__dirname, 'scripts', 'cc-bridge-approval-hook.sh');

  const config = {
    hooks: {
      PreToolUse: [{
        matcher,  // 由调用方决定拦截范围
        hooks: [{
          type: "command",
          command: `${hookScriptPath} $CLAUDE_TOOL_NAME $CLAUDE_TOOL_INPUT`
        }]
      }]
    },
    env: {
      CC_BRIDGE_URL: bridgeUrl,
      CLAUDE_SESSION_ID: "$CLAUDE_SESSION_ID"
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
}
```

### 4.1 规则 DSL（YAML 配置）

```yaml
# cc-approval-rules.yml
# 默认 efficient 模式：Write/Edit 免审批，仅 Bash 需审批
rules:
  # === 文件编辑类 — 免审批 ===
  - tool: Write
    action: auto_approve

  - tool: Edit
    action: auto_approve

  # === 安全命令 — 免审批 ===
  - tool: Bash
    command_pattern: "^npm test$"
    action: auto_approve

  - tool: Bash
    command_pattern: "^git status$"
    action: auto_approve

  - tool: Bash
    command_pattern: "^git commit"
    action: auto_approve

  - tool: Bash
    command_pattern: "^git (add|diff|log|branch|stash)"
    action: auto_approve

  # === minimatch 路径匹配 — 特定路径免审批 ===
  - tool: Write
    path_pattern: "src/**/*.md"
    action: auto_approve

  # === 破坏性命令 — 必须审批 ===
  - tool: Bash
    command_pattern: "^rm\\s+-rf\\s+.*"
    action: require_approval
    sensitive: true

  - tool: Bash
    command_pattern: "^sudo\\s+.*"
    action: require_approval
    sensitive: true

  - tool: Bash
    command_pattern: "^npm (publish|run build:prod)"
    action: require_approval
    sensitive: true

  # === 默认策略 ===
  # Bash 未匹配任何规则时需审批
  # Write/Edit 在 efficient 模式下已免审批（不走 hook）
  # strict 模式下 Write/Edit 也会走 hook，此时 hit 此规则
  - tool: "*"
    action: require_approval
```

### 4.2 规则匹配（含正则安全检测）

```js
const minimatch = require('minimatch');

class ApprovalRules {
  constructor(rulesPath) {
    this.rules = this.loadRules(rulesPath);
  }

  loadRules(filePath) {
    const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
    // 验证每条规则的 command_pattern
    for (const rule of raw.rules) {
      if (rule.command_pattern) {
        if (rule.command_pattern.length > 100) {
          throw new Error(`规则正则过长 (>100): ${rule.command_pattern}`);
        }
        if (hasNestedQuantifiers(rule.command_pattern)) {
          throw new Error(`规则正则含嵌套量词: ${rule.command_pattern}`);
        }
        if (hasBackReference(rule.command_pattern)) {
          throw new Error(`规则正则含反向引用: ${rule.command_pattern}`);
        }
        // 编译测试：确保正则可正常编译
        try { new RegExp(rule.command_pattern); }
        catch (e) { throw new Error(`规则正则编译失败: ${e.message}`); }
      }
    }
    return raw.rules;
  }

  match(toolName, context = {}) {
    for (const rule of this.rules) {
      if (rule.tool !== toolName && rule.tool !== '*') continue;

      if (rule.command_pattern && context.command) {
        const regex = new RegExp(rule.command_pattern);
        if (!regex.test(context.command)) continue;
      }

      if (rule.path_pattern && context.filePath) {
        if (!minimatch(context.filePath, rule.path_pattern)) continue;
      }

      return {
        action: rule.action,
        sensitive: rule.sensitive || false
      };
    }
    // 无匹配规则时默认需要审批
    return { action: 'require_approval', sensitive: false };
  }
}
```

### 4.3 正则安全检测函数

```js
// 检测嵌套量词：(group+quantifier)+quantifier
function hasNestedQuantifiers(pattern) {
  const groupQuantifier = /\([^)]*[+*{][^)]*\)[+*{]/;
  return groupQuantifier.test(pattern);
}

// 检测反向引用：\1, \2 等
function hasBackReference(pattern) {
  return /\\[1-9]/.test(pattern);
}
```

---

## 五、操作回滚

### 5.1 Git 快照创建（stash + stashRef 记录）

```js
class GitSnapshot {
  constructor(bridge, sessionId) {
    this.bridge = bridge;
    this.sessionId = sessionId;
  }

  create() {
    const meta = this.bridge.sessionMeta.get(this.sessionId);
    if (!meta) return false;

    const stashRef = `CC-snapshot-${this.sessionId}-${Date.now()}`;

    try {
      execSync('git add -A', { cwd: meta.cwd, stdio: 'ignore' });
      execSync(`git stash push -u -m "${stashRef}"`, { cwd: meta.cwd, stdio: 'ignore' });

      // 将 stashRef 记录到 sessionMeta
      meta.stashRef = stashRef;
      return true;
    } catch (e) {
      console.error('[GitSnapshot] 创建失败:', e.message);
      return false;
    }
  }
}
```

### 5.2 回滚操作（按 stash message 精确定位）

```js
revert(sessionId) {
  const meta = this.bridge.sessionMeta.get(sessionId);
  if (!meta || !meta.stashRef) {
    return { success: false, message: '未找到对应快照' };
  }

  try {
    const stashList = execSync('git stash list', { cwd: meta.cwd }).toString();
    const idx = stashList.split('\n').findIndex(line =>
      line.includes(meta.stashRef)
    );

    if (idx === -1) {
      return { success: false, message: '快照已被手动删除或不存在' };
    }

    // 使用 stash apply（不自动 drop，保留快照供回退）
    execSync(`git stash apply stash@{${idx}}`, { cwd: meta.cwd });
    return { success: true, message: '已回滚到任务前状态' };
  } catch (err) {
    return { success: false, message: `回滚失败: ${err.message}` };
  }
}
```

### 5.3 `/cc_revert` 命令（参数判断式确认）

```js
api.registerCommand({
  name: "cc_revert",
  description: "回滚上一次 CC 任务的代码变更",
  handler: async (ctx) => {
    const args = ctx.args?.trim();

    if (args === '--confirm') {
      const sessionId = bridge.findActiveSession(ctx.senderId);
      if (!sessionId) {
        return { text: "没有活跃的会话。" };
      }
      const result = bridge.revert(sessionId);
      return { text: result.success ? " 已回滚。" : ` 回滚失败: ${result.message}` };
    }

    if (args === '--cancel') {
      return { text: " 已取消回滚。" };
    }

    // 无参数时显示确认提示
    const sessionId = bridge.findActiveSession(ctx.senderId);
    if (!sessionId) {
      return { text: "没有活跃的会话。" };
    }
    return {
      text: ` 确认回滚？
将恢复到上次 CC 任务前的状态。

确认: /cc_revert --confirm
取消: /cc_revert --cancel`
    };
  }
});
```

### 5.4 Stash 定期清理（含会话状态验证）

清理前先确认该 stashRef 对应的会话确实已结束（sessionMeta 中已不存在或已停用），防止误删仍在活跃会话的 stash：

```js
// 清理超过 7 天的 CC 快照 stash
function cleanupOldStashes(bridge, cwd) {
  try {
    const stashList = execSync('git stash list', { cwd }).toString();
    const cutoff = Date.now() - 7 * 24 * 3600000;

    for (const line of stashList.split('\n')) {
      if (!line.includes('CC-snapshot-')) continue;

      // 从 stash message 中提取 sessionId
      const sessionIdMatch = line.match(/CC-snapshot-(\w+)-(\d+)/);
      if (!sessionIdMatch) continue;

      const sessionId = sessionIdMatch[1];
      const timestamp = parseInt(sessionIdMatch[2]);

      // 安全检查：会话仍在活跃中则跳过
      const meta = bridge.sessionMeta.get(sessionId);
      if (meta && meta.active) continue;

      // 时间阈值检查
      if (timestamp < cutoff) {
        const idx = stashList.split('\n').indexOf(line);
        execSync(`git stash drop stash@{${idx}}`, { cwd });
      }
    }
  } catch {}
}
```

---

## 六、上下文管理

### 6.1 分层注入策略

| 层级 | 内容 | 管理者 | 压缩行为 |
|------|------|--------|----------|
| 持久层 | 项目规则、编码规范、安全约束 | cc-bridge（注入到 CLAUDE.md） | 压缩时优先保留 |
| 临时层 | 当前文件列表、最近 git diff、当前分支 | `buildContextPrompt()` | 可被压缩摘要化 |

### 6.2 持久规则 — CLAUDE.md 注入机制

cc-bridge 启动时在 CLAUDE.md 末尾追加带标记的规则段，停止时删除：

```js
const RULES_START = '<!-- CC-BRIDGE-RULES:START -->';
const RULES_END = '<!-- CC-BRIDGE-RULES:END -->';

class ContextManager {
  constructor(workspace) {
    this.claudeMdPath = path.join(workspace, 'CLAUDE.md');
    this.rulesContent = this.loadBridgeRules();
  }

  loadBridgeRules() {
    const rulesPath = path.join(__dirname, 'bridge-rules-template.md');
    return fs.readFileSync(rulesPath, 'utf8');
  }

  injectRules() {
    let content = '';
    if (fs.existsSync(this.claudeMdPath)) {
      content = fs.readFileSync(this.claudeMdPath, 'utf8');
    }

    // 移除旧的注入段（如有）
    content = this.removeInjectedRules(content);

    // 追加新规则段
    const injected = `${RULES_START}\n${this.rulesContent}\n${RULES_END}`;
    content += `\n\n${injected}`;

    fs.writeFileSync(this.claudeMdPath, content);
  }

  // 启动时检查残留标记段：无活跃会话则自动清理
  cleanOrphanedRules(bridge) {
    if (!fs.existsSync(this.claudeMdPath)) return false;

    const content = fs.readFileSync(this.claudeMdPath, 'utf8');
    if (!content.includes(RULES_START)) return false;

    // 检查是否有活跃会话使用该工作目录
    const hasActiveSession = [...bridge.sessionMeta.values()].some(
      meta => meta.active && meta.cwd === path.dirname(this.claudeMdPath)
    );

    if (!hasActiveSession) {
      const cleaned = this.removeInjectedRules(content);
      fs.writeFileSync(this.claudeMdPath, cleaned);
      return true;  // 已清理残留
    }
    return false;  // 残留属于活跃会话，保留
  }

  removeInjectedRules(content) {
    const regex = new RegExp(
      `${RULES_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'gs'
    );
    return content.replace(regex, '').trim();
  }

  cleanup() {
    if (!fs.existsSync(this.claudeMdPath)) return;
    const content = fs.readFileSync(this.claudeMdPath, 'utf8');
    const cleaned = this.removeInjectedRules(content);
    fs.writeFileSync(this.claudeMdPath, cleaned);
  }
}
```

规则模板文件：

```markdown
<!-- bridge-rules-template.md -->
## CC Bridge 项目规则

- 必须使用 TypeScript strict 模式
- 测试覆盖率不低于 80%
- 禁止提交 .env 文件和敏感凭证
- 禁止执行 rm -rf 等破坏性命令
- 所有外部输入必须校验
```

### 6.3 临时上下文 — buildContextPrompt()

```js
buildContextPrompt(workspace) {
  const parts = [];

  // 当前分支
  try {
    const branch = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    parts.push(`当前分支: ${branch}`);
  } catch {}

  // 最近修改的文件（前 20 个）
  try {
    const files = execSync('git diff --name-only HEAD~5', { cwd: workspace }).toString().trim();
    if (files) {
      parts.push(`最近修改的文件:\n${files.split('\n').slice(0, 20).join('\n')}`);
    }
  } catch {}

  // 工作目录文件结构（浅层）
  try {
    const listing = execSync('ls -la', { cwd: workspace }).toString().trim();
    parts.push(`工作目录内容:\n${listing}`);
  } catch {}

  return parts.join('\n\n');
}
```

注入到 doSend：

```js
async function doSend(senderId, workspace, prompt, model, forceNew) {
  // ... 现有逻辑

  // 注入临时上下文（持久规则已在 CLAUDE.md 中）
  const contextPrompt = contextManager.buildContextPrompt(workspace);
  if (contextPrompt) {
    effectivePrompt = `[项目上下文]\n${contextPrompt}\n\n---\n\n${effectivePrompt}`;
  }

  // ... 执行任务
}
```

### 6.4 `/cc_context` 命令

```js
api.registerCommand({
  name: "cc_context",
  description: "查看当前项目上下文信息",
  handler: async (ctx) => {
    const sessionId = bridge.findActiveSession(ctx.senderId);
    if (!sessionId) return { text: "没有活跃会话。" };

    const meta = bridge.sessionMeta.get(sessionId);
    const context = contextManager.buildContextPrompt(meta.cwd);
    return { text: `当前项目上下文:\n\n${context}` };
  }
});
```

---

## 七、飞书集成

### 7.1 命令总览

| 命令 | 说明 |
|------|------|
| `/cc <prompt>` | 发送任务到 Claude Code |
| `/cc_start` | 启动持久会话（默认 efficient 模式） |
| `/cc_stop` | 停止持久会话 |
| `/cc_status` | 查看会话状态 |
| `/cc_answer <text>` | 回答 Claude Code 的问题 |
| `/cc_approve <id>` | 批准审批请求 |
| `/cc_deny <id>` | 拒绝审批请求 |
| `/cc_revert` | 回滚代码变更（需 `--confirm`） |
| `/cc_context` | 查看项目上下文 |
| `/cc_mode [efficient|strict]` | 切换审批模式 |

### 7.2 消息转发

飞书 ↔ Claude Code 双向消息转发：
- 代码块语法高亮
- 长消息自动分片（飞书单条消息限制）
- 错误信息格式化
- 审批通知格式化（含工具输入预览）

### 7.3 实时进度反馈

```js
handle: {
  onHookEvent: (type, data) => {
    switch (type) {
      case 'tool-use':
        api.sendMessage({
          channel: 'feishu',
          target: senderId,
          text: ` 调用: ${data.toolName}`
        });
        break;
      case 'tool-result':
        const status = data.error ? '' : '';
        const summary = data.error
          ? `失败: ${data.error.message?.slice(0, 50) || '未知错误'}`
          : '成功';
        api.sendMessage({
          channel: 'feishu',
          target: senderId,
          text: `${status} ${data.toolName}: ${summary}`
        });
        break;
    }
  }
}
```

---

## 八、Session 管理

### 8.1 会话生命周期

```
创建 → 活跃 → 空闲 → 超时销毁（支持 keep_alive 恢复）
```

### 8.2 持久会话管理（复合键隔离）

```js
class PersistentSessionManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsPath = path.join(dataDir, 'persistent-sessions.json');
  }

  getKey(senderId, workspace) {
    return `${senderId}::${workspace}`;
  }

  activate(senderId, workspace, sessionId) {
    const sessions = this.loadAll();
    const key = this.getKey(senderId, workspace);

    sessions[key] = {
      senderId,
      workspace,
      sessionId,
      active: true,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
      processAlive: true
    };

    this.saveAll(sessions);
    return sessions[key];
  }

  getActive(senderId) {
    const sessions = this.loadAll();
    for (const [key, session] of Object.entries(sessions)) {
      if (session.senderId === senderId && session.active) {
        return session;
      }
    }
    return null;
  }

  deactivate(senderId) {
    const sessions = this.loadAll();
    const active = this.getActive(senderId);
    if (active) {
      const key = this.getKey(senderId, active.workspace);
      sessions[key].active = false;
      sessions[key].stoppedAt = new Date().toISOString();
      this.saveAll(sessions);
    }
  }
}
```

### 8.3 会话超时自动停止

```js
// 心跳检查 + 超时清理
const HEARTBEAT_INTERVAL = 60000;  // 60 秒
const SESSION_TIMEOUT = 1800000;   // 30 分钟

setInterval(() => {
  for (const [sid, meta] of bridge.sessionMeta) {
    // 进程存活检测
    const alive = bridge.checkSessionAlive(sid);
    if (!alive.alive) {
      bridge.terminateSession(sid);
      continue;
    }

    // 超时检测
    const lastActive = new Date(meta.lastActiveAt).getTime();
    if (Date.now() - lastActive > SESSION_TIMEOUT) {
      bridge.terminateSession(sid);
      api.sendMessage({
        channel: 'feishu',
        target: meta.senderId,
        text: ` 会话超时已自动停止 (ID: ${sid.slice(0, 8)})`
      });
    }
  }
}, HEARTBEAT_INTERVAL);
```

---

## 九、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `dist/core/approval-server.js` | 新增 | HTTP 审批服务器（轮询架构） |
| `dist/core/approval-store.js` | 新增 | 审批持久化（原子写入） |
| `dist/core/approval-rules.js` | 新增 | 规则引擎（含正则安全检测） |
| `dist/core/claude-bridge.js` | 修改 | 双 Map 架构 + exitCode 优先 |
| `dist/core/git-snapshot.js` | 修改 | stash message 定位 + stashRef 记录 |
| `dist/core/hook-inbox.js` | 修改 | Hook 配置写入（含 OS 选择 + matcher 参数 + 模式切换） |
| `dist/core/persistent-session-manager.js` | 修改 | 复合键隔离 |
| `dist/core/context-manager.js` | 新增 | CLAUDE.md 注入/清理 + 临时上下文 |
| `dist/core/utils.js` | 修改 | 原子写入 + 文件锁支持 |
| `scripts/cc-bridge-approval-hook.sh` | 新增 | Bash 版 hook 脚本 |
| `scripts/cc-bridge-approval-hook.mjs` | 新增 | Node 版 hook 脚本（跨平台） |
| `dist/core/bridge-rules-template.md` | 新增 | 规则模板文件 |
| `config/cc-approval-rules.yml` | 新增 | 默认审批规则配置 |

---

## 十、配置项

```json
{
  "configSchema": {
    "properties": {
      "approvalServerPort": {
        "type": "number",
        "description": "审批服务器端口（0=自动分配），默认 0"
      },
      "defaultMode": {
        "type": "string",
        "description": "默认审批模式：efficient（Edit免审批）或 strict（全部审批），默认 efficient"
      },
      "gitSnapshotEnabled": {
        "type": "boolean",
        "description": "是否启用 Git 快照，默认 true"
      },
      "sessionTimeout": {
        "type": "number",
        "description": "持久会话超时时间（分钟），默认 30"
      },
      "heartbeatInterval": {
        "type": "number",
        "description": "心跳检查间隔（秒），默认 60"
      },
      "stashCleanupDays": {
        "type": "number",
        "description": "stash 清理天数阈值，默认 7"
      }
    }
  }
}
```

---

## 十一、实现计划

| 阶段 | 内容 | 预估 |
|------|------|------|
| Phase 1 | 进程管理 + 文件锁（双 Map、exitCode 检测、文件锁互斥、单元测试） | 2 天 |
| Phase 2 | 审批系统（轮询架构、ApprovalStore 持久化、bash/node hook 脚本、飞书命令式审批、重启超时飞书通知、efficient/strict 双模式 + /cc_mode、规则引擎 + 正则安全） | 4 天 |
| Phase 3 | 回滚 + 上下文（stash message 定位、stashRef 完整流程、清理前会话状态验证、CLAUDE.md 注入/清理/启动残留检查、buildContextPrompt） | 2 天 |
| Phase 4 | 飞书集成 + 联调（命令解析、消息转发、审批交互、端到端测试） | 2 天 |
| **总计** | | **6-7 天（含联调和边界测试）** |

---

## 十二、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 审批服务重启 | pending 请求丢失 | JSON 持久化 + 原子写入，重启后标记 TIMEOUT + 飞书摘要通知 |
| Accept Edits 模式 | Write/Edit 免审批 | efficient 为默认模式，可 /cc_mode 切换 strict；Git 快照兜底回滚 |
| Hook 连接失败 | 轮询中断 | 连接失败时重试 + 默认放行 |
| 飞书审批回调 | 需公网 HTTPS | 改用命令式审批，不依赖卡片回调 |
| stash 索引错位 | apply 错误快照 | 按 message 确定位 + stashRef 记录 |
| CLAUDE.md 覆盖 | 用户规则丢失 | 注入标记段，停止时自动清理 |
| CLAUDE.md 异常退出残留 | 规则段残留 | 启动时检查：无活跃会话则自动清理 |
| 正则 ReDoS | 服务卡死 | 长度限制 + 嵌套量词检测 + 白名单 |
| 进程检测异常 | 心跳误判 | exitCode 优先 + exit 事件主动清理 |
| stash 无限增长 | 占用磁盘空间 | 定期清理 + 验证会话已结束才删除 |
| stash 误删活跃快照 | 回滚丢失 | 清理前检查 sessionMeta，活跃会话跳过 |

---

## 十三、修订对照总表

| 模块 | v3.0 原始 | 第一修订版 | 第二修订版 | **最终版** |
|------|-----------|-----------|-----------|-----------|
| 审批连接 | HTTP 长连接 | 两阶段轮询 | 同 | 同 + 工具输入传递 + 重启飞书通知 |
| 审批持久化 | 无 | 无 | JSON 文件 | JSON + 原子写入 |
| 飞书审批 | 卡片按钮回调 | 同 | 卡片 JSON + 回调 | 命令式审批（无公网依赖） |
| Hook 脚本 | 伪代码 | 同 | bash 版完整 | bash + node 两版 + 工具输入 |
| 审批模式 | 全部需审批 | 同 | 同 | efficient（Edit 免审批）/ strict 双模式 + /cc_mode 命令 |
| 回滚命令 | `--confirm` 独立命令 | 参数判断 | 同 | 同 |
| 进程检测 | `process.kill(0)` | exitCode 优先 | 同 | 同 + exit 事件主动清理 |
| stash 操作 | `stash pop` | `stash apply` | 按 message 定位 | 同 + stashRef 记录 + 清理前验证会话状态 |
| 上下文注入 | 全拼到 prompt | CLAUDE.md + 临时 | 独立 bridge-rules.md | CLAUDE.md 注入标记段 + 临时上下文 + 启动残留清理 |
| 正则安全 | 无限制 | 静态防御 | 同 | 同 + 检测函数实现 |
| Map 命名 | 混用 | processMap + sessionMeta | 同 | 同 + sessionMeta 含 stashRef |
| 时间估算 | 3-4 天 | 5-6 天 | 6-7 天 | 6-7 天 |