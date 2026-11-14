# Docker 更新流程

正式更新维护镜像，快更只替换容器可写层，容器重建后需重新快更或完整更新。应用的构建、载荷和兼容规则分别由[主仓](../../../thesis-ledger/docs/guides/local-deployment-interface.md)与[DSA](../../../daily-stock-analysis/docs/guides/local-deployment-interface.md)维护。

## 运行环境与入口

宿主需要 Node.js 24、Git、Docker CLI，以及应用构建所需的包管理器。infra 使用 Node 内置模块执行编排和校验，不安装 npm 运行依赖或 Python。原 `.sh` 命令保留路径、参数和退出状态，实际调用 `scripts/infra.mjs`；应用维护接口仍由所属仓库提供。

`./scripts/docker-desktop.sh start|status` 保留 Desktop 启动和状态检查。需要显式扩展默认 Desktop 虚拟磁盘时，使用 `./scripts/docker-desktop-disk.sh extend <容量MiB>`；只能按 1024 MiB 整数倍扩大当前容量。该入口获取维护锁，原子备份并修改设置，检查磁盘身份和服务资源清单；扩容是独立维护操作，普通更新不会调用。

持锁应用工具经 `locked` 接口执行已登记的 Node 脚本，固定本地 context 并传入祖先锁；业务包装、目标校验和费用限制仍由应用维护。

更新、镜像清理、既有容器启动和恢复共用 `scripts/runtime/docker.mjs` 的本地运行层，锁创建、释放与祖先校验由 `scripts/runtime/lock.mjs` 维护。同步维护支持原始字节和文件流，异步部署支持取消与清理；长备份显式选择对应超时。研究归档演练和回执由主仓维护，SQLite 副本恢复由 DSA 维护。

