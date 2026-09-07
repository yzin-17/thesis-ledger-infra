# Docker 更新流程

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 优先使用本地基础镜像别名，不向 Docker Hub 查询已有基础镜像 tag；
- 首次镜像构建失败时保留 BuildKit cache 并重试一次；第二次失败直接退出；
- Compose 启动或服务健康检查失败时直接输出状态和目标服务日志，不重新构建镜像；
- 不主动刷新基础镜像。
- 不自动清理 BuildKit cache；只有明确检测到磁盘空间不足且本次调用显式授权时才执行有界清理。
- Docker CLI、Docker daemon 或环境参数预检失败时直接退出。
- PostgreSQL 空卷由官方 init 路径安装 current baseline、创建 app role 并收紧 `LedgerEvent` 权限；owner/app role 为空或同名时初始化失败。
- PostgreSQL 健康检查同时验证连接和 `THESIS_LEDGER_SCHEMA_VERSION`；版本缺失或不匹配时不启动 ThesisLedger。
- ThesisLedger 只接收 app role 连接串，并只依赖 PostgreSQL、Redis 与 DSA 的健康状态。

## 本地临时构建定义

仓库中的共享 Dockerfile 和 `compose.dev.yml` 继续引用官方基础镜像、沿用原有依赖安装写法，DSA Dockerfile 继续声明 `# syntax=docker/dockerfile:1.7`；同时不再包含 Aliyun 或 npmmirror 的 Dockerfile 级覆盖。生产、CI、直接 `docker build` 和直接 `docker compose build` 都不会使用本地别名、本地命名 cache 或脚本注入的软件源。

`update.sh` 只在单次本地执行期间创建临时 Dockerfile 与 Compose override。临时 DSA Dockerfile 会移除外部 frontend 声明，把官方 `FROM` 替换为本地别名，为 npm、APT lists、APT archives 与 pip 注入稳定命名 cache，并把 Debian 源替换为 Aliyun HTTPS mirror；临时 ThesisLedger Dockerfile 会替换 `FROM`、补齐 workspace manifest、注入 pnpm store cache，并为 corepack、npm/pnpm 与 node-gyp 设置 npmmirror。脚本退出时删除这些临时文件，不改写源码目录。该本地路径要求 Docker/BuildKit 自带的 frontend 支持稳定版 `RUN --mount=type=cache`；当前验证环境为 Docker 29.7.2 与 Buildx 0.36.1。

这里的边界只覆盖 Dockerfile 级软件源配置。包管理器仍会遵循仓库既有 lockfile 中记录的完整下载地址；`update.sh` 不改写 lockfile、业务 Provider 或 DashScope 配置。

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
docker compose build dsa thesis-ledger
```

拉取失败时不会更新别名，也不会开始应用镜像构建；已有可运行镜像和容器保持不变。

## 刷新基础服务镜像

PostgreSQL 和 Redis 默认不刷新。

如需刷新：

```bash
PULL_SERVICE_IMAGES=true ./scripts/update.sh
```

## 磁盘空间不足时修复缓存

脚本识别到 `no space left on device` 等明确磁盘空间错误时，默认保留缓存并退出。确认可以清理未使用的 BuildKit cache 后，可在本次调用中显式开启有界修复：

```bash
REPAIR_BUILD_CACHE_ON_NO_SPACE=true ./scripts/update.sh
```

默认以 `8gb` 为清理后的最小空闲空间目标，可按 Docker 支持的容量格式调整：

```bash
REPAIR_BUILD_CACHE_ON_NO_SPACE=true \
BUILD_CACHE_MIN_FREE_SPACE=12gb \
./scripts/update.sh
```

该路径执行 `docker builder prune --force --min-free-space <容量>` 后只重试一次构建；不会使用 `--all`，也不会清理镜像、容器或数据卷。

## 设计原则

- 不绑定 development / production 等环境名称；
- 通过显式参数控制构建行为；
- 避免开发环境每次更新等待基础镜像检查；
- Docker Hub 延迟规避、命名依赖缓存与国内软件源只存在于 `update.sh` 的临时构建定义；共享 Dockerfile/Compose 不包含这些本地覆盖；
- 本地别名不会自动跟随官方 tag；在网络可用的受控窗口使用 `PULL_BASE_IMAGES=true` 获取更新和安全修复；
- 保持数据卷安全，不执行 `docker compose down -v`。
- 普通构建重试、Compose 启动失败和健康检查失败都不清理 BuildKit cache。
- 磁盘不足修复不执行 `docker system prune`，不删除镜像、容器或数据卷，也不停止运行中的无关容器。
- PostgreSQL 已有持久卷时，`POSTGRES_OWNER_PASSWORD` 必须保持为卷初始化时的密码；Schema 版本不匹配时必须显式重建 PostgreSQL external volume。
- `POSTGRES_APP_PASSWORD` 只在 fresh init 时创建 app role；已有卷不会重新执行 init SQL。修改后仅重建 ThesisLedger 不会生效，必须由 owner 执行角色密码轮换并重建应用容器，或在受控窗口重建 fresh PostgreSQL volume。
- 应用容器只接收 app role 连接串；owner 凭证只存在于 PostgreSQL init 环境。
