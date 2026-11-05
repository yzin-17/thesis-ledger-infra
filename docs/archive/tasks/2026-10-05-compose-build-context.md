# Compose 构建 context 实施

> 归档核对（2026-11-05）：本任务自身实施与适用验收已有完成记录，本轮最终文档一致性核对通过，未发现仍由本任务持有的未决义务。保留原失败、限制和证据时点；现行维护合同见对应 Spec，后续主仓门禁按其 Task 接续。本轮未重跑 Docker 或来源请求。

对应[规格](../../specs/2026-10-05-compose-build-context.md)。

- [x] B1 正式更新入口由 Compose 导出等价定义，再绑定已验证 context 执行 Bake；`bash scripts/build-space.test.sh` 退出 0，定义失败停止更新、构建与空间探针一致性及原空间门禁通过。
- [x] B2 运行官方保数据更新，记录真实构建、备份演练、数据库与目标验收。

目标环境 Compose 5.5.1 中，单独传入环境变量、再增加父 CLI 参数的两次尝试均在实际构建前退出；后续等价 Bake 路径成功，日志为 `/private/tmp/tl-journal-preserve-update-bake.log`。正式入口退出 0，五个业务容器健康。Server/Worker 使用新镜像 `sha256:5a6544bcaaf478cddac2c4b37fc460bf2f9905c89b13066f896c50804d2a05cc`；DSA 原镜像保持不变。

备份与隔离恢复演练位于 `.database-upgrades/run.tSho8O`；目标 `thesis_ledger/thesis_ledger`、受限应用角色和保数据验证通过，事务执行成功。目标 head 为 `20261005143000_authoring_analysis_application`，80 张 public 业务表，三账户经济哈希及两个旧 Journal v2 报告保护性读取通过。没有跳过构建空间或结构门禁，没有新增扩容操作。
