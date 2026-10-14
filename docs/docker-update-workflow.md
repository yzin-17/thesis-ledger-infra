# Docker 更新流程

ThesisLedger 当前公开 API 为 `/api/market*`、`/api/v1/backtests/runs`、`/api/v1/backtests/runs/nav` 与 `/api/v1/ledger/*`；DSA 专属 Data/Control 为 `/api/v3/thesis-ledger/*`。主仓当前合同与证据见 `docs/architecture/canonical-runtime.md` 及 Canonical Task。代码快更整体替换 Server dist、workspace dist 与 DSA 源码目录，删除的模块不会留作转导入口；镜像 ID 保持不变，容器重建后需重新快更或通过官方完整更新构建当前镜像。

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 在构建前后有界维护 BuildKit cache，默认最大缓存 `8gb`、最小空闲空间 `18gb`、缓存保留底线 `4gb`；
- 脚本启动时集中整备并检查Docker空间一次，目标为Docker `18gb`、宿主 `20gb`：缓存仍不足时清理受保护政策允许的所选应用未使用镜像，再实测；仍不足时检查共享磁盘上两个应用未引用、未保护的历史回滚，紧张期默认目标0，逐个退役最旧版本并复测，达标即停。复用原保护及逐候选复核，不清理非目标普通开发标签。清理后实测并按需回收Desktop空闲块；后续各镜像构建不重复执行空间预检；
- 同一 daemon 的更新互斥，并在清理前检查其他活动构建；探测、清理和 Compose build 固定使用当前本地 context 的同一 builder；
- `all` 目标逐个调用 Compose build，避免两个应用同时冷构建产生叠加磁盘峰值；
- 优先使用本地基础镜像别名，不向 Docker Hub 查询已有基础镜像 tag；
- 首次普通镜像构建失败时保留 BuildKit cache 并重试一次；首次明确空间不足时清理当前 builder 的全部未使用缓存后重试一次；第二次失败直接退出；
- Compose 启动或服务健康检查失败时直接输出状态和目标服务日志，不重新构建镜像；
- 不主动刷新基础镜像。
- 本次更新已完成DSA构建而后续阶段停止时，确认DSA源码未再变化，可以设置`REUSE_DSA_IMAGE_ID=sha256:<完整镜像ID>`恢复`all`更新。入口核对当前开发标签、服务与契约，复用精确产物，仅跳过DSA重复构建，Server构建及数据库、启动、健康检查仍执行。
- Docker CLI、Docker daemon 或环境参数预检失败时直接退出。
- PostgreSQL 健康检查只验证数据库进程存活。更新脚本随后用主仓打包的全部排序 migration SQL、动态 head 和 Prisma/raw-owned 表覆盖执行结构门禁，并复用 `bootstrap-app-role.sql` 初始化权限。
- 默认 `DEV_DATABASE_MODE=check` 保留数据并在结构不匹配时阻止新版 Server/Worker 启动；开发阶段需要重建时，必须显式设置 `DEV_DATABASE_MODE=rebuild`、`DEV_DATABASE_ALLOW_DATA_LOSS=true` 和精确的 `DEV_DATABASE_CONFIRM=thesis-ledger-dev/<数据库名>`。
- ThesisLedger 只接收 app role 连接串，并只依赖 PostgreSQL、Redis 与 DSA 的健康状态。

## 本地临时构建定义

仓库中的共享 Dockerfile 和 `compose.dev.yml` 继续引用官方基础镜像、沿用原有依赖安装写法，DSA Dockerfile 继续声明 `# syntax=docker/dockerfile:1.7`；同时不再包含 Aliyun 或 npmmirror 的 Dockerfile 级覆盖。生产、CI、直接 `docker build` 和直接 `docker compose build` 都不会使用本地别名、本地命名 cache 或脚本注入的软件源。

`update.sh` 只在单次本地执行期间创建临时 Dockerfile 与 Compose override。临时 DSA Dockerfile 会移除外部 frontend 声明，把官方 `FROM` 替换为本地别名，为 npm、APT lists、APT archives 与 pip 注入稳定命名 cache，并把 Debian 源替换为 Aliyun HTTPS mirror；临时 ThesisLedger Dockerfile 会替换 `FROM`、补齐 workspace manifest，让 `pnpm install` 与 `pnpm deploy` 复用同一个命名 store，通过 `COREPACK_NPM_REGISTRY`、`pnpm_config_registry`、`npm_config_registry` 与 `npm_config_disturl` 分别为 Corepack、pnpm 11、npm 兼容子进程和 node-gyp 设置 npmmirror，并让 build/runtime 两次 `prisma generate` 复用同一个 `/root/.cache/prisma` 命名 cache。脚本退出时删除这些临时文件，不改写源码目录。该本地路径要求 Docker/BuildKit 自带的 frontend 支持稳定版 `RUN --mount=type=cache`；当前验证环境为 Docker 29.7.2 与 Buildx 0.36.1。

