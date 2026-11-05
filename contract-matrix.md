# ThesisLedger 三仓契约矩阵

`compatibility.json` 是机器可检查的版本组合；本页说明其运行和验收含义。2026-09-29 当前源码的 ThesisLedger 专属 DSA Data 与 Control 合同均为 V3，DSA 原生 `/api/v1` 不属于该版本替换范围。

| 层 | 当前合同 | 验收边界 |
| --- | --- | --- |
| DSA Data | `/api/v3/thesis-ledger/*`；Data Token；精确 RouteKey、完整窗口、来源与时间证据 | 本地协议和路由测试已通过；目标正向读取及各来源真实准入逐项核验 |
| DSA Control | `/api/v3/thesis-ledger/control/*`；独立 Control Token；V3 握手、Provider、Policy、目录与 Job | 无效凭据、旧握手、修订及目录完整性由协议测试覆盖；目标配置与撤销另验 |
| Server 与 Worker | 当前 Run 状态机、V3 冻结 Snapshot、数据库 attempt/CAS；队列不作为业务终态 | 同一源码与结构下验证创建、投递、领取、终态、重放、重试与取消 |
| PostgreSQL | 主仓全部顺序 migration 与 raw-owned 表共同定义当前结构 | 保留数据升级须核对备份、结构 head、预期表、权限及消费者日志 |
| API Client 与 Desktop | 当前 Market、Backtest、Ledger 公开合同；来源与失败原因按 Server 实际结果展示 | 类型和本地交互测试之外，仍需目标浏览器或 Electron 操作与 Network/Console 证据 |

## 发布门禁

1. `node scripts/check-compatibility.mjs` 核对唯一的 Data/Control V3 组合、版本与发布要求。共享契约先在主仓构建。
2. `bash scripts/market-v3-contract-test.sh` 只验证 Data/Control 协议、独立鉴权、V3 握手和完整精确目录，不请求真实行情。`./scripts/contract-test.sh` 在此基础上要求股票/ETF 报价、基金数据及固定 ETF qfq 窗口正向读取；来源未准入时不能通过业务门禁。
3. 根据变更选择官方 `scripts/sync-code.sh` 或 `scripts/update.sh`，核对实际镜像或可写层代码、全部 migration、结构与权限、Server/Worker/DSA 健康。快更不能作为镜像更新证据。
4. 按主仓多来源回测 Task 逐项完成真实 Provider、普通回测、严格 PIT、AI、客户端与故障恢复验收。协议、构建和本地测试均不能替代目标业务证据。

部署顺序为共享契约与 DSA、保留数据的数据库结构升级、Server 与全部 Worker、最后客户端。需要结构或运行时依赖变更时，使用官方 `update.sh`；默认保留数据，显式升级模式须精确确认目标。任何阶段失败均保留数据库卷和原始错误，不把未完成更新记作已部署。

## 暂停与回退

暂停新研究创建时，先保存当前 Desired/Effective 修订、目录 generation、镜像摘要和结构 head 的诊断摘要，不记录凭据；通过当前 Policy 入口应用明确的禁用修订，并确认 Effective 已更新。已运行任务如需取消，使用业务取消入口并核对 PostgreSQL 终态，不能直接改队列或数据库。

回退候选须有可追溯镜像摘要，并在隔离环境证明它能读取当前数据库结构与必要 Snapshot 格式；不相容候选不得部署。隔离恢复应同时保持 PostgreSQL 与 DSA SQLite 的目录状态一致。官方更新入口固定可用的回退镜像标签，但标签本身不证明候选相容，也不替代正式备份。没有完成状态保真的回退演练时，回退门禁保持开放。

2026-09-27 的保留数据升级及协议检查属于当时的目标版本证据。2026-09-29 当前源码更新因宿主磁盘耗尽在主仓镜像构建阶段中断，数据库升级与服务启动未发生；详见主仓[失败边界](../thesis-ledger/docs/evidence/2026-09-29-canonical-update-all-disk-blocked.md)。当前组合的目标部署与业务门禁仍未通过。
