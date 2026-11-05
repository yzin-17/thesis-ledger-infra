# Docker 虚拟盘容量实施

<a id="priority"></a>
> 排期（2026-10-18）：**P1｜既有部署条件的证据核对，不是再次扩容任务**。见 [跨仓优先级](../../../thesis-ledger/docs/tasks/README.md#cross-repository-priority)。
> V3 已与后续正式保留更新逐项核对，见[下方记录](#v3-后续正式更新对账)。不按旧“重试”文字重复更新、扩容或重建。

对应[规格](../specs/2026-10-05-docker-disk-capacity.md)。

用户后续明确禁止扩容，并要求仅从项目正式更新脚本更新。此前 32→48 GiB 调整已执行且全部资源身份保留；本记录只保留事实，不作为继续扩容的授权。后续不调用扩容入口，也不自动缩盘。

- [x] V1 维护入口与 7 项隔离测试通过；保护全部其他配置。
- [x] V2 新指令到达前已扩展到 48 GiB，镜像、容器、卷与磁盘文件身份一致，维护入口退出 0。
- [x] V3 官方保数据更新的空间、备份演练、结构和运行态分别验收；复用后续正式更新，无需重复部署。

## V3 后续正式更新对账

2026-10-20 只读复核[10-19 P0 目标验收](../../../thesis-ledger/docs/tasks/evidence/2026-10-19-p0-target-acceptance.md#正式更新与候选身份)与原始回执，四项义务分别成立：

| 义务 | 实际证据与边界 |
| --- | --- |
| 正式入口与空间 | `/tmp/thesis-ledger-p0-formal-update.log` 记录 `DEV_DATABASE_MODE=upgrade DEV_DATABASE_CONFIRM=thesis-ledger-dev/thesis_ledger ./scripts/update.sh thesis-ledger` 退出 0。维护后宿主 12,270 MiB、Docker 23,242 MiB，最终分别 13,619 / 23,242 MiB。按现行构建空间 AC15～AC19 的正余量及参考目标合同执行；没有声称满足旧宿主 20 GiB 硬门槛，也未再次扩容。 |
| 备份与恢复演练 | `.database-upgrades/run.OKALSe/backup.dump` 重新计算为 3,862,181 字节、SHA-256 `cabe0e8c800e89f5ab0a8798487e4c4af5d0888dc57bf87116dcb900c27a8b1f`，目录/文件权限 700/600。`rehearsal.json` 的 `structureComplete/appRolePermissions/preservedData` 均为 true，`execute.log` 为“事务执行成功”。 |
| 结构与留存 | 升级前后 head 均为 `20261019020000_research_observation_versions`。正式 P0 回执核对 78 张业务表、36,537 条原记录、642 个快照文件；5 条自动化记录只允许已披露的调度游标单调推进，挂载保持一致。不是开发清库，也没有通过忽略整表代替保留。 |
| 实际运行态 | Server/Worker 为 `sha256:c1f3c9d890e17f6ffa827aae9c80a8b21fd53e4d37d08ed4a51a3f3de8187eac`，P0 三类目标业务已验收。10-20 再次核对五服务健康、7 张保护表和 57 份成功结果不变；研究 G2b 与 AI 配置副本验收继续复用同一镜像。 |

本次仅核对和更新原门禁状态，没有 Docker 状态变更。V3 关闭不代表未来空间保证、应用发布、来源资格或真实模型验收；后续更新仍走现行正式入口。
