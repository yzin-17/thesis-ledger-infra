# Docker 本地构建空间保护 Spec

## 背景与问题

本地 Docker Desktop 虚拟磁盘容量为 32GB。一次故障前，BuildKit 累积了 209 条缓存记录并占用 27.6GB；镜像、容器和数据卷另占约 4.8GB。ThesisLedger 在 `pnpm deploy` 下载和解包生产依赖时因此触发 `ERR_PNPM_ENOSPC`，而更新脚本只在构建失败后识别空间不足，且默认要求调用方再次显式授权清理，导致本次更新直接失败。

BuildKit 的缓存未命中只会产生新的缓存分支，不会立即删除旧分支。当前 builder 的 GC 策略还会保留较大的近期缓存，因此更新脚本需要在自身执行边界内主动控制缓存规模与冷构建峰值。

## 目标

- 普通本地更新开始前为冷构建预留足够空间，避免旧缓存挤占构建临时空间。
- 构建成功后淘汰较旧的缓存分支，防止缓存长期回到接近虚拟磁盘容量的水平。
- 降低同时冷构建 DSA 与 ThesisLedger 时的磁盘峰值。
- 让 ThesisLedger 的 `pnpm install` 与 `pnpm deploy` 复用同一 BuildKit pnpm store。
- 让本地 ThesisLedger 构建中的 pnpm 11 依赖解析使用 npmmirror。
- 让本地 ThesisLedger 构建复用 Prisma 引擎下载缓存，避免源码层失效后重复访问引擎 CDN。
- 空间不足时先整备可回收 Docker 内容，达到宿主20 GiB及Docker18 GiB目标后再构建；构建中的ENOSPC仍最多恢复一次。

## 非目标

- 不修改共享 DSA、ThesisLedger Dockerfile 或 Compose 文件的生产行为。
- 不修改 Docker Desktop 的全局磁盘容量或 GC 配置。
- 不删除容器、网络或任何数据卷；镜像清理仅允许下述确定的未引用候选，不清理宿主应用或工程文件。
- 不保证在单个串行冷构建本身超过 Docker 虚拟磁盘可用容量时仍能成功。
- 不通过解析 BuildKit 文本日志判断每一个缓存步骤是否命中。

## 现状与约束

