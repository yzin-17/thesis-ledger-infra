# 本地 Docker 构建空间保护

当前维护合同。历史实施及原始约束见[历史规格](../archive/specs/2026-09-08-docker-build-space-guard.md)；本次维护收敛见[规格](2026-11-11-local-maintenance-scope.md)。

## 空间与互斥

- 正式 update.sh 使用当前本地 Unix context 的 docker driver，拒绝远端端点、未知空间和活动构建；按用户及 daemon 地址持有更新锁。
- 默认 BuildKit 缓存最大目标 8gb、保留底线 4gb；Docker 18gb 与宿主 20gb 为空闲参考目标，实测有正余量即可继续，不能把未知值视为可用。
- 常规空间整备维护缓存、清理无标签镜像及所选应用未引用的开发标签，并按需回收 Docker Desktop 已空闲块。镜像保护依据容器引用、空间探针、显式完整 ID 与本轮产物；BUILD_PROTECTED_IMAGES 使用完整 SHA256 ID。
- 默认保护其他带标签镜像；all-unused 显式维护或保卷恢复可以处理所有未受保护的未引用镜像。执行共用更新锁，候选和活动构建逐次重查，非强制删除，不操作卷。

## 构建与保卷恢复

- 应用维护 Dockerfile、下载源、依赖缓存及 SDK 构建；infra 通过 Compose 参数和构建上下文消费。构建逐应用执行，完成一个应用后回收普通中间层，保留命名依赖缓存。
- 普通构建失败保留缓存后重试一次；实际零余量/ENOSPC 或显式 compact 最多执行一次本项目保卷恢复，不扩大为其他项目容器操作。
- 停机前持久保存全部命名/匿名卷挂载并预取固定 SDK 源；恢复失败保留配置及中断标记，不清理卷或宿主目录。恢复扩大到 all，经数据库结构检查和健康检查后启动。
- REPAIR_BUILD_CACHE_ON_NO_SPACE=false 关闭自动清理与保卷恢复；UPDATE_SPACE_MODE=compact 与关闭清理冲突时拒绝。
- 新服务健康后维护缓存并复测空闲块。未达参考目标不重建健康服务；实际失败保留具体根因。

定向验证包括 build-space、build-space-lifecycle、reinstall-preserving-volumes、docker-reinstall-plan、docker-space-images 和 docker-maintenance-lock 测试。
