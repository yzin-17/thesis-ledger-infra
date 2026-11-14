# Docker Desktop 受控启动

实施及真实分支验收已完成，[任务已归档](../archive/tasks/2026-10-05-docker-desktop-start.md#d5-completion-20261103)，本规格继续维护现行行为。10-25 的 V2 关闭与 11-03 的当前配置恢复分别留证，后续验收按当时有效配置执行。

目标 daemon 不可连接时，通过维护脚本启动现有 Docker Desktop，为本地部署提供可用引擎。入口仅允许 start/status；daemon 已可用时 start 不产生变更。启动命令设 45 秒上限，失败保留退出状态。

本入口不修改容器、镜像、卷、缓存或配置。应用更新继续使用现有 update/sync-code 入口。测试使用 Docker 命令替身验证幂等、失败传播与严格参数，不触及实际资源。