- `update.sh` 通过临时 Dockerfile 和 Compose override 注入本地镜像别名、国内软件源与命名 cache mount，退出时删除临时文件。
- 修改前的脚本默认 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false`，仅在构建已经失败后执行一次 `docker builder prune --min-free-space`。
- `all` 目标目前将两个服务交给一次 Compose build，Compose 可并行执行构建。
- 临时 ThesisLedger Dockerfile 只在 `pnpm install` 使用命名 pnpm store；`pnpm deploy --legacy` 未挂载同一个 store。
- 当前 Docker/Buildx 支持 `max-used-space`、`min-free-space` 与 `reserved-space`。

## 设计方案

### 2026-10-07：构建前 Docker 空间整备

#### 2026-10-14：共享磁盘的紧张期回滚范围

本轮用户进一步明确取消紧张期“至少保留1个历史回滚”的底线。现行BUILD_SPACE_ROLLBACK_KEEP_COUNT默认0，取代此前紧张期默认1；常规ROLLBACK_IMAGE_KEEP_COUNT默认2及其正整数合同保持。专属space-recovery模式允许零个未保护历史版本，但当前运行/停止容器引用、指定基线、额外标签、更新前基线、探针及本次构建产物仍强制保留，保护数量可以超过目标。

容量恢复在同一正式更新锁中逐个退役最旧候选，每次最多删除1个精确回滚标签，随后实测宿主及Docker余量并按需回收Desktop空闲块。达到两项门槛即停止退役并继续原最小构建目标；没有实际删除、候选已转为保护对象、库存读取失败或发现并行构建时停止，不循环重试同一前提。space-recovery执行只能借用已验证的更新锁；没有候选以独立返回状态表达，不混同清理失败。关闭自动维护不进入该路径。

AC14：零紧张期目标只经space-recovery接缝使用，普通维护仍拒绝零；候选按最旧顺序逐个执行，达标后不再删除下一候选，必要时连续退役多个直到达标或无候选。单目标/全局回滚范围、全部保护及并发重验保持。定向验证覆盖一次达标、多次达标、无候选仍不足、失败、关闭、零模式锁限制及保护数量超过零目标；实际验收完成正式update.sh dsa、新镜像版本及原新旧快照兼容核对，不重采供应商。

本地两个应用使用同一Docker及宿主磁盘。构建目标仍为最小的dsa或thesis-ledger；常规镜像整备只处理所选应用，但缓存、常规整备及Desktop回收后仍不足时，紧张期回滚阶段应检查两个应用的超额历史回滚镜像，不能随构建目标漏掉另一个应用的可回收版本。沿用BUILD_SPACE_ROLLBACK_KEEP_COUNT、原专用回滚执行器、同一更新锁和逐候选复核，不扩大到另一个应用的普通开发标签或其他有标签镜像。

所有现存容器引用、指定基线、更新前基线、探针和本次构建产物继续保护，常规保留配置不改写。清理后实测并按需回收Desktop空闲块，满足宿主20GiB/Docker18GiB才继续；没有可清候选或实际仍不足时保留具体缺口并停止。关闭自动修复不执行该阶段，不降低门槛或清理容器、卷、备份及宿主文件。

AC13：单目标更新在紧张期能够发现另一应用的超额回滚版本；正常清理仍限定所选应用，保护/锁参数贯穿全局回滚执行，失败或不足不进入构建。自动回归覆盖dsa和thesis-ledger两个单目标；真实验收经正式update.sh dsa记录精确候选、实际余量、构建及目标镜像，不以候选逻辑大小代替释放量。

2026-10-08用户明确允许清理最旧回滚镜像，并要求更新脚本自动包含回滚镜像清理。常规保留数仍由`ROLLBACK_IMAGE_KEEP_COUNT`控制，默认2；缓存、常规镜像整备和Desktop空闲块回收后仍不足时，容量恢复流程可按`BUILD_SPACE_ROLLBACK_KEEP_COUNT`的紧张期目标清理，默认1且必须为正安全整数。此目标不改写常规配置，只在低容量阶段更少保留未引用历史回滚镜像；设为常规数量或更大时不启用该阶段。

紧张期清理沿用原维护入口、更新锁、候选逐项复核和精确标签删除；现存容器、显式保护、本次更新前基线、探针及已成功构建产物继续保护，保护数量可以超过目标。清理后先实测，再按需回收Desktop空闲块并复测；仍不足或任一步失败即停止，不降低宿主20 GiB/Docker18 GiB门槛，不删除备份文件、容器或volume。默认清理关闭时也关闭本阶段。

用户要求将20 GiB作为脚本主动整备后的宿主空闲目标，而不是要求调用方先自行准备。正式`update.sh`在拉取及每个服务构建前，持同一更新锁执行缓存维护和空间实测；不足时清空可回收缓存并复测，仍不足则执行受保护的镜像整备，再复测。默认自动开启；现有`REPAIR_BUILD_CACHE_ON_NO_SPACE=false`关闭自动空间修复，但不能把不足或未知空间当作满足目标。

镜像整备使用现有回滚保留数量/指定基线政策。全部现存容器（含停止状态）引用的镜像、指定基线、探针镜像、本次更新已成功构建且尚未启动的产物以及所有其他有标签镜像受保护。可删除候选只包括超额且无额外标签的回滚标签、无容器引用且无标签的镜像，以及所选应用唯一开发标签（`daily-stock-analysis:thesisledger-dev`、`thesis-ledger:dev`）指向的未使用构建产物。后者在更新时会重新构建，不包含运行容器的镜像。不会强制删除镜像或级联清理其父镜像，不删除业务卷、容器、备份或宿主缓存。

每次删除前重新核对完整ID、所有容器引用、标签、指定保护及保留政策，发现活动构建或库存读取失败即停止。清理在更新锁内执行；只读预览不变更Docker。共享层释放量以清理后实际`df`为准，不把镜像逻辑大小或成功删除标签当作宿主空间已释放。

Mac标准Docker Desktop且存在Docker.raw时，删减后宿主仍不足可触发[官方空闲块回收](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)。工具固定为`docker/desktop-reclaim-space@sha256:8b26e45c51632fd78131f3bddca76122bebc1dd8376f16dd26f769c7f33121fd`，已核验官方仓库的linux/amd64清单，大小32021字节。仅在同一更新锁及空闲builder下启动自动删除、无网络、只读根文件系统的临时容器；官方工具需要临时privileged及VM的host PID命名空间来回收空闲块，不挂载宿主或业务目录，不创建持久权限、不改变磁盘最大容量。非标准Desktop环境跳过，失败不放行。全部安全清理和回收后仍不足时，报告目标、实测缺口及保护边界并停止，不降低目标或删除受保护数据来强行达标。

### 2026-10-05：实测空间门禁

当前更新前的 GC 成功不代表达到空闲目标。新增 `scripts/build-space.sh`，在拉取前及每个应用构建前执行以下流程：固定当前本地 Docker context 的 `docker` driver builder，检查没有其他运行中的构建，进行有界维护，实测宿主机和 Docker 文件系统空闲空间。若不足且自动维护开启，清空该 builder 的可回收缓存一次并重新测量；仍不足、读取失败或发现其他构建时，在继续拉取/构建之前退出。`REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 关闭所有清理，但不能关闭空间检查。

