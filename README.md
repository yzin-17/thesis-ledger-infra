# ThesisLedger 开发栈

本仓库只负责把三个独立仓库串联起来：

- `../thesis-ledger`：主系统源码。
- `../daily-stock-analysis`：DSA Fork 及其 ThesisLedger Data/Control V3 接口。
- `thesis-ledger-infra`：固定镜像默认配置、源码构建 override 和黑盒契约测试入口。

父目录不纳入 Git。脚本只会 clone 缺失仓库；如果仓库已经存在，不会自动切换分支、拉取或修改工作树。

本仓库是唯一的 Docker 编排入口，Compose 项目名固定为 `thesis-ledger-dev`。`compose.yml` 是基础配置，`compose.dev.yml` 是源码构建覆盖；两者共同组成同一个开发栈，不是两套独立服务。主仓库不再单独启动 Docker。

PostgreSQL 只负责进程存活检查；开发数据库结构由主仓的结构执行器统一发现并以 psql 在目标库内重建。执行器会按目录排序执行全部 migration SQL、包含 `raw-owned-tables.json` 登记表、初始化 app role 权限并写入当前 head。`POSTGRES_OWNER_USER` 与 `POSTGRES_APP_USER` 必须是不同的非空角色；角色校验失败会使重建失败。应用容器只接收 `POSTGRES_APP_USER` 连接串，不会获得 owner 连接串。现有持久卷不会被自动重置；默认更新只做结构预检，结构不匹配时阻止新版应用启动。只有显式设置 `DEV_DATABASE_MODE=rebuild`、`DEV_DATABASE_ALLOW_DATA_LOSS=true` 和精确的 `DEV_DATABASE_CONFIRM=thesis-ledger-dev/<数据库名>` 才会清空目标 `public` schema，且不会删除 PostgreSQL volume。

## AI 服务配置

AI 服务的地址、模型、API Key、用途与默认模型统一在 ThesisLedger 的 Provider 页面管理，配置由 Server 校验并加密保存到数据库。Compose 不再透传 Provider 环境配置或自动演示开关。

从旧环境配置升级前，先通过页面录入对应服务；仅存在于旧 `.env` 中的 Provider 升级后不会加载。数据库已有配置、凭证与历史记录保留，不自动导入、删除或改写实际 `.env`。`CREDENTIAL_ENCRYPTION_KEY`、数据库连接、超时、研究预算策略和执行开关继续由部署环境管理；保留原加密主密钥以读取已有凭证。

## 已有个股新闻准入的日期起点扩展

`scripts/nvidia-news-admission.mjs` 的首次新增行为保持不变。只有明确授权扩大原范围时，才对原 `600519.SH` 的 `--source=akshare-eastmoney` 或 `--source=hithink-timeline` 使用 `--extend-existing`，并传入 `--expected-record-version=<旧版本>`、`--expected-record-sha256=<完整旧行的SHA-256>`。旧行摘要采用 Python `json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':'))` 的 UTF-8 字节计算。

仍需提供来源专属的 `--confirm`、正式单页实读得到的 `--feed`、`--sha256`、`--observed-at`、提前后的 `--start`、原 `--end` 和 `--recorded-by`。范围扩展不能传 `--valid-hours`；日期起点最多回看 7 天，原截止日、生效／到期日、来源与凭据版本保持。默认仅生成计划，`--apply` 执行，随后用同一输入及原旧版本／摘要加 `--verify` 只读核验；不同时使用 `--apply` 与 `--verify`。

该入口在原项目锁及 SQLite 写事务内核对精确目标、旧版本和完整摘要、有效期及启用／凭据状态。新证据包含完整旧准入及摘要，原证据文件不覆盖。状态漂移即拒绝且不自动重试；不修改来源启停、政策路由或业务表。

## 初始化

```bash
./scripts/bootstrap.sh
cp .env.example .env
```

