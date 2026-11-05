# 已验 Server 镜像恢复的依赖就绪验收记录

## 修复与定向检查

镜像复用分支在重建 Server／Worker 前，先以同一 Compose 配置执行 `up -d --no-build --pull never postgres redis dsa`，再检查三个依赖健康；失败时不启动消费者。默认构建分支、镜像身份校验、数据库 check 模式及两个消费者使用同一镜像的约束保持。

`bash scripts/reuse-thesis-ledger-image.test.sh` 与相关脚本 `bash -n` 通过，覆盖默认构建、双阶段镜像校验、最小目标、依赖恢复顺序、每个依赖及启动失败收敛、消费者健康顺序。该测试使用 shell mock，不变更 Docker。

## 正式入口与运行态

执行 `REUSE_THESIS_LEDGER_IMAGE_ID=sha256:df411ebf2eb06f93d083886c9d74633a9685bf02fb2849f80c39b1ab684d60a4 ./scripts/update.sh thesis-ledger`，默认保留数据 check 模式通过，入口退出 0。PostgreSQL、Redis、DSA、Server、Worker 均健康；两个消费者保持明确的同一已验镜像 ID。

[正式恢复日志](../../../../thesis-ledger/.recovery-artifacts/cloudflare-catalog-fix-20261026/restore-update.log)与[最终保护反读](../../../../thesis-ledger/.recovery-artifacts/cloudflare-catalog-fix-20261026/verification.json)记录五个服务健康、原镜像及按挂载目标规范化后的全部挂载一致，业务表、DSA 控制、配置和凭据摘要保持。未清理镜像或 volume，没有 stage 或 commit。

该次恢复只使用原镜像。后续目录源码通过另一次 `sync-code.sh thesis-ledger` 应用到可写层，功能及 Server／Worker／Schema 一致性证据由[主仓目录验收](../../../../thesis-ledger/docs/tasks/evidence/2026-10-26-cloudflare-model-catalog.md)维护，不将其当作镜像更新证据。