测试环境首次执行 `pnpm install --frozen-lockfile`。本仓测试工具为 [Vitest](https://vitest.dev/guide/)，通过 `pnpm test` 运行全部测试，`pnpm test scripts/update.test.mjs` 定向运行，`pnpm test:watch` 监听源码与测试变化。仓库门禁使用 `pnpm check`；真实只读 Docker 挂载合并验收使用 `pnpm test:docker-readonly`。测试依赖仅用于开发，部署脚本无需安装这些包。实际更新、快更及数据留存核对单独记录，不能由受控测试替代。

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 在构建前后有界维护 BuildKit cache，默认最大缓存 `8gb`、最小空闲空间 `18gb`、缓存保留底线 `4gb`；
- 脚本启动时集中整备并实测 Docker 空间一次；Docker `18gb`、宿主 `20gb` 为清理参考目标。未达参考值时清理未引用镜像，但不因此清空热缓存或基础镜像；已知正余量继续构建。实际零余量/ENOSPC 才进入全部未引用镜像清理与保卷恢复；
- 同一 daemon 的更新互斥，并在清理前检查其他活动构建；探测、清理和 Compose build 固定使用当前本地 context 的同一 builder；
- `all` 目标逐个调用 Compose build，避免两个应用同时冷构建产生叠加磁盘峰值；
- 每个应用构建完成后回收普通中间层，保留命名依赖缓存与镜像引用层，再构建下一个应用；服务全部健康后收敛缓存并回收宿主空闲块；
- 优先使用本地基础镜像别名，不向 Docker Hub 查询已有基础镜像 tag；
- 普通镜像构建失败保留缓存重试一次；实际 ENOSPC 有一次独立的保卷恢复机会，恢复本开发项目全部容器、镜像和网络后再构建。恢复后失败停止；
- Compose 启动或服务健康检查失败时直接输出状态和目标服务日志，不重新构建镜像；
- 不主动刷新基础镜像。
- 本次更新已完成DSA构建而后续阶段停止时，确认DSA源码未再变化，可以设置`REUSE_DSA_IMAGE_ID=sha256:<完整镜像ID>`恢复`all`更新。入口核对当前开发标签、服务与契约，复用精确产物，仅跳过DSA重复构建，Server构建及数据库、启动、健康检查仍执行。
- Docker CLI、Docker daemon 或环境参数预检失败时直接退出。
- PostgreSQL 健康检查只验证数据库进程存活。更新脚本随后用主仓打包的全部排序 migration SQL、动态 head 和 Prisma/raw-owned 表覆盖执行结构门禁，并复用 `bootstrap-app-role.sql` 初始化权限。
- 默认 `DEV_DATABASE_MODE=check` 保留数据并在结构不匹配时阻止新版 Server/Worker 启动；开发阶段需要重建时，必须显式设置 `DEV_DATABASE_MODE=rebuild`、`DEV_DATABASE_ALLOW_DATA_LOSS=true` 和精确的 `DEV_DATABASE_CONFIRM=thesis-ledger-dev/<数据库名>`。
- ThesisLedger 只接收 app role 连接串，并只依赖 PostgreSQL、Redis 与 DSA 的健康状态。

## 应用构建接口


两个应用维护完整的 Dockerfile、命名依赖缓存和下载源配置。`update.sh` 直接通过 Compose/Bake 构建应用 Dockerfile，合并本地镜像参数与应用命令输出的 Compose 构建配置；退出时删除本轮 override 和日志。BuildKit 须支持 `RUN --mount=type=cache`。

这里的边界只覆盖 Dockerfile 级软件源配置。包管理器仍会遵循仓库既有 lockfile 中记录的完整下载地址；`update.sh` 不改写 lockfile、业务 Provider 或 DashScope 配置。

DSA 通过 `scripts/local-deployment.sh build-config` 声明额外上下文，通过 `prepare-build` 准备构建输入。infra 在停机前调用，复用已验镜像时跳过；缓存和版本校验由 DSA 维护。

PyPI 下载遇到 `SSL UNEXPECTED_EOF_WHILE_READING` 时，应先区分连接中断与证书验证失败。可在宿主和现有容器中只读请求同一 HTTPS 索引，确认当前证书校验及网络访问；运行容器连通不能单独证明 BuildKit 连通。网络恢复后仍从 `DEV_DATABASE_MODE=check ./scripts/update.sh all` 续接，由真实构建确认依赖安装结果并复用缓存，不改变依赖版本或关闭证书校验。完整更新前可使用 `research-state-backup.mjs backup` 保留 PostgreSQL、DSA SQLite、数据文件和回测产物。

BuildKit 仍无法访问 HTTPS 下载源时，可显式设置 `BUILD_HTTP_PROXY`、`BUILD_HTTPS_PROXY` 和 `BUILD_NO_PROXY`。它们只从调用 Shell 接收，通过 Bake 标准代理 build args 作用于各构建阶段，未设置时保持原行为，不写入镜像运行时 ENV 或全局 Docker 配置。例如宿主已有 7890 端口代理时，可用 `BUILD_HTTP_PROXY=http://host.docker.internal:7890 BUILD_HTTPS_PROXY=http://host.docker.internal:7890 BUILD_NO_PROXY=localhost,127.0.0.1,::1 DEV_DATABASE_MODE=check ./scripts/update.sh all`。端口必须以实际配置为准；重试已完成的 DSA 产物仍使用既有 `REUSE_DSA_IMAGE_ID` 精确校验，不重复构建。参数、保留数据与运行验收约束见[构建网络规格](../specs/2026-10-21-docker-build-network.md)。

ThesisLedger 构建可通过 `BUILD_ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine` 配置 Alpine 镜像。infra 将其作为 `ALPINE_MIRROR` build arg 传入，应用 Dockerfile 维护仓库配置和 APK 签名校验；地址必须为无凭据、无查询参数的 HTTPS Alpine 根地址。


独立缓存维护也复用共享更新锁和空闲builder检查：`bash scripts/prune-failed-build-history.sh <失败记录ID...>`只删除显式指定并重新确认失败的构建元数据；请先保留需要的失败日志。`bash ../daily-stock-analysis/scripts/deployment/prune-bytecode.sh`默认预览开发DSA四个源码目录的字节码缓存，追加`--apply`才删除可再生成的pyc；源码、符号链接目标和持久资料不在清理范围。两个入口均不清理镜像或数据卷。

Prisma 6.19.3 当前使用的 ARM64 Alpine 引擎产物在 npmmirror 常见 Prisma 镜像入口不存在，因此本地脚本不强制设置 `PRISMA_ENGINES_MIRROR`。Prisma 引擎首次冷缓存仍从默认 CDN 下载并校验 checksum；成功后写入独立 BuildKit cache，后续源码变化使生成层失效时可直接复用。该 cache 若被有界维护或 ENOSPC 全量清理淘汰，下一次构建会重新联网获取，瞬时失败仍由更新脚本保留 cache 后重试一次。

`update.sh` 为当前目标准备以下本地别名，并通过 Compose 的 `NODE_IMAGE`、`PYTHON_IMAGE` 和 `RUST_IMAGE` 构建参数传入：

- `thesis-ledger-local-rust:1.94.1-slim-bookworm`
- `thesis-ledger-local-python:3.11-slim-bookworm`
- `thesis-ledger-local-node:24-alpine`

别名已经存在时，普通更新不会执行 `docker pull`。别名缺失但官方 tag 已在本机时只执行本地 `docker tag`；两者都缺失时才进行首次必要拉取。构建步骤、镜像参数和 SDK 源上下文由应用仓维护，infra 消费其明确接口。

## 选择更新目标

默认目标 `all` 可以省略；只修改了一个源码仓库时可缩小构建范围：

```bash
./scripts/update.sh dsa
./scripts/update.sh thesis-ledger
./scripts/update.sh all
```

构建、启动和健康等待只针对所选应用服务。Compose 仍会按 `depends_on` 启动目标所需的依赖。

## 快速仅代码更新

当前镜像已经包含兼容依赖且数据库结构没有变化时，可以跳过镜像构建：

```bash
./scripts/sync-code.sh
./scripts/sync-code.sh dsa
./scripts/sync-code.sh thesis-ledger
```

`sync-code.sh` 会先在宿主机完成所选目标的构建，再把产物同步到现有运行容器的可写层：

- `dsa` 按 `scripts/data-runtime-contract.json` 装配 `server.py`、`api/`、`data_provider/`、`src/`、`scripts/admit_nav_research.py` 及合同文件；原子替换指定路径，已删除模块随目录替换移除；
- `thesis-ledger` 同时更新 Server、Backtest Worker 以及运行时使用的 `domain`、`schemas`、`shared` 构建产物；
- 所有构建在修改容器前完成，随后只重启目标容器并等待现有健康检查；
- 脚本在执行前后核对容器镜像 ID，不执行镜像 build、pull、tag、commit、push 或删除；
- 复制、重启或健康检查失败时，使用 Compose 当前指向的同一镜像重建目标容器，撤销本次可写层更新，不删除数据卷。

DSA 快更在修改前核对镜像构建时的 `data-runtime-inputs.json`，覆盖依赖、Dockerfile、原生 SDK 补丁/构建脚本和保留 SQLite 结构的所有者文件。宿主 Node 与镜像 Python 使用同一指纹算法；旧镜像缺少基线、命令不符或存在代码挂载时直接拒绝。DSA 快更与完整更新、恢复共用本地 daemon 锁。

这是本地开发快更，不是镜像发布。容器被重新创建、完整执行 `update.sh` 或删除后，本次同步会消失。目标容器必须已经存在并运行；脚本也会验证 Compose 镜像引用仍指向容器当前使用的同一镜像，以免失败回滚时意外切换版本。

以下变化不能使用快更：

- ThesisLedger Server 或其运行时 workspace 包的 `package.json` 与容器不一致；
- Prisma Schema、migration 或 `raw-owned-tables.json` 与容器不一致；
- DSA `requirements.txt` 与容器不一致；
- DSA 数据载荷合同或构建兼容指纹不一致；
- 系统包、Node/Python 运行时、原生 SDK 或 Dockerfile 行为发生变化。

遇到这些情况时，脚本会在复制前退出，应继续使用：

```bash
./scripts/update.sh [all|dsa|thesis-ledger]
```

快更不会执行数据库结构门禁或开发数据库重建，也不会更新 Desktop/Mobile 原生应用。目标服务会发生一次短暂重启，进行中的请求或 Worker 作业可能中断，因此不得把该入口用于生产发布。

## DSA 运行态恢复

`update.sh dsa/all` 在取得锁后、空间整备或构建前，把现存 DSA 的不可变镜像、API 命令、entrypoint、健康检查、端口及全部命名/匿名卷和绑定挂载写入 `.maintenance-backups/dsa-runtime/<时间>-<镜像前缀>.json`。快照仅记录环境文件 SHA256；更新过程中保护该镜像。`mounts.compose.json` 持续接回原挂载，由后续完整更新、快更及恢复共同消费。

```bash
ENV_FILE=.env bash scripts/restore-dsa.sh .maintenance-backups/dsa-runtime/<更新前快照>.json
```

恢复入口只重建 `dsa`，使用完整镜像 ID、`--no-build --pull never --no-deps`；原 `serve-only` API 与数据 Uvicorn API 均可恢复，分析定时命令被拒绝。原 context、环境摘要、镜像、所有卷及绑定路径必须可核对，Compose 合并后的挂载与端口须与快照完全一致；失败即停止。恢复后再次核对镜像、命令、挂载、端口及健康，失败保留现场。

此入口恢复镜像代码基线，持久化状态继续使用原卷；容器可写层中的历史快更和历史数据时点不在快照中。状态副本恢复仍使用既有研究状态恢复流程。跨多次更新必须保留的旧镜像应显式加入 `BUILD_PROTECTED_IMAGES`，不能假定所有历史快照对应镜像永远留存。D10 的假 Docker 与文件事务回归不替代 DG2 的真实镜像和恢复验收。

## 刷新应用基础镜像

需要主动刷新基础镜像时：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

该模式会先对当前更新目标所需的官方基础镜像执行 `docker pull`，全部拉取成功后才统一刷新对应本地别名，再通过显式构建参数使用别名构建。默认 `all` 目标等价于：

```bash
docker pull rust:1.94.1-slim-bookworm
docker pull python:3.11-slim-bookworm
docker pull node:24-alpine
# 更新三个 thesis-ledger-local-* 本地别名
docker compose build dsa
docker compose build thesis-ledger
```

拉取失败时不会更新别名，也不会开始应用镜像构建；已有可运行镜像和容器保持不变。

## 刷新基础服务镜像

PostgreSQL 和 Redis 默认不刷新。

如需刷新：

```bash
PULL_SERVICE_IMAGES=true ./scripts/update.sh
```

## 镜像清理保护

空间整备读取全部容器引用和镜像库存，保护空间探针、本轮构建产物以及 BUILD_PROTECTED_IMAGES 指定的完整 SHA256 ID。独立维护默认预览；--apply 才执行，并复用当前本地 daemon 的互斥锁、祖先 PID 校验和活动构建检查。每次删除前重新核对候选身份与保护条件，使用非强制删除，不操作卷。

常规模式只清理无标签镜像和当前目标的未引用开发标签；all-unused 用于保卷恢复或显式全部未引用维护，逐项处理未受保护的镜像。其他带标签镜像在常规模式下保持。

## BuildKit 缓存空间维护

脚本默认在拉取前集中整备和测量一次，构建完成后再次有界维护（实际调用会显式指定当前 context 的 builder）：

```bash
docker buildx prune --all --force \
  --max-used-space 8gb \
  --min-free-space 18gb \
 --reserved-space 4gb
```

**清理结果以实际余量为准。** 拉取前先有界维护和实测，低于参考目标时清理未引用镜像；不因参考值触发全缓存清空或删除基础镜像。普通中间层在每个服务完成后回收，命名依赖缓存继续复用。容器引用、显式保护、探针、显式复用和本轮已完成产物保留；服务全部健康后收敛缓存与已空闲磁盘块。未知库存、未知余量、清理错误或活动构建仍停止；正余量继续。

Docker 清理参考目标 `BUILD_CACHE_MIN_FREE_SPACE` 默认 `18gb`，宿主参考目标 `BUILD_HOST_MIN_FREE_SPACE` 默认 `20gb`；二者不是应用或正式研究镜像的必要容量。容量按1024进位，支持 b/k/kb/m/mb/g/gb/t/tb 与小数，参考值必须大于零。每次打印实际 MiB 与参考目标；Docker 探测使用已有基础镜像固定 ID 的临时只读、无网络容器，不挂载业务卷。

宿主机同时检查源码目录和 Docker 数据目录，后者默认标准 Desktop 路径。自定义位置须设置 `BUILD_SPACE_HOST_PATH=/实际磁盘所在目录`；远端 daemon、`DOCKER_HOST` 覆盖和自定义 builder 拒绝。Mac 标准 Docker Desktop 按需调用[官方空闲块回收工具](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)并复测，工具固定不可变摘要，临时使用 privileged 和 VM 的 host PID，无业务或宿主目录挂载。`REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 关闭全部自动清理与重装，保留测量；正余量仍允许尝试构建。

更新锁按当前用户及 daemon 地址隔离。正常退出自动释放；进程异常退出留下锁时，错误会打印锁目录，目录中的 `pid` 标识原更新进程。仅在确认该进程已停止后手动移除对应锁目录，不抢占其他更新。通过其他入口发起的构建不受锁约束；脚本仍检查 Buildx history 的活动构建，但检查不能阻止外部进程在检查之后开始写入。

这些阈值分别向 BuildKit 提交缓存最大占用、构建磁盘最小空闲空间和热缓存保留底线。它们是 GC 目标，不是对 `docker system df` 总数的硬性承诺：正在使用的记录不会被删除；`docker buildx du` 中的 Shared 层通常同时被最终镜像引用，删除其缓存元数据也不会释放对应镜像层；缓存保留底线还会限制 GC 能继续释放的空间。判断额外缓存占盘时应同时查看 `docker buildx du` 的 Private、Reclaimable 与 Docker 磁盘实际空闲空间。构建后再次维护时，BuildKit 按最近使用顺序优先淘汰可回收的旧分支，刚完成构建所使用的缓存会优先保留。

可以按 Docker 支持的容量格式调整：

```bash
BUILD_CACHE_MAX_USED_SPACE=10gb \
BUILD_CACHE_MIN_FREE_SPACE=16gb \
BUILD_CACHE_RESERVED_SPACE=4gb \
./scripts/update.sh
```

若识别到 `ENOSPC`、`no space left on device` 等明确错误，脚本默认自动执行一次保卷重装：先记录本开发项目全部容器的命名/匿名卷挂载，持久写入 `.maintenance-backups/docker-space-recovery/compose.json`；再停止本项目容器，执行不带 `-v` 的 Compose down，核对全部现存卷保留，清理缓存和无引用镜像并回收空闲块。恢复范围扩大为 all，重新准备基础镜像、构建两应用，经原数据库检查后启动；已成功构建的本轮镜像直接复用。其他项目容器、所有 volumes、绑定目录和宿主文件保留。恢复文件后续自动沿用；中断标记保留时，下次正式更新自动按 all 继续。恢复失败或恢复后仍 ENOSPC 时停止并报告实际错误，不循环重装。

独立检查/清理全部未引用镜像也可使用以下入口；正式更新会自动保护探针及本轮产物。手工维护时用完整 ID 保护需要继续使用的本地镜像：

```bash
node scripts/docker-space-images.mjs all --all-unused --protect <完整镜像ID>
node scripts/docker-space-images.mjs all --all-unused --protect <完整镜像ID> --apply
```

明确需要执行保卷重建时，使用 `DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=compact ./scripts/update.sh all`。默认 auto 不主动停机；compact 在停机前预取固定 SDK 源，通过后才执行一次恢复。仅对本开发项目重建，禁用自动清理时不能使用 compact。该模式同样执行原有更新锁、数据库结构检查、构建及健康门禁。

需要排查缓存现场或明确不允许本次调用删除任何 BuildKit cache 时，可以关闭构建前后维护与 ENOSPC 自动修复：

```bash
REPAIR_BUILD_CACHE_ON_NO_SPACE=false ./scripts/update.sh
```

`all` 会分别调用 `docker compose build dsa` 和 `docker compose build thesis-ledger`。Compose 的全局并发参数不能阻止同一次多目标 build 在 BuildKit 内并行，因此脚本不把两个 service 放入同一次 build 调用。

2026-10-05早期32 GiB上限及20 GiB全局GC读数仅为历史采样。当前空间整备会自动处理受保护政策允许的缓存和镜像，保留容器引用和明确保护的镜像与业务卷；这些受保护资源仍持续占盘，不能保证任意环境都能删减到目标。纯代码且快更兼容预检通过时优先使用`sync-code.sh`，减少完整构建。

阈值行为参考 [Docker Buildx prune 官方文档](https://docs.docker.com/reference/cli/docker/buildx/prune/)，后台回收策略参考 [BuildKit GC 官方文档](https://docs.docker.com/build/cache/garbage-collection/)。

## 设计原则

- 数据库重建执行器只接受开发编排传入的 `NODE_ENV=development`，生产发布不携带该入口；
- 为受限的本地 Docker 虚拟磁盘默认启用有界缓存维护，并保留显式关闭入口；
- 避免开发环境每次更新等待基础镜像检查；
- 本地基础镜像别名由 infra 准备；命名依赖缓存、下载源与构建步骤由各应用 Dockerfile 维护，infra 通过显式参数和上下文配置；
- 本地别名不会自动跟随官方 tag；在网络可用的受控窗口使用 `PULL_BASE_IMAGES=true` 获取更新和安全修复；
- 保持数据卷安全，不执行 `docker compose down -v`。
- 普通构建错误不触发全量缓存清理；Compose 启动失败和健康检查失败不执行额外缓存清理。
- 构建前后按保护策略清理未引用镜像和构建缓存，保留仍有用途的基础镜像；实际零余量/ENOSPC 时允许停止并重建本开发项目容器、清理全部未引用镜像，再接回原命名和匿名卷继续更新。维护不执行 `docker system prune`，不删除 volumes、绑定目录或宿主文件，不停止其他项目容器。
- PostgreSQL 已有持久卷时，默认更新只做结构预检，不删除数据卷；开发重建只删除并重建 `public` schema，仍保留卷本身。
- 权限 SQL 在结构重建事务中通过 `psql` 执行，使用原有 `bootstrap-app-role.sql` 的 owner/app role 校验和 `LedgerEvent`、`SchemaVersion` 权限收紧逻辑。
- 应用容器只接收 app role 连接串；owner 凭证只存在于 PostgreSQL init 环境。

### 恢复已停止的原开发容器

Docker Desktop 已启动而原开发容器停止时，可执行 `node scripts/resume-existing-development.mjs --confirm=thesis-ledger-dev`。入口只接受当前 `desktop-linux` Unix 端点和既有五个项目容器，复用更新锁，先核对项目标签、镜像、容器身份及持久卷，再按 PostgreSQL/Redis → DSA → Server/Worker 的顺序启动并等待健康。缺容器、身份变化或依赖不健康即退出。

该入口不创建、重建、拉取镜像或修改卷，执行后再次核对原身份；只用于恢复已确认的开发运行态。源码、依赖或结构需要更新时仍按上述 `sync-code.sh` / `update.sh` 规则处理。合同测试：`pnpm test scripts/resume-existing-development.test.mjs`。

### 东财拆分的精确准入维护入口

`../daily-stock-analysis/scripts/local-runtime/eastmoney-split-admission.mjs`只维护 `thesis-ledger-dev / 159516.SZ / 2026-03-30～2026-07-10`，复用主仓原映射JSON的完整字节，不接受其他证券、窗口、摘要或证据路径。默认仅读取宿主原文并生成待审批计划，不启动Docker、不安装文件或写数据库：

```bash
node ../daily-stock-analysis/scripts/local-runtime/eastmoney-split-admission.mjs --confirm=thesis-ledger-dev/159516.SZ/2026-03-30/2026-07-10 --sha256=b1a4f03f94faf27acf95d2bef9d508ec06eabec1280e04c921bb677154f5fe8e
```

计划默认提出24小时有效期、记录人为空，均不代表批准。未来只有明确签发授权后才能附加 `--apply`；应用还必须显式给出 `--valid-hours=1..24` 的整数值和 `--recorded-by=<审阅标识>`。入口核对本地Unix端点、更新锁、原DSA容器/镜像身份及命名持久卷，以dsa身份执行同目录目标端Python脚本；该Python文件是入口内部组件，不作为独立运维命令调用。

目标端只接受原数据库路径/已有结构，复用原MappingEvidenceStore和准入记录方法，避免普通ControlStore构造器的Schema初始化/凭据轮换。在原BEGIN IMMEDIATE事务持锁后检查精确记录不存在，已有/并发新增一律拒绝，不能续期、撤销、覆盖或自动重试；原受控证据先安全读回再记录。中途失败可能留下未授准入的同摘要证据；应用后回执/身份检查异常须只读核查，不以再次应用恢复。

该入口不选择主备、保存凭据、请求供应商或证明完整覆盖。`coverage=false`、普通完整冻结受阻继续保持。局部验证：`node --test ../daily-stock-analysis/scripts/local-runtime/eastmoney-split-admission.test.mjs`，以及用相邻DSA现有环境执行 `../daily-stock-analysis/.venv/bin/python -B ../daily-stock-analysis/scripts/local-runtime/eastmoney-split-admission.test.py`；后者仅新维护合同、原resolver新审阅包兼容及合成临时库并发守卫，不重跑旧映射测试。