Docker 空闲硬门槛复用 `BUILD_CACHE_MIN_FREE_SPACE`（默认 `18gb`）；宿主机门槛 `BUILD_HOST_MIN_FREE_SPACE` 默认 `20gb`。容量参数接受非负数字及 b/k/kb/m/mb/g/gb/t/tb（大小写不敏感，1024 进位），空闲门槛必须大于零。宿主机检查源码目录及 `BUILD_SPACE_HOST_PATH` 指定文件系统；默认使用标准 Docker Desktop 数据目录（存在时），否则使用源码目录。自定义 Docker 磁盘位置必须显式指定。远端 daemon、自定义或多节点 builder 不在本地探测支持范围内，明确拒绝，不能拿本地余量代替远端余量。

Docker 探测使用已有本地基础镜像的固定 ID，以无网络、只读根目录、无业务卷挂载的临时容器执行 `df -Pk /`，不拉取探针镜像。没有可用本地基础镜像时给出明确失败说明。宿主机使用 `df -Pk`，任何未知值均不能当作充足。Compose build 与 prune 显式指定同一 builder。更新入口以本机用户和 daemon 地址为键使用互斥目录；正常退出移除自己的锁，异常遗留锁明确报告路径，禁止自动抢占。

本轮已观察到 32 GiB Docker 上限、约 11.2 GiB Docker 空闲和 GC 20 GiB 保留底线；另一个 DSA 构建正在运行。上述读数只用于诊断，不代表未来可用容量。修复脚本可阻止在明显不足时开工，但容量规划仍须覆盖最大单次构建峰值和保留镜像。全局 GC/磁盘扩容、旧回滚镜像删除均不由本脚本自动执行。

### 有界缓存维护

默认启用 BuildKit 缓存空间维护，并保留 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 作为显式关闭入口。默认阈值为：

- 最大缓存占用：8GB；
- 目标最小空闲空间：18GB；
- 缓存保留底线：4GB。

拉取前及每个应用构建前执行有界维护和实测门禁。若维护命令失败，则在开始应用构建前退出，避免在无法确认空间状态时继续消耗磁盘。

应用构建成功后再次执行相同的有界维护，以 LRU 顺序优先淘汰旧分支并保留刚使用的缓存。构建后维护失败只输出警告，不阻止已成功构建的镜像继续启动。

上述阈值是 BuildKit GC 目标而非 `docker system df` 总数的硬上限。正在使用的记录不能删除；与最终镜像共享的层即使删除缓存元数据也不会释放镜像仍引用的实际层；缓存保留底线还会限制本轮 GC 能继续释放的空间。验收时需同时记录 Private、Reclaimable 与 Docker 磁盘实际空闲空间，不能只用 Build Cache 总数判断维护是否生效。

### 构建并发

`all` 目标逐个 service 调用 Compose build，不把 DSA 与 ThesisLedger 同时提交给 BuildKit。Compose 的全局并发参数无法阻止同一次多目标 build 在 BuildKit 内并行，因此不能用它代替逐服务调用。单目标行为保持一致。

### pnpm store 复用

临时 ThesisLedger Dockerfile 为 `pnpm deploy --prod ... --legacy` 注入与 `pnpm install` 相同的命名 cache mount。共享 ThesisLedger Dockerfile 保持原状。

### pnpm registry

临时 ThesisLedger Dockerfile 同时设置以下本地构建环境变量：

- `COREPACK_NPM_REGISTRY`：控制 Corepack 获取 pnpm；
- `pnpm_config_registry`：控制 pnpm 11 解析和获取项目依赖；
- `npm_config_registry`：供仍读取 npm 配置的生命周期子进程使用；
- `npm_config_disturl`：供 node-gyp 获取 Node.js 构建资源。

上述变量均只存在于脚本生成的临时 build stage，值指向 npmmirror；共享 Dockerfile、生产构建和仓库 lockfile 保持原状。

