# Docker Desktop D5 真实分支与应用恢复验收

日期：2026-11-03（北京时间）。用户在跨仓证据复核后明确要求「完成 Docker Desktop D5」。本记录拥有本次运行证据，任务状态见[已归档 Task](../../archive/tasks/2026-10-05-docker-desktop-start.md#d5-completion-20261103)，[现行规格](../../specs/2026-10-05-docker-desktop-start.md)继续维护。

## 输入与执行边界

初始 Docker context 为 `desktop-linux`，端点为 `unix:///Users/yzin/.docker/run/docker.sock`。真实 `docker info` 退出 1，Docker Desktop 状态亦无法取得；宿主可用空间约 261 GiB，没有可见 Docker 后台及活动 update/sync-code 进程。引擎不可用时不能现场读取业务库，因此复用主仓 10-31 保留的旧记录与来源基线，恢复后逐项核对。

本次验证真实 daemon 不可连接条件下的强制分支执行链。初态没有可见残留后台进程，未重新制造 10-25 的 ENOSPC，也不将本次结论解释为该故障成因再次复现。既有脚本及测试源码未修改，原 11 项命令替身证据按未变输入复用。

## 维护入口与结果

执行目录均为 `/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`，命令前缀使用 `rtk proxy`：

| 入口与非敏感参数 | 结果 |
| --- | --- |
| `node scripts/docker-desktop-recover.mjs --execute --force-stop` | 退出 0；内部先取得真实 info 失败，再执行一次 `desktop stop --force --timeout 45` 和一次 `desktop start --timeout 45`，两步均退出 0；最后 info 成功，`forcedStop=true`、`restarted=true`、`engineReady=true` |
| `DEV_DATABASE_MODE=check REUSE_THESIS_LEDGER_IMAGE_ID=sha256:1654b11a1f4b39c94bfff670dec539b46e373af427cd8ea14c88da80a3622b45 ./scripts/update.sh thesis-ledger` | 退出 0；复用原已验镜像，正式恢复依赖、执行结构 check 并重建 Server／Worker，五服务 healthy，未构建应用镜像 |
| `./scripts/sync-code.sh thesis-ledger` | 退出 0；补回原镜像之上的后续代码快更，兼容性检查通过；Server／Worker 各 725 个 JS／JSON 编译文件与当前已验证宿主构建摘要一致，镜像 ID 保持 |

强制分支完成于 `2026-11-03T07:25:01.518Z`。独立 `docker info` 取得引擎版本 `29.9.2`。正式镜像重建会丢失可写层快更；对原 713 文件基线核对发现两角色各 19 个差异，随后通过正式同步恢复。当前宿主相对该旧基线的一项实验超时模块变化来自已经完成的 LM Studio 评估输入，原文件与测试证据按实际版本保留。

## 应用与持久状态

- Server `/api/v1/health` 与 DSA `/health` 均为 HTTP 200；Server 的 database、Redis、DSA 均 healthy，结构 head 为 `20261023010000_report_metadata_snapshots`。Server／Worker／DSA 启动日志的缺表、缺列及 Prisma P2021/P2022 命中均为 0。
- 99 条 BacktestJob 为 84 succeeded／15 failed，26 条 AiRun 为 7 succeeded／19 failed；无 queued/running，未创建新模型任务。12 张业务表中原 601 条记录逐 ID、完整 JSONB 摘要一致，快更恢复后再次核对仍完全一致。
- 通过研究专用 `/api/v1/research/reports/:id`、正确的 scoped/shadow 定位读取 `805cc84a…`、`18b58cbe…` 两条成功 V2 报告及 G3-D25 `b207e5e5…` 失败记录，均返回 200，原成功／失败状态保持。初次误选的通用优化任务不属于研究专用接口，原错误定位回执保留，不计为研究读取验收。
- 41 张主仓保护表按原摘要算法核对，取证时 36 张数量及完整摘要一致，包含 Ledger、账户、交易、ProviderConfig、研究观察和 AI 调用事实。旧的 21 条 PortfolioSnapshot、1,572 条 AccountValuationPoint、684 条 ProviderHealthCheck 经原时钟截取后摘要仍一致；此后的快照和估值点均早于本次恢复创建。

## 正常启动产生的元数据

CatalogReadinessService 的现行 `onModuleInit` 会异步执行目录协调，提供方健康检查也按原配置恢复。取证时 Instrument 为 35,922 条：相对 10-31 基线新增 8 条，其中本次启动新增 2 条，并更新 416 条原标的元数据。ProviderHealth 更新了当前观察状态；ProviderHealthCheck 相对旧基线的增量中，本次启动时已新增 1 条。

上述变化与冻结业务记录分别保留。本次没有声称整库或全部 Instrument 逐字节不变，也没有为追求摘要相同回写旧状态。验收操作仅发出本机只读 GET、SQL 和文件读取，未主动提交模型生成或外部来源业务请求；原后台目录及健康活动不作为新实源资格验收。

## 来源、配置与挂载

- DSA SQLite `integrity_check=ok`；政策状态、政策历史、Provider 配置／密文和 tombstone 四张保护表的数量及摘要与原基线一致。9 条准入记录全文摘要与 12 份已封存来源原件的字节摘要均一致，未延长原准入时效。
- 当前 `.env` 摘要保持；原验收登记的功能开关全部一致，`AI_RESEARCH_V2_WRITES_ENABLED=true` 保留当前值。10-25 的 V2 关闭及正式更新证据继续由[原 G3-D25 记录](../../../../thesis-ledger/docs/tasks/evidence/2026-10-25-g3-single-formal-response.md)持有。
- 五个 ThesisLedger 容器的镜像与完整挂载保持；仅 Server／Worker 经正式入口重建。环境列表摘要发生变化，因此配置保全采用 `.env`、既有功能开关及 ProviderConfig 全文摘要核对，不将列表摘要解释为逐字段证明。正式应用恢复前后，另外两个 Skill Atlas 容器的 ID、镜像、挂载和环境保持，且均健康。
- 没有删库、清卷或重置业务数据。三仓 HEAD／Git 索引及本次起点登记的全部非文档源码／配置文件保持；未暂存、提交或推送。

## 最终复核与证据位置

D5 的真实强制执行链、独立引擎检查、正式应用恢复、旧记录／来源／挂载核对均通过。D1～D5 完成，任务归档，现行 Spec 保留；旧 ENOSPC、未命中分支及模型失败历史继续保留。没有重复执行强制恢复，没有重新构建应用镜像，也没有重跑输入未变的单元测试。

原始回执位于主仓忽略目录 `.recovery-artifacts/docker-desktop-d5-20261103/`：`force-recovery.json`、`formal-update.log`、`code-sync.log`、`restored-code-proof.json`、`database-state.json`、`business-after-sync.json`、`scoped-research-readback.json`、`dsa-table-comparison.json`、`dsa-admissions-files.json`、`container-protection.json`、`final-source-protection.json` 和 `execution-summary.json`。文档链接、任务状态及最终保护核对由该目录 `final-review.json` 汇总。