`.env` 中的两个应用镜像必须填写首次发布后记录的 GHCR digest，不能只填写可漂移的 tag。当前示例使用占位 digest；在镜像尚未发布前，默认镜像栈不能启动。

开发数据库首次初始化或结构不匹配时，使用源码更新脚本显式重建：

```bash
DEV_DATABASE_MODE=rebuild \
DEV_DATABASE_ALLOW_DATA_LOSS=true \
DEV_DATABASE_CONFIRM=thesis-ledger-dev/thesis_ledger \
  ./scripts/update.sh
```

`DEV_DATABASE_CONFIRM` 必须使用 Compose 项目名和实际数据库名；脚本会先完成镜像构建和目标检查，再停止 Server/Worker 并执行重建。未设置 `DEV_DATABASE_MODE` 时默认只校验结构，不执行破坏性 SQL。

## 固定镜像栈

```bash
docker compose --env-file .env up -d
```

该栈使用独立的 PostgreSQL/Redis/DSA SQLite 卷，并以独立的 `THESIS_LEDGER_DSA_TOKEN` 和 `THESIS_LEDGER_CONTROL_TOKEN` 区分数据消费与控制面。确定性 fixture 模式默认开启，是 Contract Test 的阻断门槛；在线 Provider smoke test 由 DSA 仓库单独安排。

## 同级源码栈

```bash
docker compose --env-file .env -f compose.yml -f compose.dev.yml up --build -d
```

`compose.dev.yml` 配置本机源码构建及 Longbridge 本机授权回调，不会把 DSA 源码复制到主仓库。页面凭证与授权部署见[数据源页面凭证与本机授权](docs/provider-credentials.md)。

### 一键更新源码栈

```bash
./scripts/update.sh
```

脚本默认使用 `.env`；不存在时回退到 `.env.example`。临时 Dockerfile 使用 `thesis-ledger-local-*` 基础镜像别名、命名依赖缓存，并仅为本次构建设置 Aliyun Debian mirror 与 npmmirror。基础镜像缺失时才必要拉取，构建前后按默认 `8gb` 最大缓存、`18gb` 清理参考空闲空间和 `4gb` 缓存底线请求 GC；`all` 逐个构建应用，避免冷构建峰值叠加。普通构建失败保留缓存重试一次，真实空间不足则自动保卷恢复一次；Compose 启动或健康检查失败不再次构建。临时 Dockerfile 与构建 override 退出时删除，保卷恢复挂载配置持久保存；共享 Dockerfile 不变。只修改一个源码仓库时可缩小范围：

```bash
./scripts/update.sh dsa
./scripts/update.sh thesis-ledger
```

