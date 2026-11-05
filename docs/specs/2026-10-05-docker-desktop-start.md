# Docker Desktop 受控启动

实施及真实分支验收已完成，[任务已归档](../archive/tasks/2026-10-05-docker-desktop-start.md#d5-completion-20261103)，本规格继续维护现行行为。10-25 的 V2 关闭与 11-03 的当前配置恢复分别留证，后续验收按当时有效配置执行。

目标 daemon 不可连接时，通过维护脚本启动现有 Docker Desktop，恢复投资复盘目标验收的基础环境。入口仅允许 start/status；daemon 已可用时 start 不产生变更。启动命令设 45 秒上限，失败保留退出状态。

本入口不修改容器、镜像、卷、缓存或配置。应用更新继续使用现有 update/sync-code 入口。测试使用 Docker 命令替身验证幂等、失败传播与严格参数，不触及实际资源。

## 引擎残留进程恢复

`scripts/docker-desktop-recover.mjs` 默认只读预览；`--execute` 保持一次普通重启语义。2026-10-25 的正式关闭更新发生真实 ENOSPC，随后 daemon 离线，普通恢复在停止残留后台时超时，现有启动入口亦返回已运行但无法连接。

为完成保留数据的关闭恢复，增加独立显式参数 `--force-stop`：仅在 `--execute`、磁盘已恢复正余量、活动更新检查通过、daemon 仍不可连接时，最多执行一次 `docker desktop stop --force --timeout 45`，成功后最多启动一次并重新检查 daemon。任一步失败保留结果且停止后续状态变更；健康引擎保持幂等，预览不产生变更。仅使用 Docker Desktop CLI，不修改设置、磁盘容量、数据文件、容器或卷定义。当前任务由调用方核对既有任务终态及挂载基线；恢复后必须回到正式 `update.sh thesis-ledger` 完成调用方当前有效配置与应用／数据验收。10-25 场景要求关闭 V2；后续已经授权启用时保留当时有效值，并继续保留原关闭证据。可写层代码快更另经正式 `sync-code.sh thesis-ledger` 恢复和核对。
