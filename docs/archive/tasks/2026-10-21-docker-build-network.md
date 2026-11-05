# Docker 构建网络实施任务

> 归档核对（2026-11-05）：本任务自身实施与适用验收已有完成记录，本轮最终文档一致性核对通过，未发现仍由本任务持有的未决义务。保留原失败、限制和证据时点；现行维护合同见对应 Spec，后续主仓门禁按其 Task 接续。本轮未重跑 Docker 或来源请求。

任务标识：`docker-build-network`。[规格](../../specs/2026-10-21-docker-build-network.md)；关联主仓 [TAP4](../../../../thesis-ledger/docs/tasks/2026-10-09-unified-data-capability-adapter.md)。保留现有数据与三仓既有未提交改动。

- [x] N1：复查 PyPI TLS，建立更新前数据库/文件备份和数据、配置、挂载基线。实际宿主/运行容器 HTTPS 均通过；正式更新的 PyPI 安装与 DSA 镜像构建通过，后续 Alpine 索引 TLS 失败已独立记录。
- [x] N2：正式入口增加可选构建代理参数。缺省、三参数透传/引用、非法输入/换行、重置及 macOS 自带 Bash 检查通过；空间编排、更新21场景、DSA镜像复用、兼容清单通过，测试接入CI。代理仅用于构建，未修改运行时或全局配置。
- [x] N3：使用既有DSA镜像恢复正式all更新，退出0；默认数据库check通过，Server/Worker新镜像一致、DSA精确产物保持，五服务健康，运行时无构建代理变量。
- [x] N4：实际API/页面、目标隔离SQLite权限保存与两进程恢复通过；原数据、六卷、配置与研究产物核对通过。命令、失败与最终镜像/数据证据统一记录在[主仓验收](../../../../thesis-ledger/docs/evidence/2026-10-21-provider-account-level.md#正式更新与目标运行态验收)。

## 当前基线

备份入口 `node scripts/research-state-backup.mjs backup --target thesis-ledger-dev --output <私有路径>` 已退出 0。私有目录为 `.maintenance-backups/tushare-level-tls-20261021`，包含 PostgreSQL dump、DSA SQLite、DSA 数据文件与回测产物；57 份既有研究结果已登记。PostgreSQL 83 表/37104 行，DSA 43 表/241 行及203个数据文件；现有命名/匿名卷共6个。

首次续接日志 `update-1.log`：DSA 新镜像 `sha256:ebe9d9a742b396b5e885f007dedc49c960010094d095545be9b33ff2dfa8b632` 已完成，Server 因 Alpine 仓库 TLS 失败退出1。原容器保持运行，尚未切换到新镜像；未修改全局代理、证书或下载源。

第二次续接从同一目录执行正式 `update.sh all`，设置 `BUILD_HTTP_PROXY`、`BUILD_HTTPS_PROXY` 为当前宿主代理 `http://host.docker.internal:7890`，`BUILD_NO_PROXY=localhost,127.0.0.1,::1`，精确复用上述DSA镜像，`DEV_DATABASE_MODE=check`、两个拉取开关均false；日志为 `update-2.log`，最终退出0。首次发起因自动权限审批超时未执行，按工具允许重试后成功。当前N1～N4完成，已同步指南、环境示例、CI和主仓任务；代码未提交或推送。
