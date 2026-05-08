# Claude Code Gateway

> **⚠️ This project is under active development and not yet functional. The features described below are planned, not currently available. This notice will be removed once development is complete.**

A gateway bridge connecting [Claude Code](https://claude.ai/code) CLI to messaging platforms with approval control, session management, and rollback support. Compatible with both [OpenClaw](https://github.com/openclaw/openclaw) (Node.js) and [Hermes-Agent](https://github.com/NousResearch/hermes-agent) (Python) platforms.

Inspired by [openclaw-cc-bridge](https://github.com/cadl/openclaw-cc-bridge), with major architectural redesign for reliability, security, and developer experience.

## Dual-Plugin Architecture

This project provides two independent plugin packages that share a common approval protocol:

```
claude-code-gateway/
├── openclaw-plugin/       # Node.js plugin for OpenClaw platform
│   ├── src/core/          # 11 core modules
│   ├── src/plugin/        # Plugin entry points
│   ├── test/              # 264 tests (97% coverage)
│   └── package.json
├── hermes-plugin/         # Python plugin for Hermes-Agent platform
│   ├── core/              # 12 core modules
│   ├── tests/             # 395 tests (81% coverage)
│   ├── plugin.yaml        # Hermes manifest
│   └── pyproject.toml
├── shared/                # Shared protocol specifications
│   ├── approval-api.md    # HTTP API spec (3 endpoints)
│   ├── command-reference.md  # 10 /cc commands spec
│   ├── session-schema.md  # Data format spec
│   ├── hook-scripts/      # Platform-agnostic hook scripts
│   └── cross-compat-test.py  # Cross-platform verification
├── README.md
├── CLAUDE.md
└── LICENSE
```

Both plugins implement the same approval HTTP API, use the same data formats, and share the same hook scripts — ensuring consistent behavior regardless of platform.

## Features

### Approval System
- **Two-phase polling architecture** — Hook scripts create approval requests and poll for status, no long-lived HTTP connections
- **efficient / strict dual modes** — `efficient` mode auto-approves Edit/Write; `strict` mode requires approval for all
- **Command-based approval** — `/cc_approve <id>` and `/cc_deny <id>`, no dependency on public HTTPS endpoints
- **Atomic persistence** — Approval requests persisted to JSON with atomic write (write-to-temp + rename)
- **Regex-safe rule engine** — YAML-based DSL with length limits, nested quantifier detection, and predefined whitelist patterns

### Process Management
- **Dual Map architecture** — `processMap` (sessionId → Process) for liveness, `sessionMeta` (sessionId → metadata) for business logic
- **Compound key isolation** — `senderId::workspace` keys prevent cross-workspace session interference
- **Heartbeat + timeout** — Configurable heartbeat interval and session timeout with automatic cleanup

### Rollback
- **Git stash with message-based positioning** — `CC-snapshot-<sessionId>-<timestamp>` for precise revert targeting
- **`stash apply` over `stash pop`** — Preserve stash entries for manual recovery, with 7-day cleanup
- **Session state validation before cleanup** — Only drop stashes for confirmed inactive sessions

### Context Management
- **CLAUDE.md marker injection** — Rules between `<!-- CC-BRIDGE-RULES:START -->` and `<!-- CC-BRIDGE-RULES:END -->` markers
- **Startup orphan detection** — Residual markers auto-cleaned when no active session owns them

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

## Quick Start

### OpenClaw Plugin (Node.js)

```bash
cd openclaw-plugin
npm install
npm test          # 264 tests
npm start         # Run within OpenClaw platform
```

### Hermes-Agent Plugin (Python)

```bash
cd hermes-plugin
pip install -e ".[dev]"
pytest --cov=core # 395 tests, 81% coverage
```

### Cross-Platform Verification

```bash
python shared/cross-compat-test.py   # Verify both plugins produce consistent behavior
```

## Configuration

### OpenClaw (openclaw-plugin)

See `openclaw.plugin.json` for the full config schema. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `approvalServerPort` | `0` (auto) | Approval HTTP server port |
| `defaultMode` | `efficient` | Approval mode |
| `gitSnapshotEnabled` | `true` | Enable git stash snapshots |
| `sessionTimeout` | `30` | Session timeout in minutes |
| `heartbeatInterval` | `60` | Heartbeat check interval in seconds |

### Hermes-Agent (hermes-plugin)

Environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CC_BRIDGE_WORKSPACE` | Yes | Working directory for Claude Code sessions |
| `CC_BRIDGE_MODE` | No | Approval mode: `efficient` (default) or `strict` |
| `CC_BRIDGE_SECRET` | No | Shared secret for approval API auth |
| `CC_BRIDGE_ALLOWED_USERS` | No | Comma-separated allowed user IDs |

## Shared Protocol

Both plugins implement the same 3-endpoint HTTP API (see `shared/approval-api.md`):

- `POST /api/approval/request` — Create or auto-approve a request
- `GET /api/approval/status?id=<uuid>` — Poll request status
- `POST /api/approval/respond?id=<uuid>&action=<approve|deny>` — Resolve a request

Data formats (see `shared/session-schema.md`, `shared/command-reference.md`) are identical across platforms for full interoperability.

## License

MIT — See [LICENSE](LICENSE) for details. Original project attribution: [openclaw-cc-bridge](https://github.com/cadl/openclaw-cc-bridge).
