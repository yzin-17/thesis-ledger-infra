# 显式不备份开发升级编排

对应[主仓规格](../../../thesis-ledger/docs/specs/2026-11-12-development-upgrade-without-backup.md)和[本仓任务](../archive/tasks/2026-11-12-explicit-no-backup-upgrade.md)。用户已明确本次无需备份。

默认upgrade保持原备份／恢复演练流程。只有显式DEV_DATABASE_UPGRADE_NO_BACKUP=true、精确开发目标及64位小写迁移摘要时允许例外；业务资格、单项增列检查和摘要核验归应用。参数错误在消费者停止前拒绝。

正式update.sh thesis-ledger仍执行互斥、空间、镜像及结构门禁；消费者停止后准备证据、执行原事务，再调用应用提交后摘要核验，最后检查完整结构。任一步失败保持消费者停止。infra不读取业务表、不复制业务SQL、不建立替代更新入口，不创建备份文件。
