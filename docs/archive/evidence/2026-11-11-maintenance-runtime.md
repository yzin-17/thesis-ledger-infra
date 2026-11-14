# 维护运行层收敛验收

日期：2026-11-11。状态：已通过。[任务](../tasks/2026-11-11-maintenance-runtime.md)。

## 实现与职责

- `runtime/lock.mjs` 是锁路径、创建、释放与祖先校验的唯一实现。异步和同步入口共用生命周期，PID 改变时拒绝删除锁；同步入口返回 Promise 时仍等待终态释放。
- `runtime/process.mjs` 提供同步和异步进程适配，统一 argv、环境与错误对象。同步支持 Buffer 和文件描述符流，短命令默认 30 秒，长备份显式使用原有超时；异步部署保持取消、派生进程终止和清理语义。错误中的原始输出供受控诊断使用，默认异常打印不展示备份内容。
- `runtime/docker.mjs` 固定经验证的本地 Unix context，提供 Docker/Compose、维护锁和健康等待。镜像维护、运行态恢复、既有容器启动、Desktop、备份及相关业务消费者均消费此运行层；删除旧独立维护锁实现。
- 研究恢复资源、归档保护、回执及备份格式/隔离库名由 ThesisLedger 维护，SQLite 恢复文件名与完整性由 DSA 维护。infra 只接收声明的格式、连接目标和业务保护合同，原备份格式不变。删除 infra 的恢复演练文件与内嵌 Python。
- 容量模块仅提供实现，正式 Shell 入口通过统一 CLI 单向调用；保留 7 个部署入口。删除无调用路径函数，更新当前文档与应用锁导入；历史执行命令保持。

## 受控验证

宿主 Node.js `24.22.2`、pnpm `11.9.0`，应用 Python 测试使用 DSA 现有环境。

| 检查 | 结果 |
| --- | --- |
| infra `pnpm test` | 最终 28 文件通过，94 项通过、1 项默认跳过，共 95 项 |
| infra `pnpm test:docker-readonly` | 5 项通过，包含上述默认跳过的真实配置/挂载合并场景 |
| infra `pnpm check` | 运行时、实现归属/依赖、兼容门禁全部通过 |
| 主仓 `node --test scripts/local-runtime/*.test.mjs` | 82 项通过，含备份格式、回执、恶意归档和成功恢复 |
| DSA `restore-sqlite.test.py` | 2 项通过，涵盖原字节保持、拒绝覆盖、特殊路径与坏副本 |
| DSA 快更/恢复入口及目标包装定向 | 18 项通过，真实祖先、进程层级与原受控目标保护保持 |
| Server `test/backtest/price-research-snapshot.test.ts` | 3 项通过，见下述构建失败恢复 |

锁测试重现了原先归属改变后误删的问题；现同步/异步均失败且保留锁。二进制样本包含非法 UTF-8 字节，捕获和文件流均逐字节保持；受控 Docker 适配验证环境 context 改变后仍使用原 context，远端拒绝。业务门禁覆盖已发现的 SQLite 与 F01 私有标识，职责仍须结合实际调用链核对。

## 正式入口与运行态

执行目录：`/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`。PATH 优先使用上述真实 Node、pnpm 和 Docker CLI 安装目录。

1. `node scripts/docker-space-images.mjs all`：只读预览退出 0，context 为 `desktop-linux`，没有删除操作。
2. `node scripts/resume-existing-development.mjs --confirm=thesis-ledger-dev`：退出 0，5 个原服务已运行并健康；没有创建或重建容器。
3. `HEALTH_TIMEOUT_SECONDS=180 ./scripts/sync-code.sh all`：首次退出 1。主仓已有未提交测试 `apps/server/test/backtest/price-research-snapshot.test.ts` 直接访问可能不存在的 `totalReturn`，宿主构建报 TS18048；失败发生在容器写入前。
4. 将该断言改为可选属性访问，仍要求状态等于 `available`，没有放宽存在性校验；对应 3 项测试通过。保持原有未提交内容后，以同一正式快更命令重试，退出 0。宿主构建、三服务替换、重启、健康及镜像身份门禁通过。
5. 经 `scripts/infra.mjs locked` 调用 `dsa-runtime-recovery.mjs snapshot`：退出 0，真实共用锁与祖先路径、应用快照合同、原镜像及挂载保存通过；没有执行恢复重建。

快更显式使用 `npm_config_registry`、`pnpm_config_registry`、`COREPACK_NPM_REGISTRY` 均为 `https://registry.npmmirror.com`。未触发完整镜像构建，应用镜像和数据库结构输入没有由本轮更改。

独立状态见[运行前](2026-11-11-maintenance-runtime-before.json)和[运行后](2026-11-11-maintenance-runtime-after.json)：7 张表摘要、84 条成功回测结果摘要、结构 head、全部命名/匿名卷挂载、5 个服务镜像与容器 ID 逐项相同；Server 与 DSA 健康接口均返回 200，全部服务健康。最终维护锁已释放。新备份连接接口另以主仓保护 SQL 在真实 PostgreSQL 上只读验证通过。

未执行共享恢复故障注入、扩容、清库、Provider 实读、新闻准入、模型调用、Git 提交或推送。应用 Python 留在应用维护范围；infra 的生产进程启动仅由共用进程模块实现。