### Prisma 引擎缓存

临时 ThesisLedger Dockerfile 为 build stage 与 runtime stage 的两次 `prisma generate` 注入同一个命名 BuildKit cache，挂载到 Prisma 6.19.3 在 Linux 下使用的 `/root/.cache/prisma`。第一次成功下载并校验的引擎会写入该 cache；后续即使 `COPY . .` 因源码变化使生成层失效，Prisma 仍可从该 cache 复制匹配 commit 与 binary target 的引擎。

当前 Prisma 6.19.3 所需 commit `c2990dca591cba766e3b7ef5d9e8a84796e47ab7` 的 `linux-musl-arm64-openssl-3.0.x` 校验文件在 npmmirror 常见 Prisma 镜像入口均返回 `404`，因此不设置错误的 `PRISMA_ENGINES_MIRROR`。首次冷缓存仍使用 Prisma 默认 CDN，并保留 checksum 校验；瞬时网络失败继续由 Prisma 内部下载重试和 `update.sh` 的一次构建重试处理。

### 空间不足恢复

若构建日志包含 `no space left on device`、`not enough disk space` 或 `insufficient disk space`：

1. 默认对当前 builder 的全部未使用 BuildKit cache 执行一次清理；
2. 从应用构建起点重试一次；
3. 第二次失败时保留现场并返回失败，不进行第三次构建，也不触碰其他 Docker 资源。

普通构建错误仍保留缓存并重试一次。

## 对外行为或接口变化

- `REPAIR_BUILD_CACHE_ON_NO_SPACE` 默认值由 `false` 改为 `true`，并同时控制构建前后有界维护与 ENOSPC 自动恢复；设置为 `false` 可关闭所有自动缓存清理。
- 新增 `BUILD_CACHE_MAX_USED_SPACE`，默认 `8gb`。
- `BUILD_CACHE_MIN_FREE_SPACE` 默认值由 `8gb` 改为 `18gb`。
- 新增 `BUILD_CACHE_RESERVED_SPACE`，默认 `4gb`。
- 本地脚本生成的 ThesisLedger build stage 中，pnpm 11 的有效 registry 为 `https://registry.npmmirror.com/`。
- 本地脚本生成的 ThesisLedger 两个 `prisma generate` 步骤共享命名 Prisma 引擎 cache；生产 Dockerfile 不新增 cache mount 或引擎镜像设置。

## 数据、状态或兼容性影响

- 被清理的 BuildKit 缓存不可恢复，后续构建可能重新下载或编译依赖。
- 镜像、运行中或停止的容器、网络及数据卷不受缓存维护影响。
- 本地临时构建定义仍在脚本退出时删除，仓库中的共享 Dockerfile 与 Compose 配置不包含本地缓存策略。
- 若本地 Docker/Buildx 版本不支持空间阈值参数，构建前维护会明确失败，不会静默继续。

## 测试策略

### 关键可观察行为

- 默认成功更新在拉取前、每个服务构建前及构建后执行带三个空间阈值的 Buildx prune。
- 显式关闭缓存维护时不执行任何 prune。
- `all` 构建对 DSA 与 ThesisLedger 分别执行一次 Compose build，不出现包含两个 service 的单次 build 调用。
- 临时 ThesisLedger Dockerfile 的 install 与 deploy 均使用同一个 pnpm store ID。
- 与构建相同的 pnpm 11 环境中，`pnpm config get registry` 返回 `https://registry.npmmirror.com/`。
- 临时 ThesisLedger Dockerfile 的两次 `prisma generate` 均挂载同一个 `/root/.cache/prisma` cache，且共享 Dockerfile 仍保留原始命令。
- Prisma 引擎 cache 已填充时，使源码复制层失效后重新构建不再请求 `binaries.prisma.sh`。
- 首次 ENOSPC 会执行一次全量未使用缓存清理并重试；普通错误不执行全量清理。
- 共享 Dockerfile 与 Compose 文件保持原样。

### 优先测试层级

1. Shell 语法检查。
2. 静态核对缓存维护、逐服务构建、pnpm store、pnpm registry 和重试分支。
3. 在清空 BuildKit cache 后执行一次真实本地更新，并核对构建结果与缓存/磁盘占用。

### 可复用的现有测试入口

- `bash -n scripts/update.sh`
- `git diff --check`

### 需要新增的测试入口