更新入口在拉取前整备并实测空间。Docker `18gb`、宿主 `20gb` 是清理参考目标，未达到目标但实测仍有可用空间时继续构建；仅未达参考值不会清空全部热缓存和基础镜像。构建一个应用后先回收普通中间层，保留命名依赖缓存，减少两个应用构建占用叠加。真实 ENOSPC 或零余量时自动执行一次本开发项目保卷重装，记录并接回命名和匿名卷，再构建全部应用并通过既有数据库检查后启动；新服务健康后解除旧基线保护，按实际容量退役旧回滚并回收空闲块。同一 daemon 更新互斥，未知余量或活动构建停止。自定义 Docker 磁盘位置须设置 `BUILD_SPACE_HOST_PATH`；更多说明见[空间维护](docs/docker-update-workflow.md#buildkit-缓存空间维护)。

默认 `UPDATE_SPACE_MODE=auto`。明确需要仅保留卷重新安装时，使用同一正式入口：

```bash
DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=compact ./scripts/update.sh all
```

compact 会停止本开发项目、清理其容器/网络和全部未引用镜像，再重建服务；保留所有命名/匿名卷及挂载，不清库。固定 SDK 源在停机前预取，失败时不会先停服务；与 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 冲突时明确拒绝。

成功更新并通过目标健康检查后，默认每个服务保留两个历史回滚镜像；当前容器、更新前基线与显式保护对象优先保留。数量配置、只读预览和维护入口见[回滚镜像保留](docs/docker-update-workflow.md#回滚镜像数量保留)。

当前镜像依赖与数据库结构均未变化、只需要更新应用代码时，可以使用快速入口：

```bash
./scripts/sync-code.sh
./scripts/sync-code.sh dsa
./scripts/sync-code.sh thesis-ledger
```

该脚本把数据代码或宿主构建产物同步到现有容器，重启并核对同一镜像。DSA 使用 `dsa-data-runtime-v1` 合同，只装配数据入口、`api/`、`data_provider/`、`src/` 及指定数据脚本；依赖、原生 SDK、Dockerfile、存储结构输入、启动命令和代码挂载均须兼容。旧镜像须先通过 `update.sh dsa` 完整更新。快更位于容器可写层，重建后恢复镜像内代码。详见[Docker 更新流程](docs/docker-update-workflow.md#快速仅代码更新)。

完整更新会在空间整备和构建前记录 DSA 的不可变镜像、原 API 命令及全部实际挂载，并持续保留匿名卷映射。需要恢复镜像基线时，执行 `bash scripts/restore-dsa.sh <更新前快照.json>`；入口共用更新锁，只重建 DSA，核对原镜像、命令、挂载及健康。快照仅保存环境文件摘要；恢复时要求原环境、镜像和所有挂载仍可用。详见[DSA 运行态恢复](docs/docker-update-workflow.md#dsa-运行态恢复)。

如需刷新 PostgreSQL 和 Redis 的服务镜像，可显式开启：

```bash
ENV_FILE=.env PULL_SERVICE_IMAGES=true HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh
```

如需拉取官方应用基础镜像并刷新本地别名，可显式开启：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

脚本不会执行 `docker compose down -v`，不会删除或重置 PostgreSQL、Redis 和 DSA SQLite 数据卷；如果宿主机端口被其他进程占用，脚本会报告 Compose 状态并退出，不会自动停止占用者。BuildKit cache 空间维护默认开启，可用 `BUILD_CACHE_MAX_USED_SPACE`、`BUILD_CACHE_MIN_FREE_SPACE` 和 `BUILD_CACHE_RESERVED_SPACE` 调整；如需保留缓存现场，可设置 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 关闭构建前后维护与空间不足自动修复。

常规历史保留数 `ROLLBACK_IMAGE_KEEP_COUNT` 默认2；紧张期 `BUILD_SPACE_ROLLBACK_KEEP_COUNT` 默认0，逐个退役并复测。真实零余量/ENOSPC 或显式 compact 才清理全部未引用镜像，包括可重新下载的基础镜像；显式保护、空间探针、显式复用和本轮完成产物保留。保卷重装释放本项目旧容器和旧基线，保留全部 volumes；恢复挂载写入被忽略的 `.maintenance-backups/docker-space-recovery/compose.json`，后续更新自动沿用。恢复中断时保留 `incomplete` 标记，下次正式更新自动扩大为 all 继续恢复。固定 SDK 源在 `.maintenance-backups/longbridge-source/` 按构建脚本摘要保留，复用时继续验证固定 revision、Git 对象及干净工作树。更新参数通过 Shell 环境传入，不从 Compose 的 `.env` 读取。

固定镜像栈和同级源码栈复用 `thesis-ledger-postgres-data`、`thesis-ledger-redis-data` 和 `thesis-ledger-dsa-data` 三个持久化卷；停止服务时不要添加 `-v`。DSA SQLite 卷保存 ProviderConfig、Effective Policy、Catalog generation、Job 和诊断，不能与主系统数据库共享。

首次启动前，如果卷尚不存在，先创建一次：

```bash
docker volume create thesis-ledger-postgres-data
docker volume create thesis-ledger-redis-data
docker volume create thesis-ledger-dsa-data
```

## 当前研究状态备份与恢复

当前开发目标的数据库、DSA状态和冻结制品通过维护脚本备份。目录必须为本仓`.maintenance-backups/`或主仓`.recovery-artifacts/`下的全新绝对路径；备份绑定实际镜像和结构head，恢复前校验载荷摘要，镜像须仍在本机可访问。

```sh
node scripts/research-state-backup.mjs backup --target thesis-ledger-dev --output <全新私有备份绝对目录>
node scripts/research-state-backup.mjs verify --target thesis-ledger-dev --output <已有备份绝对目录>
node scripts/research-state-rehearse.mjs --bundle <备份绝对目录> --confirm-isolated --run=<成功V3任务ID>
```

恢复入口建立隔离数据库与数据副本，默认核验后自动清理。需要取用副本时增加`--retain-output=<全新私有恢复目录>`；成功输出恢复目录、隔离容器和所有权回执，用`node scripts/research-state-rehearse.mjs --cleanup-receipt <回执绝对路径> --confirm-isolated`清理。每次选1～5条成功V3代表任务，重复`--run=`指定；不覆盖当前库或卷。详见[规格](docs/specs/2026-10-08-current-state-recovery.md)和[真实验收](docs/archive/tasks/2026-10-08-current-state-recovery.md)。

观察存储的 G4a 验收使用 `node scripts/research-observation-retention.mjs --target thesis-ledger-dev --upgrade-receipt <正式升级回执目录> --compatible-baseline current --output <全新私有备份绝对目录>`。入口先核对当前源码、镜像和正式升级回执，再备份目标，在自有隔离库追加三个明确标记的观察版本，归档并实际加载对应镜像，恢复非空数据库副本并验证只读 HTTP/SDK。`current` 将当前实际通过双读和观察读取的镜像登记为恢复版本；也可传入已有且镜像仍可用的双读基线目录。镜像归档和数据库保留，隔离容器自动清理；不修改目标业务或配置，不调用模型，也不替代实源价格及 G4b 验收。

## 研究 V2 写入发布开关

Server 的 `AI_RESEARCH_V2_WRITES_ENABLED` 默认 false；只有显式设为 true 才开放新的 V2 研究提交。该开关独立于研究执行和策略开关，不传给 Worker，不影响原双版本读取。对应主仓的[研究规格](../thesis-ledger/docs/specs/2026-10-18-research-evidence-evolution.md)与[G3 证据](../thesis-ledger/docs/tasks/evidence/2026-10-23-research-g3.md)。

开启前核对双读/恢复基线、严格匹配的研究生成 V2 用途和明确的业务调用预算，通过 `AI_RESEARCH_V2_WRITES_ENABLED=true DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=auto ./scripts/update.sh thesis-ledger` 受控部署，并核对目标 `/api/v1/research/capabilities`。单次验收结束后，按原授权通过同一正式入口显式恢复 false；其他已有开关、来源及业务数据保持。

定向合同检查为 `bash scripts/ai-provider-contract.test.sh`，只渲染 Compose，覆盖默认关闭、显式关闭、独立开启及 Worker 配置隔离。源码通过不代表目标已部署或 G3 实源已通过，实际状态由上述证据维护。

已完成镜像和模块验收后，配置恢复／容器重建可复用该不可变镜像：

```bash
REUSE_THESIS_LEDGER_IMAGE_ID="${VERIFIED_IMAGE_ID:?请先填写已验完整镜像ID}" ./scripts/update.sh thesis-ledger
```

该显式模式仅接受最小thesis-ledger目标，并核对当前开发标签、项目／服务及运行形态；锁、空间、镜像保护、数据库check和健康门禁保持。它跳过构建，以同一镜像强制重建Server／Worker且不重建依赖服务，不同步宿主新源码。原卷和私有trace保留，实际反读仍须验收。详见[镜像复用契约](docs/specs/2026-10-25-update-reuse-thesis-ledger-image.md)。

## 研报元数据的长期按需读取

对应主仓的[已完成长期按需任务](../thesis-ledger/docs/archive/tasks/2026-10-23-research-report-on-demand.md)与[现行规格](../thesis-ledger/docs/specs/2026-10-23-research-report-on-demand.md)。`CN/STOCK/RESEARCH_REPORT_METADATA -> akshare/eastmoney` 使用已有显式政策路由和来源启停判定就绪，当前已支持的全部沪深股票可按需查询；不再绑定固定标的、日期窗口或 24 小时验收记录。一次只读一个目录股票的一页，日期可选，不自动抓取。停用来源或移除该路由即可撤销后续读取。

Server 的 `POST /api/market-data/research-report-metadata/collect` 接收已有 `instrumentId` 及有界分页和请求预算；省略 `start`、`end` 时不补隐藏筛选，来源适配器将协议必需的 `beginTime/endTime` 传空字符串。新响应为 `research-report-metadata-v2`，`historyComplete=false`；旧 v1 快照仍可通过本地历史入口读取。无日期筛选不代表上游提供全部历史。

保留数据的正式完整更新及目标验收已通过：`600519.SH` 无日期、第 1 页/2 条/3000 ms 采集返回 201，取得 2 条、来源总数 772；新旧历史读取 200，旧快照摘要保持。原来源启停、20 条路由、11 张受保护业务表完整摘要及全部挂载一致，5 个服务健康；用户确认的预期并发修改保留。[完整证据](../thesis-ledger/docs/tasks/evidence/2026-10-23-research-report-on-demand.md)记录镜像、时间与保护范围。

### 首次临时验收记录（历史）

[首次验收任务](../thesis-ledger/docs/archive/tasks/2026-10-23-research-report-metadata.md)曾使用下述独立维护入口，默认仅输出计划。其范围和有效期只属于当时的验收证据，脚本与证据保留，不用于当前业务启用或日常续期：

```bash
node scripts/report-metadata-admission.mjs \
  --symbol=600519.SH --start=2026-08-01 --end=2026-10-23 \
  --confirm=thesis-ledger-dev/akshare/eastmoney/600519.SH/2026-08-01/2026-10-23
```

当时通过 `--collect` 进行第 1 页、2 条、3000 ms 的标准绑定读取，在原数据卷保存最小证据；随后显式应用 24 小时的首次准入并只读核验。这些操作已完成，长期使用无需重复执行。

历史应用要求 30 分钟内的同版本证据及首次写入，不允许覆盖或续期，也不初始化数据库。原记录和 SHA-256 证据继续保留；它到期后不影响新的长期按需读取。原业务路由和来源启停保持不变。

定向检查：

```bash
node --test scripts/report-metadata-admission.test.mjs
PYTHONPATH=../daily-stock-analysis ../daily-stock-analysis/.venv/bin/python -B scripts/report-metadata-admission.test.py
```

### Server 重启留存验收

`node scripts/restart-server-for-acceptance.mjs --confirm=thesis-ledger-dev/thesis-ledger --image=<当前完整镜像ID>` 默认只输出计划。添加 `--apply` 后，正式入口锁定本地项目并核对镜像、容器及全部挂载，只重启同一健康 Server 容器，等待最多 60 秒恢复健康；不构建、不更新代码、不操作 Worker 或 DSA，不重试失败的重启。应在业务快照建立并取得摘要后执行，随后通过本地历史接口核对留存。定向检查为 `node --test scripts/restart-server-for-acceptance.test.mjs`。

## 黑盒契约测试

当前回测 Run 的目标硬杀、Redis 短停、取消及基础生产启动使用仓库维护的[生命周期验收入口](docs/backtest-target-recovery.md)。该入口绑定精确目标、占用更新锁、保护业务摘要并恢复原服务；应先完成主仓定向测试和结构检查。

先在主仓构建共享契约 `pnpm --filter @thesis-ledger/schemas build`，并通过环境注入当前 `THESIS_LEDGER_CONTROL_TOKEN` 和 `THESIS_LEDGER_DSA_TOKEN`。总入口依次运行 V3 协议检查与正向业务读取：

```bash
CONTRACT_DSA_ORIGIN=http://localhost:8000 ./scripts/contract-test.sh
```

业务读取覆盖股票/ETF 报价、正式净值及历史、基金持仓、CNY 自身汇率、筹码和仓库固定的 ETF qfq Bar 窗口。来源未准入、权限不足或历史窗口不完整时测试失败；不要将协议检查通过记作业务通过。总入口不创建 Run，也不执行 Worker 或客户端验收。

## 契约门禁

V3 复权研究有独立协议门禁。先在主仓构建共享契约 `pnpm --filter @thesis-ledger/schemas build`，并通过环境注入已有的 `THESIS_LEDGER_CONTROL_TOKEN` 和 `THESIS_LEDGER_DSA_TOKEN`，再执行：

```bash
CONTRACT_DSA_ORIGIN=http://localhost:8000 \
  bash scripts/market-v3-contract-test.sh
```

该入口只检查 V3 Data 能力声明、Control 握手及精确目录，并验证无效凭据与旧握手地址被拒绝。Data 使用独立令牌发送明确无效的协议版本，要求在请求解析阶段返回匹配请求身份的严格 V3 错误，确认鉴权通过且未进入行情运行时。不会应用路由、创建目录任务、获取 Provider 行情或创建回测。输出不包含 Token 或响应体。正向来源读取使用上面的总入口。

启用 V3 之前必须通过本门禁。协议检查通过也不表示 HiThink 凭据/目标区间可用、数据库升级成功或 Server/Worker 已运行同一版本，仍需主仓 Task 中的独立验收。2026-09-29 当前目标更新因磁盘耗尽未完成，详见主仓[失败边界](../thesis-ledger/docs/tasks/evidence/2026-09-29-canonical-update-all-disk-blocked.md)；此前目标协议通过不能代表当前源码已部署。

三仓发布以同一份能力矩阵为准，不能只更新某一个服务镜像：

| 组件                            | 当前约束                                                                                                                                            | 门禁                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ThesisLedger 主仓               | 0.1.0；Account/Position API V1 直接切换到新账户模型                                                                                                 | 全部 migration、Prisma/raw-owned 表和动态 head 结构校验一致 |
| DSA Fork                        | Data/Control Contract V3 分别使用独立 Token；fund-nav、Catalog 与 Provider policy 使用当前专属路由 | 本地合同测试、协议 smoke、目标正向业务读取与撤销验收 |
| Desktop / Mobile                | 与主仓同一 API schema；Mobile 只读支持 actual / shadow                                                                                              | TypeScript、UI contract 和移动端测试通过                                        |
| PostgreSQL / Redis / DSA SQLite | 由本仓 compose 管理，卷名固定且不共享                                                                                                               | PostgreSQL 存活、结构 head/表覆盖、Control Contract 检查完成后才启动应用服务   |

发布或升级时必须按“共享契约与 DSA/独立 SQLite 卷 → 保留数据的结构升级 → Server 与全部 Worker → Desktop/Mobile”顺序完成；任一 schema、结构 head、Control Token 或 capability 不匹配都停止发布，不做静默降级。DSA pytest 与真实黑盒运行需要先安装 DSA 的测试依赖。

## 版本关系

- ThesisLedger 初始版本：`0.1.0`。
- DSA Fork 镜像版本格式：`v3.28.0-thesisledger.1`，同时记录上游 commit。
- 生产部署使用 GHCR immutable digest；tag 只用于发布说明和兼容矩阵。