这里的边界只覆盖 Dockerfile 级软件源配置。包管理器仍会遵循仓库既有 lockfile 中记录的完整下载地址；`update.sh` 不改写 lockfile、业务 Provider 或 DashScope 配置。

DSA的SDK和运行镜像两个APT阶段均使用Aliyun HTTPS镜像源、三次下载重试与45秒HTTPS超时，并移除Docker自动清理下载缓存的配置。SDK原始单行安装命令也必须被精确转换，结构不匹配时停止；缓存挂载保留已下载的软件包，避免网络失败后的全量重下。SDK版本、补丁和安装包清单保持源码定义。

独立缓存维护也复用共享更新锁和空闲builder检查：`bash scripts/prune-failed-build-history.sh <失败记录ID...>`只删除显式指定并重新确认失败的构建元数据；请先保留需要的失败日志。`bash scripts/prune-dsa-bytecode.sh`默认预览开发DSA四个源码目录的字节码缓存，追加`--apply`才删除可再生成的pyc；源码、符号链接目标和持久资料不在清理范围。两个入口均不清理镜像或数据卷。

Prisma 6.19.3 当前使用的 ARM64 Alpine 引擎产物在 npmmirror 常见 Prisma 镜像入口不存在，因此本地脚本不强制设置 `PRISMA_ENGINES_MIRROR`。Prisma 引擎首次冷缓存仍从默认 CDN 下载并校验 checksum；成功后写入独立 BuildKit cache，后续源码变化使生成层失效时可直接复用。该 cache 若被有界维护或 ENOSPC 全量清理淘汰，下一次构建会重新联网获取，瞬时失败仍由更新脚本保留 cache 后重试一次。

`update.sh` 会为当前目标准备以下本地别名，并只注入临时 Dockerfile：

- `thesis-ledger-local-node:20-slim`
- `thesis-ledger-local-python:3.11-slim-bookworm`
- `thesis-ledger-local-node:24-alpine`

别名已经存在时，普通更新不会执行 `docker pull`。别名缺失但官方 tag 已在本机时只执行本地 `docker tag`；两者都缺失时才进行首次必要拉取。若共享 Dockerfile 的受支持 frontend 或 `FROM` 行发生变化，脚本会在拉取与构建前失败并提示同步映射，避免静默使用过期基础镜像。

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

- `dsa` 更新根目录 Python 文件、`api/`、`data_provider/`、`bot/`、`src/`、`strategies/` 和 WebUI `static/`；
- `thesis-ledger` 同时更新 Server、Backtest Worker 以及运行时使用的 `domain`、`schemas`、`shared` 构建产物；
- 所有构建在修改容器前完成，随后只重启目标容器并等待现有健康检查；
- 脚本在执行前后核对容器镜像 ID，不执行镜像 build、pull、tag、commit、push 或删除；
- 复制、重启或健康检查失败时，使用 Compose 当前指向的同一镜像重建目标容器，撤销本次可写层更新，不删除数据卷。

DSA WebUI 锁文件变化或本机依赖缺失时，脚本会执行一次 `npm ci`。它默认使用当前用户的独立临时缓存目录，不读取可能存在历史权限问题的全局 `~/.npm`；需要固定缓存位置时可设置 `CODE_SYNC_NPM_CACHE_DIR`。锁文件未变化时直接复用 `apps/dsa-web/node_modules`。

这是本地开发快更，不是镜像发布。容器被重新创建、完整执行 `update.sh` 或删除后，本次同步会消失。目标容器必须已经存在并运行；脚本也会验证 Compose 镜像引用仍指向容器当前使用的同一镜像，以免失败回滚时意外切换版本。

以下变化不能使用快更：

- ThesisLedger Server 或其运行时 workspace 包的 `package.json` 与容器不一致；
- Prisma Schema、migration 或 `raw-owned-tables.json` 与容器不一致；
- DSA `requirements.txt` 与容器不一致；
- 系统包、Node/Python 运行时、原生 SDK 或 Dockerfile 行为发生变化。

