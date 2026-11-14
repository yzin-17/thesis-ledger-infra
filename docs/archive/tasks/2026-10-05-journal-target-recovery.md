# 目标投资复盘恢复验收

> 归档核对（2026-11-05）：本任务自身实施与适用验收已有完成记录，本轮最终文档一致性核对通过，未发现仍由本任务持有的未决义务。保留原失败、限制和证据时点；现行维护合同见对应 Spec，后续主仓门禁按其 Task 接续。本轮未重跑 Docker 或来源请求。

对应[规格](../../../../thesis-ledger/docs/specs/2026-10-05-journal-target-recovery.md)。

- [x] R1 实现精确目标、无其他在途任务、单次 dispatching、拒绝晚到终态等维护门禁与定向测试。`node --test scripts/journal-target-recovery.test.mjs` 八个测试通过。
- [x] R2 正式升级后执行在途 Server 故障，恢复同一容器与镜像，原运行安全收敛且不重发。
- [x] R3 核对保护账本、默认配置、旧报告与 Worker，回写主仓投资复盘证据。

首次目标运行暴露恢复选择条件遗漏复盘 prompt，原失败运行保持不变。主仓修复按研究 SDK/冻结契约识别任务，定向九项与隔离 PostgreSQL 十项通过，官方快更兼容预检通过。新验收运行 `34abe590-02d6-4bb9-8018-17ec2909bd5a` 在同一 Server 容器/镜像重启后为 `failed/research_unknown_outcome`，attempt 1、请求记录一条；跨调度周期仍保持终态。Worker 未重启、三账户经济哈希、默认 revision 2 与两个旧 v2 报告均保持不变。日志为 `/private/tmp/tl-journal-target-recovery-fixed.log`。

该测试验证 dispatching 后的安全恢复和禁止自动重发；不推断外部实际收到或计费。快更本身只修改可写层，最终官方更新已将修复固化到镜像，见主仓[恢复实施归档](../../../../thesis-ledger/docs/archive/tasks/2026-10-05-journal-research-recovery-ownership.md)。
