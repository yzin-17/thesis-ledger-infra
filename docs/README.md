# 开发栈文档中心

本仓维护三仓的 Compose、镜像、正式更新、备份与恢复。目录分类和归档语义见[文档指南](DOCUMENTATION-GUIDE.md)。

| 内容 | 入口 |
| --- | --- |
| 更新、恢复与凭据操作 | [使用与维护指南](guides/README.md) |
| 仍有效的维护入口与运行约束 | [规格目录](specs/) |
| 已完成实施 | [归档](archive/README.md) |
| 已结案运行证据 | [证据归档](archive/evidence/README.md) |
| 环境配置、初始化与命令总览 | [项目说明](../README.md) |
| 产品与来源数据 | [主仓](../../thesis-ledger/docs/README.md)、[DSA](../../daily-stock-analysis/docs/README.md) |

文档中的历史成功只证明当时输入和对应范围；新的更新仍按正式入口和当前兼容、数据库及数据保护门禁执行。

## 当前任务

2026-11-12：本仓显式不备份编排的局部交付已完成，见[归档任务](archive/tasks/2026-11-12-explicit-no-backup-upgrade.md)。不备份分支的真实目标执行仍由[主仓B4](../../thesis-ledger/docs/tasks/2026-11-12-development-upgrade-without-backup.md)持有；并行默认更新已完成原增列，不重复迁移。本仓暂无活动实施任务，现行入口合同见[规格](specs/2026-11-12-explicit-no-backup-upgrade.md)。

最近核对：2026-11-11。当前无活动实施任务。[维护运行层收敛](archive/tasks/2026-11-11-maintenance-runtime.md)已完成，其[验收记录](archive/evidence/2026-11-11-maintenance-runtime.md)覆盖恢复职责、共用锁与执行层、正式快更及数据留存。[Vitest 测试接入](archive/tasks/2026-11-11-vitest-testing.md)的[验收记录](archive/evidence/2026-11-11-vitest-testing.md)保留工具安装结果。[Node.js 编排迁移](archive/evidence/2026-11-11-node-orchestration.md)及[应用部署接口归属](archive/evidence/2026-11-11-application-deployment-interfaces.md)的早期记录保留当时输入和范围，维护运行层的当前实现以本次收敛为准。

当前更新和维护行为由 [specs/](specs/) 与[运维指南](guides/README.md)维护。归档不重开历史构建、扩容或故障注入，也不代收[主仓活动任务](../../thesis-ledger/docs/tasks/README.md)的来源和产品验收。
