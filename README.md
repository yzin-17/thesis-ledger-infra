# ThesisLedger 开发栈

本仓库只负责把三个独立仓库串联起来：

- `../thesis-ledger`：主系统源码。
- `../daily-stock-analysis`：DSA Fork 及其 ThesisLedger Data/Control V3 接口。
- `thesis-ledger-infra`：固定镜像默认配置、源码构建 override 和黑盒契约测试入口。

父目录不纳入 Git。脚本只会 clone 缺失仓库；如果仓库已经存在，不会自动切换分支、拉取或修改工作树。

本仓库是唯一的 Docker 编排入口，Compose 项目名固定为 `thesis-ledger-dev`。`compose.yml` 是基础配置，`compose.dev.yml` 是源码构建覆盖；两者共同组成同一个开发栈，不是两套独立服务。主仓库不再单独启动 Docker。

PostgreSQL 只负责进程存活检查；开发数据库结构由主仓的结构执行器统一发现并以 psql 在目标库内重建。执行器会按目录排序执行全部 migration SQL、包含 `raw-owned-tables.json` 登记表、初始化 app role 权限并写入当前 head。`POSTGRES_OWNER_USER` 与 `POSTGRES_APP_USER` 必须是不同的非空角色；角色校验失败会使重建失败。应用容器只接收 `POSTGRES_APP_USER` 连接串，不会获得 owner 连接串。现有持久卷不会被自动重置；默认更新只做结构预检，结构不匹配时阻止新版应用启动。只有显式设置 `DEV_DATABASE_MODE=rebuild`、`DEV_DATABASE_ALLOW_DATA_LOSS=true` 和精确的 `DEV_DATABASE_CONFIRM=thesis-ledger-dev/<数据库名>` 才会清空目标 `public` schema，且不会删除 PostgreSQL volume。

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

脚本默认使用 `.env`；如果文件不存在，则回退到 `.env.example`。它会在临时 Dockerfile 中移除远端 frontend 解析、使用 `thesis-ledger-local-*` 基础镜像别名、注入本地命名依赖缓存，并仅为该次本地构建设置 Aliyun Debian mirror 与 npmmirror，随后重建 `dsa` 与 `thesis-ledger`、启动服务并等待健康检查完成。临时 Dockerfile 与 Compose override 会在脚本退出时删除；共享 Dockerfile 不包含本地别名、命名 cache 或国内软件源覆盖。别名首次缺失时由本机官方 tag 补齐；本机也没有对应镜像时才执行必要拉取。脚本在构建前后请求 BuildKit 按默认 `8gb` 最大缓存、`18gb` 最小空闲空间和 `4gb` 缓存保留底线执行 GC；`all` 会逐个调用 Compose build，避免两个应用同时冷构建。首次普通构建失败会保留缓存并重试一次，首次空间不足则清理当前 builder 的全部未使用缓存后重试一次。Compose 启动或健康检查失败不会再次构建。只修改了一个源码仓库时可缩小范围：

```bash
./scripts/update.sh dsa
./scripts/update.sh thesis-ledger
```

更新入口还会在拉取前和每个应用构建前检查实际余量：Docker 默认至少 `18gb`、宿主机至少 `20gb`。有界清理后仍不足时自动全清可回收构建缓存一次并复测，仍不足则停止；关闭清理也不能绕过空间检查。同一 daemon 的更新互斥，检测到其他活动构建时停止。自定义 Docker 磁盘位置须设置 `BUILD_SPACE_HOST_PATH`；更多说明见 [空间维护](docs/docker-update-workflow.md#buildkit-缓存空间维护)。

成功更新并通过目标健康检查后，默认每个服务保留两个历史回滚镜像；当前容器、更新前基线与显式保护对象优先保留。数量配置、只读预览和维护入口见[回滚镜像保留](docs/docker-update-workflow.md#回滚镜像数量保留)。

当前镜像依赖与数据库结构均未变化、只需要更新应用代码时，可以使用快速入口：

```bash
./scripts/sync-code.sh
./scripts/sync-code.sh dsa
./scripts/sync-code.sh thesis-ledger
```

该脚本在宿主机构建后把产物同步到现有运行容器，只重启容器，不执行镜像 build/pull/tag、数据库结构操作或外部卷操作。ThesisLedger package manifest、Prisma 结构或 DSA `requirements.txt` 与容器不一致时会拒绝执行，并要求回到完整 `update.sh`。快更只存在于容器可写层，容器重建后会恢复为镜像内代码。完整边界和失败回滚见[Docker 更新流程](docs/docker-update-workflow.md#快速仅代码更新)。

如需刷新 PostgreSQL 和 Redis 的服务镜像，可显式开启：

```bash
ENV_FILE=.env PULL_SERVICE_IMAGES=true HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh
```

如需拉取官方应用基础镜像并刷新本地别名，可显式开启：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

脚本不会执行 `docker compose down -v`，不会删除或重置 PostgreSQL、Redis 和 DSA SQLite 数据卷；如果宿主机端口被其他进程占用，脚本会报告 Compose 状态并退出，不会自动停止占用者。BuildKit cache 空间维护默认开启，可用 `BUILD_CACHE_MAX_USED_SPACE`、`BUILD_CACHE_MIN_FREE_SPACE` 和 `BUILD_CACHE_RESERVED_SPACE` 调整；如需保留缓存现场，可设置 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 关闭构建前后维护与空间不足自动修复。

更新前会自动整备超额回滚镜像。常规历史保留数`ROLLBACK_IMAGE_KEEP_COUNT`默认2；常规整备和空闲块回收仍不足时，按`BUILD_SPACE_ROLLBACK_KEEP_COUNT`默认0的紧张期目标逐个退役共享磁盘上未引用、未保护的最旧历史回滚，每次实测宿主20 GiB/Docker18 GiB空闲目标，达标即停。运行镜像、更新前基线、显式保护及本次构建产物始终保护，即使数量超过目标；只删除重新核实的精确回滚标签，不删除备份文件或volume。没有实际删除或任一步失败即停止，不循环重复无进展的清理。紧张期数量设为常规数量或更大时不启用该阶段，关闭自动空间修复时也不清理回滚镜像。这些更新参数通过Shell环境传入，不从Compose的`.env`读取。

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
