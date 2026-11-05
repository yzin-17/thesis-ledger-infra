# 已验 Server 镜像恢复的依赖就绪规格

> 对应任务：[已完成实施任务](../archive/tasks/2026-10-26-reused-server-dependencies.md)

## 背景与边界

Docker 引擎中断后，开发栈的 PostgreSQL、Redis、DSA、Server 和 Worker 均退出。正式 `update.sh thesis-ledger` 的镜像复用分支可恢复已验 Server 镜像，但当前 `--no-deps` 启动分支只重建两个消费者，未恢复 Redis、DSA 等已退出依赖。

本任务只补齐该已有恢复分支。仍经正式更新入口及其原锁、镜像身份、数据库检查、挂载恢复和健康门禁；只使用本地已有镜像，不拉取、构建或清理依赖镜像，不改配置、数据库结构或数据，不 stage 或 commit。

## 验收断言

- AC1：仅在有效的 `thesis-ledger` 镜像复用分支中，消费者启动前由同一 Compose 配置以 `up -d --no-build --pull never postgres redis dsa` 恢复依赖，不对依赖使用强制重建。
- AC2：依赖启动及三个健康检查均成功后，才按既有同镜像方式重建 Server／Worker；任一步失败必须停止，不启动消费者，不改变原数据库与镜像身份门禁。
- AC3：固定场景测试验证目标、调用参数、顺序和失败收敛；正式入口实际恢复后，五个服务就绪，消费镜像仍为明确的已验完整 ID。

该分支负责运行态恢复，不代表新宿主源码已进入镜像。后续源码更新仍须另经 `sync-code.sh` 的兼容预检和独立功能验收。
