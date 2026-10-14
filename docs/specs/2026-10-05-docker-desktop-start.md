# Docker Desktop 受控启动

目标 daemon 不可连接时，通过维护脚本启动现有 Docker Desktop，恢复投资复盘目标验收的基础环境。入口仅允许 start/status；daemon 已可用时 start 不产生变更。启动命令设 45 秒上限，失败保留退出状态。

本入口不修改容器、镜像、卷、缓存或配置。应用更新继续使用现有 update/sync-code 入口。测试使用 Docker 命令替身验证幂等、失败传播与严格参数，不触及实际资源。
