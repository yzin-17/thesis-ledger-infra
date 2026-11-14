# 文档目录与生命周期

本仓使用[三仓统一规则](../../thesis-ledger/docs/DOCUMENTATION-GUIDE.md)，文档从 [README](README.md) 进入。

- `specs/`：维护入口、兼容顺序、运行保护与验收合同。
- `guides/`：更新、恢复、凭据及部署操作，见[指南导航](guides/README.md)。
- `archive/`：已完成任务，以及 `archive/evidence/` 中的独占运行证据。

活动 Task 状态见 [README](README.md#当前任务)。按实际内容维护 `tasks/`、`reviews/`、`evidence/`，不为缺少内容的类别创建空目录。

归档须核对任务完整范围、必要运行门禁、最终 Review 与未决责任，保留原日期、ID、锚点、失败和验证边界。当前维护 Spec 继续保留；目录移动修复所有跨仓和本地引用，不在旧 Task 位置留下跳转壳。

文档整理不重新执行 Docker、Provider 或数据库操作，历史单次授权不因材料保留而延续。
