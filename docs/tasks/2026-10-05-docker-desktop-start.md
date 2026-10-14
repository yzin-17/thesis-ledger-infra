# Docker Desktop 启动实施

对应[规格](../specs/2026-10-05-docker-desktop-start.md)。

- [x] D1 维护 start/status 入口；命令替身验证已运行、启动成功、失败和未知参数。
- [x] D2 执行 start，独立检查 daemon、既有服务和投资复盘健康；不把 daemon 可连接当成应用验收。

本轮 `start` 在 daemon 已就绪时退出 0，属于幂等无操作，不宣称执行过启动故障恢复。初始业务服务停止，随后经官方 `update.sh thesis-ledger` 保数据更新后五个服务健康，投资复盘候选、快照与已存在模型报告读取通过。daemon 与应用两层证据分别记录于主仓[复盘收口证据](../../../thesis-ledger/docs/tasks/evidence/2026-10-05-journal-review-completion.md)。
