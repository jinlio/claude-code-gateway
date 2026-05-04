# Claude Code Gateway — 项目规则

## 开发日志同步

- 每个阶段开发任务完成后，必须将开发信息同步到 `开发日志.md`（变更内容、关键决策、遇到的问题等）
- 测试信息（测试结果、覆盖率、失败的测试等）必须同步到 `测试日志.md`

## 开发前必读

- 每次开始新的开发任务前，必须先阅读 `开发日志.md` 和 `测试日志.md`，了解项目当前状态和历史上下文

## Git 提交规范

- 提交代码时不带 Claude 的 Co-Authored-By 签名
- 遵循 conventional commits 格式：`<type>: <description>`

## 项目结构

```
src/core/          — 核心模块（claude-bridge, approval-server, git-snapshot, etc.）
src/plugin/        — 插件入口和命令注册
scripts/           — Hook 脚本（bash + node 两版）
config/            — YAML 审批规则配置
test/core/         — 核心模块单元测试
test/integration/  — 集成测试
```

## 设计文档

- 详细增强计划见 `cc-bridge-v3-final-plan.md`，所有实现必须参照该文档