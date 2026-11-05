# 已验 Server 镜像恢复的依赖就绪实施任务

## 当前执行摘要

- 规格：[依赖就绪规格](../../specs/2026-10-26-reused-server-dependencies.md)。计划预检：Ready。
- R1 及最终 Review 已完成。定向测试和正式镜像复用入口退出 0，五个服务健康；配置、业务表、原镜像及全部挂载反读通过，见[验收记录](../../tasks/evidence/2026-10-26-reused-server-dependencies.md)。
- 输入为 `reuse-thesis-ledger-image.sh`、`dev-database.sh` 及原复用测试，原锁、镜像验证和数据库 check 模式保持。

## 任务

- [x] R1：补齐消费者前的依赖恢复（AC1—AC3）。
  - 写入：镜像复用 helper、消费者启动编排、专用 shell 测试与本主题文档。
  - 验证：既有复用测试、新增顺序与失败场景、shell 语法检查；随后通过 `update.sh thesis-ledger` 的明确镜像复用参数恢复目标，反读五个服务状态及两个消费者镜像 ID。
  - 停止条件：入口明确失败、镜像或数据门禁不匹配时保留证据；不得绕过原校验或执行原始 Docker 状态变更命令。

## 最终一致性 Review

- [x] 分支边界、调用顺序、失败行为与规格一致。
- [x] 定向与真实入口证据通过，配置、数据和挂载保护有对应核对。
- [x] 未把恢复原镜像当作新源码部署，未 stage 或 commit。

结论：AC1—AC3 完成，任务归档；现行合同继续由 Spec 维护。