遇到这些情况时，脚本会在复制前退出，应继续使用：

```bash
./scripts/update.sh [all|dsa|thesis-ledger]
```

快更不会执行数据库结构门禁或开发数据库重建，也不会更新 Desktop/Mobile 原生应用。目标服务会发生一次短暂重启，进行中的请求或 Worker 作业可能中断，因此不得把该入口用于生产发布。

## 刷新应用基础镜像

需要主动刷新基础镜像时：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

该模式会先对当前更新目标所需的官方基础镜像执行 `docker pull`，全部拉取成功后才统一刷新对应本地别名，再通过临时 Dockerfile 使用别名构建。默认 `all` 目标等价于：

```bash
docker pull node:20-slim
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

## 回滚镜像数量保留

`update.sh` 覆盖开发镜像标签前，会固定全部现存目标容器的镜像，包括停止容器、同服务多个容器及独立 Worker 镜像。常规回滚数量维护在数据库处理、目标启动及健康检查成功后执行；构建前空间不足时，也会在同一更新锁内按相同保护/数量政策整备超额回滚标签。

`ROLLBACK_IMAGE_KEEP_COUNT` 默认 `2`，每个镜像仓库独立计算，只接受大于零的安全整数。按镜像构建时间保留最新版本，同时间按完整镜像 ID 稳定排序。当前开发标签或其他额外标签的镜像保护且不占历史名额；现存容器引用、本次更新前固定的镜像及显式保护基线优先保留，计入纯历史名额。受保护历史超过配置数量时允许超额，不强制淘汰。

额外基线通过 `ROLLBACK_PROTECTED_IMAGES` 指定，接受完整 `sha256:<64位十六进制>` 或这两个仓库的 `rollback-<完整SHA>` 标签，以空白分隔。引用缺失或身份冲突会停止维护。建议跨多次更新都必须保留的发布/恢复基线使用此配置，而不是依赖最近版本排序。

维护入口默认只读，输出保护原因和精确候选：

```bash
node scripts/rollback-image-policy.mjs all
node scripts/rollback-image-policy.mjs thesis-ledger
```

需要单独实施清退时使用同一仓库维护入口的 `--apply`；它共用更新互斥锁并拒绝活动构建，不触发构建、重启或数据库操作：

```bash
ROLLBACK_IMAGE_KEEP_COUNT=2 node scripts/rollback-image-policy.mjs thesis-ledger --apply
```

更新内部借用锁时，同时核对锁文件 PID 和执行器的实际进程祖先链，兼容 macOS Bash 3.2 在条件函数及临时环境变量下产生的中间 Shell。祖先查询失败、循环或无法确认持锁进程时停止，不抢占锁。

只移除 `thesis-ledger:rollback-<完整SHA>` 或 `daily-stock-analysis:rollback-<完整SHA>` 精确标签，逐项重新读取引用、身份、额外标签、数量计划和活动构建。移除使用 `--no-prune` 防止连带清退无标签父镜像，且不使用 `--force`。新受保护的候选跳过；错误立即停止后续淘汰。更新中的维护失败独立输出警告，不把已经成功启动的服务重新构建。无标签镜像、基础镜像、卷和构建缓存不由这一入口处理。删除标签不保证释放镜像展示的全部空间，共享层和宿主磁盘块回收须另行实测。参数语义见 [Docker 官方说明](https://docs.docker.com/reference/cli/docker/image/rm/)。

实现契约与本轮证据分别见[规格](specs/2026-10-05-rollback-image-retention.md)和[已完成实施记录](archive/tasks/2026-10-05-rollback-image-retention.md)。

首次实际清退、容器与卷不变检查、磁盘回收读数及 Bash 更新锁兼容修复见[运行与修复记录](archive/tasks/2026-10-05-rollback-image-retention-followup.md)。

## BuildKit 缓存空间维护

脚本默认在拉取前、每个应用构建前及构建完成后执行 BuildKit 有界维护（实际调用会显式指定当前 context 的 builder）：

```bash
docker buildx prune --all --force \
  --max-used-space 8gb \
  --min-free-space 18gb \
 --reserved-space 4gb
