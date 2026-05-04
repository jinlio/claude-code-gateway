# Claude Code Gateway

A gateway bridge connecting [Claude Code](https://claude.ai/code) CLI to messaging platforms (Feishu/Lark, WeCom, etc.) with approval control, session management, and rollback support.

Inspired by [openclaw-cc-bridge](https://github.com/cadl/openclaw-cc-bridge), with major architectural redesign for reliability, security, and developer experience.

## Features

### Approval System
- **Two-phase polling architecture** — Hook scripts create approval requests and poll for status, no long-lived HTTP connections that could be killed by timeouts
- **efficient / strict dual modes** — `efficient` mode auto-approves Edit/Write operations, only Bash commands require approval; `strict` mode requires approval for all operations
- **Feishu command-based approval** — `/cc_approve <id>` and `/cc_deny <id>` commands, no dependency on public HTTPS endpoints for interactive card callbacks
- **Atomic persistence** — Approval requests persisted to JSON with atomic write (write-to-temp + rename), crash-safe
- **Regex-safe rule engine** — YAML-based DSL with length limits, nested quantifier detection, and predefined whitelist patterns

### Process Management
- **Dual Map architecture** — `processMap` (sessionId → ChildProcess) for liveness detection, `sessionMeta` (sessionId → metadata) for business logic
- **exitCode-first liveness check** — Cross-platform reliable process detection, `process.kill(0)` only as backup on Windows
- **Compound key isolation** — `senderId::workspace` keys prevent cross-workspace session interference
- **Heartbeat + timeout** — Configurable heartbeat interval and session timeout with automatic cleanup

### Rollback
- **Git stash with message-based positioning** — Each snapshot gets a unique stash message (`CC-snapshot-<sessionId>-<timestamp>`) for precise revert targeting
- **stashRef tracking** — Stash references stored in sessionMeta, no risk of applying wrong snapshot
- **`stash apply` over `stash pop`** — Preserve stash entries for manual recovery, with periodic cleanup (7-day default)
- **Session state validation before cleanup** — Only drop stashes for sessions that are confirmed inactive

### Context Management
- **CLAUDE.md marker injection** — Rules injected between `<!-- CC-BRIDGE-RULES:START -->` and `<!-- CC-BRIDGE-RULES:END -->` markers, auto-cleaned on shutdown
- **Startup orphan detection** — If process was killed (`kill -9`), residual marker segments are auto-cleaned on next startup when no active session owns them
- **Two-layer injection** — Persistent rules in CLAUDE.md (survives context compression), temporary context (git branch, recent files) in prompt prefix

### Multi-platform Support
- **Feishu/Lark** — Full command set, message forwarding with code highlighting, approval notifications
- **WeCom** — Planned for Phase 5
- **Extensible** — Plugin architecture allows adding new platform adapters

## Commands

| Command | Description |
|---------|-------------|
| `/cc <prompt>` | Send task to Claude Code |
| `/cc_start` | Start persistent session (default: efficient mode) |
| `/cc_stop` | Stop persistent session |
| `/cc_status` | View session status |
| `/cc_answer <text>` | Answer Claude Code's question |
| `/cc_approve <id>` | Approve an approval request |
| `/cc_deny <id>` | Deny an approval request |
| `/cc_revert` | Rollback code changes (requires `--confirm`) |
| `/cc_context` | View project context info |
| `/cc_mode [efficient|strict]` | Switch approval mode |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Feishu/Lark │────▶│  Plugin (index.js)│────▶│ Claude Code │
│   WeCom etc  │◀────│  Command Handler  │◀────│    CLI      │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │             │
              ┌─────▼─────┐ ┌────▼─────┐
              │ Approval  │ │ Session  │
              │ Server    │ │ Manager  │
              │ (HTTP)    │ │ (Dual Map)│
              └─────┬─────┘ └────┬─────┘
                    │             │
              ┌─────▼─────┐ ┌────▼─────┐
              │ Approval  │ │   Git    │
              │ Store     │ │ Snapshot │
              │ (Atomic)  │ │ (Stash)  │
              └───────────┘ └───────────┘

                    ┌──────────────┐
                    │   Hook Script │
                    │ (bash / node) │◀── Claude Code PreToolUse
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Approval   │
                    │   Server     │◀── Poll for status
                    │   (HTTP)     │──▶ Feishu notification
                    └──────────────┘
```

## Approval Flow

```
Claude Code → PreToolUse hook → POST /api/approval/request → ApprovalServer
                                                              │
                                                              ▼
                                                    Feishu: "审批请求 #abc123
                                                             工具: Bash
                                                             内容: rm -rf /tmp
                                                             批准: /cc_approve abc123
                                                             拒绝: /cc_deny abc123"
                                                              │
                                         Hook polls GET /status │  User: /cc_approve abc123
                                         ┌──────────────────────│──────────┐
                                         │  2s interval         │          │
                                         │  max 150 times       │          │
                                         │  5min timeout        ▼          │
                                         │              POST /respond      │
                                         │              → APPROVED         │
                                         ▼                                │
                                    exit 0 (approved)                     │
                                    exit 2 (denied)                       │
                                    exit 3 (timeout)                      │
```

## Quick Start

```bash
# Install dependencies
npm install

# Configure approval rules (optional, defaults work out of box)
cp config/cc-approval-rules.yml.example config/cc-approval-rules.yml

# Run tests
npm test

# Start the plugin (within openclaw platform)
npm start
```

## Configuration

See `openclaw.plugin.json` for the full config schema. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `approvalServerPort` | `0` (auto) | Approval HTTP server port |
| `defaultMode` | `efficient` | Approval mode: `efficient` (Edit auto-approve) or `strict` (all require approval) |
| `gitSnapshotEnabled` | `true` | Enable git stash snapshots before each task |
| `sessionTimeout` | `30` | Session timeout in minutes |
| `heartbeatInterval` | `60` | Heartbeat check interval in seconds |
| `stashCleanupDays` | `7` | Stash cleanup threshold in days |

## Implementation Plan

See [cc-bridge-v3-final-plan.md](cc-bridge-v3-final-plan.md) for the detailed 6-7 day phased implementation plan.

## License

MIT — See [LICENSE](LICENSE) for details. Original project attribution: [openclaw-cc-bridge](https://github.com/cadl/openclaw-cc-bridge).