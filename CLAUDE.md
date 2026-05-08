# Claude Code Gateway — 项目规则

## 开发日志同步

- 每个阶段开发任务完成后，必须将开发信息同步到 `开发日志.md`（变更内容、关键决策、遇到的问题等）
- 测试信息（测试结果、覆盖率、失败的测试等）必须同步到 `测试日志.md`

## 开发前必读

- 每次开始新的开发任务前，必须先阅读 `开发日志.md` 和 `测试日志.md`，了解项目当前状态和历史上下文

## Git 提交规范

- 提交代码时不带 Claude 的 Co-Authored-By 签名
- 遵循 conventional commits 格式：`<type>: <description>`

## 双插件架构

本项目同时兼容 OpenClaw（Node.js）和 Hermes-Agent（Python）两个平台：

```
openclaw-plugin/     # Node.js 插件（11 核心模块, 264 测试, 97% 覆盖率）
hermes-plugin/       # Python 插件（12 核心模块, 395 测试, 81% 覆盖率）
shared/              # 共享协议规范和 Hook 脚本
  ├── approval-api.md       # HTTP API 规格（3 个端点）
  ├── command-reference.md  # 10 个 /cc 命令规格
  ├── session-schema.md     # 数据格式规格
  ├── hook-scripts/         # 平台无关的 Hook 脚本
  └── cross-compat-test.py  # 跨平台兼容性验证
```

两个插件必须实现相同的 HTTP 审批 API（见 `shared/approval-api.md`），使用相同的数据格式（见 `shared/session-schema.md`），并共享 Hook 脚本。

## 项目结构

```
openclaw-plugin/
  src/core/           — Node.js 核心模块
  src/plugin/         — 插件入口
  test/               — 测试（15 个测试套件）

hermes-plugin/
  core/               — Python 核心模块
  tests/              — 测试（11 个测试文件）
  plugin.yaml         — Hermes 清单
  __init__.py         — 插件入口
  config/             — YAML 审批规则配置
```

## 设计文档

- 详细增强计划见 `cc-bridge-v3-final-plan.md`，所有实现必须参照该文档
- 共享协议规范见 `shared/` 目录下的文档
