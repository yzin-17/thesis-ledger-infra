# 策略编写目标恢复任务

> 状态：2026-10-06 R1—R5 完成，主仓浏览器门禁由主任务承接。

对应[规格](../../../../thesis-ledger/docs/specs/2026-10-06-authoring-target-recovery.md)，归属主仓 A5-R。

- [x] R1：维护入口、精确目标、资源保护、并发拒绝、失败恢复和定向测试。七项 Node 定向测试通过；实际目标故障、未派发与不可用窗口分别由 R2—R5 记录。
- [x] R2：已验证零费率模型的标记编写操作进入实际 dispatching 后执行故障，核对相同容器/镜像、失败未知终态、单一 attempt/调用。
- [x] R3：两次调度周期后再次核对保护数据和无重发，记录主仓运行态证据。故障投递在 180 秒锁自然过期后 completed，数据库仍为失败未知、attempt 1、单一调用。
- [x] R4：维护入口暂停专用队列、标记 API 投递与等待态校验、移除单一投递和异常恢复；实际确认未派发补投有界且只调用一次。最终操作 `bf0c7bf9-bf4a-4ea8-bab9-d64a399a3649` 成功、attempt/deliveryAttempts 均为 1，31 秒观察保持；入口退出 0。
- [x] R5：维护入口停止同一 Redis，确认正常 API 返回 `503/AUTHORING_UNAVAILABLE`、无操作/调用新增；恢复四个同一容器及核对 19 张保护表。独立 `--phase=outage` 入口退出 0。

目标与源码仍使用同一应用镜像；当前代码由官方 `sync-code.sh thesis-ledger` 更新可写层。主仓证据：`docs/tasks/evidence/2026-10-06-authoring-completion.md`。首轮进程恢复后遇到基础设施锁未过期、首轮补投末尾要求 received 的失败均保留，后续阶段分开执行并按完整 Spec 复验。