新增 `scripts/build-space.test.sh`，用替身覆盖清理后空间仍不足、宿主机不足、读取失败、显式关闭清理、builder 一致性、并发阻止和逐服务门禁。真实空间探测与真实更新分别记录，替身不能替代部署验收。

### 关键边界与回归场景

- 非法预检参数不得触发 prune、pull、build 或 up。
- 基础镜像准备失败不得开始应用构建。
- 启动或健康检查失败不得额外清理 BuildKit cache。
- 第二次构建失败不得进行第三次重试。
- 显式关闭自动缓存管理时继续保持原有“不自动删除缓存”行为。

## 风险与备选方案

- 8GB 上限可能淘汰较旧分支的依赖缓存，使分支切换后的首次构建变慢；相较 32GB 虚拟磁盘发生 ENOSPC，该取舍可接受。
- Build Cache 总数可能因活跃记录或镜像共享层高于 8GB；该差异不等于同等规模的额外物理占用，也不应通过删除镜像或数据卷强行满足阈值。
- 负向自动回归使用 Docker 命令替身覆盖普通失败、ENOSPC 修复、二次失败及空间门禁；真实构建峰值与 Docker daemon 故障仍需独立运行态证据。
- `--all` 允许清理内部/frontend 缓存；空间紧张后的首次构建可能重新解析 frontend。使用本地临时 Dockerfile移除 DSA 的外部 frontend 声明，可减少该影响。
- Prisma 引擎命名 cache 仍属于 BuildKit cache；有界维护或 ENOSPC 全量清理可能淘汰它，淘汰后的首次构建仍依赖 Prisma 默认 CDN。
- 若真实串行冷构建仍使用超过清空缓存后的约 24GB 可用空间，需要提高 Docker Desktop 虚拟磁盘容量，脚本无法通过清缓存突破物理上限。

## 未决问题

### Blocking

无。

### Non-blocking

无。

## 验收标准

- AC1：默认更新在构建前后执行仅针对 BuildKit cache 的有界维护，默认最大缓存 8GB、最小空闲空间 18GB、缓存保留底线 4GB，且可显式关闭。
- AC2：`all` 目标逐个 service 调用 Compose build，不将 DSA 与 ThesisLedger 同时提交给 BuildKit，以降低冷构建峰值。
- AC3：本地临时 ThesisLedger Dockerfile 的 `pnpm install` 与 `pnpm deploy` 复用同一命名 pnpm store，共享 Dockerfile 保持不变。
- AC4：首次 ENOSPC 默认全量清理当前 builder 的未使用 BuildKit cache 并重试一次，普通错误不执行全量清理，第二次失败不再重试。
- AC5：更新流程不删除容器、网络或数据卷；镜像整备只能删除AC12限定的候选，相关文档准确描述默认行为与可配置参数。
- AC6：Shell 语法检查、静态契约核对和一次真实冷缓存更新均提供明确验证结果；若运行时阶段因独立环境问题失败，应分别记录构建阶段结果与运行时阻塞。
- AC7：本地临时 ThesisLedger build stage 同时为 Corepack、pnpm 11、npm 兼容子进程和 node-gyp 配置对应的 npmmirror 入口；在与构建一致的 pnpm 11 环境中读取到的有效 registry 为 `https://registry.npmmirror.com/`，共享 Dockerfile 与生产构建行为不变。
- AC8：本地临时 ThesisLedger Dockerfile 的两次 `prisma generate` 复用同一个 `/root/.cache/prisma` 命名 cache；首次成功获取后，源码层失效不会再次下载相同 commit 与 binary target 的引擎；checksum 校验、共享 Dockerfile 和生产构建行为保持不变。
- AC9：更新拉取前和每个服务构建前实测宿主机与 Docker 空闲量；有界清理不达标时自动全清可回收缓存一次，复测不达标或未知时阻止后续构建。关闭清理仍执行检查。
- AC10：探针不拉取镜像、不访问业务卷；固定 builder 同时用于探测、清理与构建；不支持的远端或自定义 builder、正在运行的构建和重复更新被明确拒绝。
- AC11：定向负向回归、既有部署脚本回归和真实只读探测分别记录；实际清理及一次官方更新作为独立运行态门禁，存在其他活动构建时保持未完成。
- AC12：构建前不足可通过受保护的镜像整备恢复到目标；容器/指定基线/额外标签/保留数量/基础镜像保护、候选重验、并发与借锁校验、清理关闭、无候选仍不足及实际空间不释放的拒绝均有自动回归。实际目标清理记录精确候选、前后空间、容器/卷/持久状态保护和正式入口结果。
