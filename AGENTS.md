# 项目 Agent 规则

## Docker 操作入口

- 执行任何 Docker 操作前，必须读取并遵守 [`../AGENTS.md`](../AGENTS.md) 的「Docker 操作入口强制约束」。所有状态变更只能通过仓库维护的脚本执行；只读检查除外。该约束同时适用于子代理、故障恢复和隔离测试，不能用临时包装命令绕过。
- 目标更新使用 `./scripts/sync-code.sh [all|dsa|thesis-ledger]` 或 `./scripts/update.sh [all|dsa|thesis-ledger]`，按工作区规则判断适用条件；禁止直接调用脚本内部函数跳过正式入口的空间、并发、兼容性和数据库门禁。
- 缺少专用运维入口时，先在 `scripts/` 补充维护脚本与必要验证，再执行；不得直接修改 Docker 运行态作为临时补救。
- 空间不足时默认自动清理缓存及未引用镜像；20/18 GiB 仅为参考目标，不因未达标反复阻塞任务。实际 ENOSPC 或清理后实测零空间由 `update.sh` 自动执行一次保卷恢复，保留命名/匿名卷及其挂载，必要时重建整个本开发项目。闲置镜像独立维护使用 `node scripts/docker-space-images.mjs all --all-unused --protect <完整空间探针镜像ID>` 预览，添加 `--apply` 执行；保留运行容器镜像和空间探针，不清理 volumes。
- 仅低于参考值时不得清空全部热缓存和基础镜像。普通中间层在每个应用完成后回收，依赖缓存保留；新服务健康后释放旧基线并收敛历史镜像。显式保卷重建使用同一入口 `UPDATE_SPACE_MODE=compact ./scripts/update.sh all`，默认 auto，不另建更新入口；中断后继续读取原恢复挂载文件。