```

**清理命令成功不代表空间充足。** 拉取前和每个服务开工前，脚本先主动维护可回收缓存并实测；不足时全清可回收BuildKit缓存，仍不足则调用`scripts/docker-space-images.mjs`整备超额回滚、无引用无标签镜像，以及所选应用未使用的唯一开发标签镜像，再实测。运行或停止容器引用、额外标签、指定基线、探针、基础镜像以及本次已成功构建的待启动镜像均受保护。删除不使用`--force`，也不级联清理父镜像；容器、网络、卷、工程和宿主应用缓存不删除。安全候选不足或库存/构建状态未知时停止。

Docker整备后的空闲目标复用`BUILD_CACHE_MIN_FREE_SPACE`，默认`18gb`；宿主目标为`BUILD_HOST_MIN_FREE_SPACE`，默认`20gb`。脚本先删减可回收Docker内容再核对目标，调用方无需先手工保证20 GiB。容量按1024进位，支持b/k/kb/m/mb/g/gb/t/tb与小数，目标必须大于零。每次打印实际MiB与目标；共享层或Docker虚拟磁盘的宿主回收必须以实际余量为准。Docker探测使用已有基础镜像固定ID的临时只读、无网络容器，不挂载业务卷或拉取探针。

宿主机同时检查源码目录和Docker数据目录，后者默认标准Desktop数据路径（不存在则使用源码目录）。自定义位置须设置`BUILD_SPACE_HOST_PATH=/实际磁盘所在目录`；远端daemon、`DOCKER_HOST`覆盖和自定义builder明确拒绝。Mac标准Docker Desktop且存在Docker.raw时，删减后宿主仍不足会调用[官方空闲块回收工具](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)并复测，工具固定不可变摘要。它临时使用privileged及VM的host PID命名空间，自动删除、无网络、无业务/宿主目录挂载，仅回收空闲块，不缩小磁盘上限。`REPAIR_BUILD_CACHE_ON_NO_SPACE=false`关闭缓存、镜像和空闲块自动整备，实际空闲目标仍须满足。

更新锁按当前用户及 daemon 地址隔离。正常退出自动释放；进程异常退出留下锁时，错误会打印锁目录，目录中的 `pid` 标识原更新进程。仅在确认该进程已停止后手动移除对应锁目录，不抢占其他更新。通过其他入口发起的构建不受锁约束；脚本仍检查 Buildx history 的活动构建，但检查不能阻止外部进程在检查之后开始写入。

这些阈值分别向 BuildKit 提交缓存最大占用、构建磁盘最小空闲空间和热缓存保留底线。它们是 GC 目标，不是对 `docker system df` 总数的硬性承诺：正在使用的记录不会被删除；`docker buildx du` 中的 Shared 层通常同时被最终镜像引用，删除其缓存元数据也不会释放对应镜像层；缓存保留底线还会限制 GC 能继续释放的空间。判断额外缓存占盘时应同时查看 `docker buildx du` 的 Private、Reclaimable 与 Docker 磁盘实际空闲空间。构建后再次维护时，BuildKit 按最近使用顺序优先淘汰可回收的旧分支，刚完成构建所使用的缓存会优先保留。

可以按 Docker 支持的容量格式调整：

```bash
BUILD_CACHE_MAX_USED_SPACE=10gb \
BUILD_CACHE_MIN_FREE_SPACE=16gb \
BUILD_CACHE_RESERVED_SPACE=4gb \
./scripts/update.sh
```

若识别到 `no space left on device` 等明确错误，脚本默认清理当前 builder 的全部未使用 BuildKit cache，并只重试一次构建。该操作使用 `docker buildx prune --all --force`，不会清理镜像、容器、网络或数据卷。

需要排查缓存现场或明确不允许本次调用删除任何 BuildKit cache 时，可以关闭构建前后维护与 ENOSPC 自动修复：

```bash
REPAIR_BUILD_CACHE_ON_NO_SPACE=false ./scripts/update.sh
```

`all` 会分别调用 `docker compose build dsa` 和 `docker compose build thesis-ledger`。Compose 的全局并发参数不能阻止同一次多目标 build 在 BuildKit 内并行，因此脚本不把两个 service 放入同一次 build 调用。

2026-10-05早期32 GiB上限及20 GiB全局GC读数仅为历史采样。当前空间整备会自动处理受保护政策允许的缓存和镜像，保留当前/必要回滚镜像与业务卷；这些受保护资源仍持续占盘，不能保证任意环境都能删减到目标。纯代码且快更兼容预检通过时优先使用`sync-code.sh`，减少完整构建。

阈值行为参考 [Docker Buildx prune 官方文档](https://docs.docker.com/reference/cli/docker/buildx/prune/)，后台回收策略参考 [BuildKit GC 官方文档](https://docs.docker.com/build/cache/garbage-collection/)。

## 设计原则

- 数据库重建执行器只接受开发编排传入的 `NODE_ENV=development`，生产发布不携带该入口；
- 为受限的本地 Docker 虚拟磁盘默认启用有界缓存维护，并保留显式关闭入口；
- 避免开发环境每次更新等待基础镜像检查；
- Docker Hub 延迟规避、命名依赖缓存与国内软件源只存在于 `update.sh` 的临时构建定义；共享 Dockerfile/Compose 不包含这些本地覆盖；
- 本地别名不会自动跟随官方 tag；在网络可用的受控窗口使用 `PULL_BASE_IMAGES=true` 获取更新和安全修复；
- 保持数据卷安全，不执行 `docker compose down -v`。
- 普通构建错误不触发全量缓存清理；Compose 启动失败和健康检查失败不执行额外缓存清理。
- 构建前后维护与磁盘不足修复都不执行 `docker system prune`，不删除镜像、容器或数据卷，也不停止运行中的无关容器。
- PostgreSQL 已有持久卷时，默认更新只做结构预检，不删除数据卷；开发重建只删除并重建 `public` schema，仍保留卷本身。
- 权限 SQL 在结构重建事务中通过 `psql` 执行，使用原有 `bootstrap-app-role.sql` 的 owner/app role 校验和 `LedgerEvent`、`SchemaVersion` 权限收紧逻辑。
- 应用容器只接收 app role 连接串；owner 凭证只存在于 PostgreSQL init 环境。

### 恢复已停止的原开发容器

Docker Desktop 已启动而原开发容器停止时，可执行 `node scripts/resume-existing-development.mjs --confirm=thesis-ledger-dev`。入口只接受当前 `desktop-linux` Unix 端点和既有五个项目容器，复用更新锁，先核对项目标签、镜像、容器身份及持久卷，再按 PostgreSQL/Redis → DSA → Server/Worker 的顺序启动并等待健康。缺容器、身份变化或依赖不健康即退出。

该入口不创建、重建、拉取镜像或修改卷，执行后再次核对原身份；只用于恢复已确认的开发运行态。源码、依赖或结构需要更新时仍按上述 `sync-code.sh` / `update.sh` 规则处理。合同测试：`node --test scripts/resume-existing-development.test.mjs`。

### 东财拆分的精确准入维护入口

`scripts/eastmoney-split-admission.mjs`只维护 `thesis-ledger-dev / 159516.SZ / 2026-03-30～2026-07-10`，复用主仓原映射JSON的完整字节，不接受其他证券、窗口、摘要或证据路径。默认仅读取宿主原文并生成待审批计划，不启动Docker、不安装文件或写数据库：

```bash
node scripts/eastmoney-split-admission.mjs --confirm=thesis-ledger-dev/159516.SZ/2026-03-30/2026-07-10 --sha256=b1a4f03f94faf27acf95d2bef9d508ec06eabec1280e04c921bb677154f5fe8e
```

计划默认提出24小时有效期、记录人为空，均不代表批准。未来只有明确签发授权后才能附加 `--apply`；应用还必须显式给出 `--valid-hours=1..24` 的整数值和 `--recorded-by=<审阅标识>`。入口核对本地Unix端点、更新锁、原DSA容器/镜像身份及命名持久卷，以dsa身份执行同目录目标端Python脚本；该Python文件是入口内部组件，不作为独立运维命令调用。

目标端只接受原数据库路径/已有结构，复用原MappingEvidenceStore和准入记录方法，避免普通ControlStore构造器的Schema初始化/凭据轮换。在原BEGIN IMMEDIATE事务持锁后检查精确记录不存在，已有/并发新增一律拒绝，不能续期、撤销、覆盖或自动重试；原受控证据先安全读回再记录。中途失败可能留下未授准入的同摘要证据；应用后回执/身份检查异常须只读核查，不以再次应用恢复。

该入口不选择主备、保存凭据、请求供应商或证明完整覆盖。`coverage=false`、普通完整冻结受阻继续保持。局部验证：`node --test scripts/eastmoney-split-admission.test.mjs`，以及用相邻DSA现有环境执行 `../daily-stock-analysis/.venv/bin/python -B scripts/eastmoney-split-admission.test.py`；后者仅新维护合同、原resolver新审阅包兼容及合成临时库并发守卫，不重跑旧映射测试。
