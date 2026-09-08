# Docker 更新流程

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 在构建前后有界维护 BuildKit cache，默认最大缓存 `8gb`、最小空闲空间 `18gb`、缓存保留底线 `4gb`；
- `all` 目标逐个调用 Compose build，避免两个应用同时冷构建产生叠加磁盘峰值；
- 优先使用本地基础镜像别名，不向 Docker Hub 查询已有基础镜像 tag；
- 首次普通镜像构建失败时保留 BuildKit cache 并重试一次；首次明确空间不足时清理当前 builder 的全部未使用缓存后重试一次；第二次失败直接退出；
- Compose 启动或服务健康检查失败时直接输出状态和目标服务日志，不重新构建镜像；
- 不主动刷新基础镜像。
- Docker CLI、Docker daemon 或环境参数预检失败时直接退出。
- PostgreSQL 空卷由官方 init 路径安装 current baseline、创建 app role 并收紧 `LedgerEvent` 权限；owner/app role 为空或同名时初始化失败。
- PostgreSQL 健康检查同时验证连接和 `THESIS_LEDGER_SCHEMA_VERSION`；版本缺失或不匹配时不启动 ThesisLedger。
- ThesisLedger 只接收 app role 连接串，并只依赖 PostgreSQL、Redis 与 DSA 的健康状态。

## 本地临时构建定义

仓库中的共享 Dockerfile 和 `compose.dev.yml` 继续引用官方基础镜像、沿用原有依赖安装写法，DSA Dockerfile 继续声明 `# syntax=docker/dockerfile:1.7`；同时不再包含 Aliyun 或 npmmirror 的 Dockerfile 级覆盖。生产、CI、直接 `docker build` 和直接 `docker compose build` 都不会使用本地别名、本地命名 cache 或脚本注入的软件源。

`update.sh` 只在单次本地执行期间创建临时 Dockerfile 与 Compose override。临时 DSA Dockerfile 会移除外部 frontend 声明，把官方 `FROM` 替换为本地别名，为 npm、APT lists、APT archives 与 pip 注入稳定命名 cache，并把 Debian 源替换为 Aliyun HTTPS mirror；临时 ThesisLedger Dockerfile 会替换 `FROM`、补齐 workspace manifest，让 `pnpm install` 与 `pnpm deploy` 复用同一个命名 store，通过 `COREPACK_NPM_REGISTRY`、`pnpm_config_registry`、`npm_config_registry` 与 `npm_config_disturl` 分别为 Corepack、pnpm 11、npm 兼容子进程和 node-gyp 设置 npmmirror，并让 build/runtime 两次 `prisma generate` 复用同一个 `/root/.cache/prisma` 命名 cache。脚本退出时删除这些临时文件，不改写源码目录。该本地路径要求 Docker/BuildKit 自带的 frontend 支持稳定版 `RUN --mount=type=cache`；当前验证环境为 Docker 29.7.2 与 Buildx 0.36.1。

这里的边界只覆盖 Dockerfile 级软件源配置。包管理器仍会遵循仓库既有 lockfile 中记录的完整下载地址；`update.sh` 不改写 lockfile、业务 Provider 或 DashScope 配置。

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

## BuildKit 缓存空间维护

脚本默认在应用构建前后执行 BuildKit 有界维护：

```bash
docker buildx prune --all --force \
  --max-used-space 8gb \
  --min-free-space 18gb \
  --reserved-space 4gb
```

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

当前本地 Docker 虚拟磁盘只有 32GB。若单个串行冷构建在清空 BuildKit cache 后仍超过可用空间，只能提高 Docker Desktop 虚拟磁盘容量；脚本不会删除其他 Docker 资源来换取空间。

## 设计原则

- 不绑定 development / production 等环境名称；
- 为受限的本地 Docker 虚拟磁盘默认启用有界缓存维护，并保留显式关闭入口；
- 避免开发环境每次更新等待基础镜像检查；
- Docker Hub 延迟规避、命名依赖缓存与国内软件源只存在于 `update.sh` 的临时构建定义；共享 Dockerfile/Compose 不包含这些本地覆盖；
- 本地别名不会自动跟随官方 tag；在网络可用的受控窗口使用 `PULL_BASE_IMAGES=true` 获取更新和安全修复；
- 保持数据卷安全，不执行 `docker compose down -v`。
- 普通构建错误不触发全量缓存清理；Compose 启动失败和健康检查失败不执行额外缓存清理。
- 构建前后维护与磁盘不足修复都不执行 `docker system prune`，不删除镜像、容器或数据卷，也不停止运行中的无关容器。
- PostgreSQL 已有持久卷时，`POSTGRES_OWNER_PASSWORD` 必须保持为卷初始化时的密码；Schema 版本不匹配时必须显式重建 PostgreSQL external volume。
- `POSTGRES_APP_PASSWORD` 只在 fresh init 时创建 app role；已有卷不会重新执行 init SQL。修改后仅重建 ThesisLedger 不会生效，必须由 owner 执行角色密码轮换并重建应用容器，或在受控窗口重建 fresh PostgreSQL volume。
- 应用容器只接收 app role 连接串；owner 凭证只存在于 PostgreSQL init 环境。
