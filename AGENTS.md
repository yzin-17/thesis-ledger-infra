# 项目 Agent 规则

## Docker 操作入口

- 执行任何 Docker 操作前，必须读取并遵守 [`../AGENTS.md`](../AGENTS.md) 的「Docker 操作入口强制约束」。所有状态变更只能通过仓库维护的脚本执行；只读检查除外。该约束同时适用于子代理、故障恢复和隔离测试，不能用临时包装命令绕过。
- 目标更新使用 `./scripts/sync-code.sh [all|dsa|thesis-ledger]` 或 `./scripts/update.sh [all|dsa|thesis-ledger]`，按工作区规则判断适用条件；禁止直接调用脚本内部函数跳过正式入口的空间、并发、兼容性和数据库门禁。
- 缺少专用运维入口时，先在 `scripts/` 补充维护脚本与必要验证，再执行；不得直接修改 Docker 运行态作为临时补救。
