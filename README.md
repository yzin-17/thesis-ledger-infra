# ThesisLedger 开发栈

文档从[文档中心](docs/README.md)进入，更新与恢复操作见[运维指南](docs/guides/README.md)。

本仓库只负责把三个独立仓库串联起来：

- `../thesis-ledger`：主系统源码。
- `../daily-stock-analysis`：DSA Fork 及其 ThesisLedger 的 `dsa-data-v1` 与 `dsa-control-v1` 接口。
- `thesis-ledger-infra`：本地 Compose、镜像更新、挂载与运行保护。

父目录不纳入 Git。脚本只会 clone 缺失仓库；如果仓库已经存在，不会自动切换分支、拉取或修改工作树。

宿主运行要求为 Node.js 24、Git 和 Docker CLI；应用构建及快更仍需相应包管理器。`scripts/*.sh` 保留原有入口和参数，只转发到 Node；编排、校验与维护工具使用 Node 内置模块，宿主无需安装 Python。DSA 镜像内的 Python 由 DSA 自行维护。

开发测试先执行 `pnpm install --frozen-lockfile`，再运行 `pnpm test`；按文件筛选和监听见[测试说明](docs/guides/docker-update-workflow.md#运行环境与入口)。Vitest 只作为开发依赖安装。

本仓库是唯一的 Docker 编排入口，Compose 项目名固定为 `thesis-ledger-dev`。`compose.yml` 是基础配置，`compose.dev.yml` 是源码构建覆盖；两者共同组成同一个开发栈，不是两套独立服务。主仓库不再单独启动 Docker。

PostgreSQL 只负责进程存活检查；开发数据库结构由主仓的结构执行器统一发现并以 psql 在目标库内重建。执行器会按目录排序执行全部 migration SQL、包含 `raw-owned-tables.json` 登记表、初始化 app role 权限并写入当前 head。`POSTGRES_OWNER_USER` 与 `POSTGRES_APP_USER` 必须是不同的非空角色；角色校验失败会使重建失败。应用容器只接收 `POSTGRES_APP_USER` 连接串，不会获得 owner 连接串。现有持久卷不会被自动重置；默认更新只做结构预检，结构不匹配时阻止新版应用启动。只有显式设置 `DEV_DATABASE_MODE=rebuild`、`DEV_DATABASE_ALLOW_DATA_LOSS=true` 和精确的 `DEV_DATABASE_CONFIRM=thesis-ledger-dev/<数据库名>` 才会清空目标 `public` schema，且不会删除 PostgreSQL volume。

## AI 服务配置

AI 服务的地址、模型、API Key、用途与默认模型统一在 ThesisLedger 的 Provider 页面管理，配置由 Server 校验并加密保存到数据库。Compose 不再透传 Provider 环境配置或自动演示开关。

从旧环境配置升级前，先通过页面录入对应服务；仅存在于旧 `.env` 中的 Provider 升级后不会加载。数据库已有配置、凭证与历史记录保留，不自动导入、删除或改写实际 `.env`。`CREDENTIAL_ENCRYPTION_KEY`、数据库连接、超时、研究预算策略和执行开关继续由部署环境管理；保留原加密主密钥以读取已有凭证。

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

`compose.dev.yml` 配置本机源码构建及 Longbridge 本机授权回调，不会把 DSA 源码复制到主仓库。页面凭证与授权部署见[数据源页面凭证与本机授权](../daily-stock-analysis/docs/guides/provider-credentials.md)。

### 一键更新源码栈

```bash
./scripts/update.sh
```

脚本默认使用 `.env`；不存在时回退到 `.env.example`。两个应用直接维护 Dockerfile、依赖缓存及下载源；infra 通过 Compose 传入本地基础镜像别名和 SDK 源上下文。构建时使用 Aliyun Debian mirror 与 npmmirror；基础镜像缺失时才必要拉取。`all` 逐个构建应用，普通构建失败保留缓存重试一次，真实空间不足自动保卷恢复一次；启动或健康检查失败不再次构建。退出时清理本轮日志和 Compose override，保卷恢复挂载配置持久保存。只修改一个源码仓库时可缩小范围：

```bash
./scripts/update.sh dsa
./scripts/update.sh thesis-ledger
```

更新入口在拉取前整备并实测空间。Docker `18gb`、宿主 `20gb` 是清理参考目标，未达到目标但实测仍有可用空间时继续构建；仅未达参考值不会清空全部热缓存和基础镜像。构建一个应用后先回收普通中间层，保留命名依赖缓存，减少两个应用构建占用叠加。真实 ENOSPC 或零余量时自动执行一次本开发项目保卷重装，记录并接回命名和匿名卷，再构建全部应用并通过既有数据库检查后启动；新服务健康后解除旧基线保护，按实际容量退役旧回滚并回收空闲块。同一 daemon 更新互斥，未知余量或活动构建停止。自定义 Docker 磁盘位置须设置 `BUILD_SPACE_HOST_PATH`；更多说明见[空间维护](docs/guides/docker-update-workflow.md#buildkit-缓存空间维护)。

默认 `UPDATE_SPACE_MODE=auto`。明确需要仅保留卷重新安装时，使用同一正式入口：

```bash
DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=compact ./scripts/update.sh all
```

compact 会停止本开发项目、清理其容器/网络和全部未引用镜像，再重建服务；保留所有命名/匿名卷及挂载，不清库。固定 SDK 源在停机前预取，失败时不会先停服务；与 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 冲突时明确拒绝。


当前镜像依赖与数据库结构均未变化、只需要更新应用代码时，可以使用快速入口：

```bash
./scripts/sync-code.sh
./scripts/sync-code.sh dsa
./scripts/sync-code.sh thesis-ledger
```

该脚本把数据代码或宿主构建产物同步到现有容器，重启并核对同一镜像。DSA 使用 `dsa-data-runtime-v1` 合同，只装配数据入口、`api/`、`data_provider/`、`src/` 及指定数据脚本；依赖、原生 SDK、Dockerfile、存储结构输入、启动命令和代码挂载均须兼容。旧镜像须先通过 `update.sh dsa` 完整更新。快更位于容器可写层，重建后恢复镜像内代码。详见[Docker 更新流程](docs/guides/docker-update-workflow.md#快速仅代码更新)。

完整更新会在空间整备和构建前记录 DSA 的不可变镜像、原 API 命令及全部实际挂载，并持续保留匿名卷映射。需要恢复镜像基线时，执行 `bash scripts/restore-dsa.sh <更新前快照.json>`；入口共用更新锁，只重建 DSA，核对原镜像、命令、挂载及健康。快照仅保存环境文件摘要；恢复时要求原环境、镜像和所有挂载仍可用。详见[DSA 运行态恢复](docs/guides/docker-update-workflow.md#dsa-运行态恢复)。

如需刷新 PostgreSQL 和 Redis 的服务镜像，可显式开启：

```bash
ENV_FILE=.env PULL_SERVICE_IMAGES=true HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh
```

如需拉取官方应用基础镜像并刷新本地别名，可显式开启：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

脚本不会执行 `docker compose down -v`，不会删除或重置 PostgreSQL、Redis 和 DSA SQLite 数据卷；如果宿主机端口被其他进程占用，脚本会报告 Compose 状态并退出，不会自动停止占用者。BuildKit cache 空间维护默认开启，可用 `BUILD_CACHE_MAX_USED_SPACE`、`BUILD_CACHE_MIN_FREE_SPACE` 和 `BUILD_CACHE_RESERVED_SPACE` 调整；如需保留缓存现场，可设置 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 关闭构建前后维护与空间不足自动修复。

镜像空间整备保护全部容器引用、空间探针、显式完整 ID 及本轮构建产物；DSA 快照入口自动保护恢复镜像。实际零余量/ENOSPC 或显式 compact 才清理全部未引用镜像，包括可重新下载的基础镜像；所有卷及挂载保留，恢复配置持续保存。

固定镜像栈和同级源码栈复用 `thesis-ledger-postgres-data`、`thesis-ledger-redis-data` 和 `thesis-ledger-dsa-data` 三个持久化卷；停止服务时不要添加 `-v`。DSA SQLite 卷保存 ProviderConfig、Effective Policy、Catalog generation、Job 和诊断，不能与主系统数据库共享。

首次启动前，如果卷尚不存在，先创建一次：

```bash
docker volume create thesis-ledger-postgres-data
docker volume create thesis-ledger-redis-data
docker volume create thesis-ledger-dsa-data
```

应用发布开关和业务验收由[主仓维护](../thesis-ledger/docs/guides/local-deployment-interface.md)，infra 按 Compose 传入公开配置。快更与构建准备合同见同一指南及 [DSA 接口](../daily-stock-analysis/docs/guides/local-deployment-interface.md)。

## 已验镜像复用

已完成镜像和模块验收后，配置恢复／容器重建可复用该不可变镜像：

```bash
REUSE_THESIS_LEDGER_IMAGE_ID="${VERIFIED_IMAGE_ID:?请先填写已验完整镜像ID}" ./scripts/update.sh thesis-ledger
```

该显式模式仅接受最小thesis-ledger目标，并核对当前开发标签、项目／服务及运行形态；锁、空间、镜像保护、数据库check和健康门禁保持。它跳过构建，以同一镜像强制重建Server／Worker且不重建依赖服务，不同步宿主新源码。原卷和私有trace保留，实际反读仍须验收。详见[镜像复用契约](docs/specs/2026-10-25-update-reuse-thesis-ledger-image.md)。

## 兼容与验收

部署兼容关系见[兼容矩阵](contract-matrix.md)；消费侧的协议和业务验收见 [ThesisLedger 本地工具](../thesis-ledger/docs/guides/local-runtime-tools.md)。

## 版本关系

- ThesisLedger 初始版本：`0.1.0`。
- DSA Fork 镜像版本格式：`v3.28.0-thesisledger.1`，同时记录上游 commit。
- 生产部署使用 GHCR immutable digest；tag 只用于发布说明和兼容矩阵。

## 业务工具

数据来源与准入见 [DSA 本地工具](../daily-stock-analysis/docs/guides/local-runtime-tools.md)；研究备份和业务验收见 [ThesisLedger 本地工具](../thesis-ledger/docs/guides/local-runtime-tools.md)。工具由对应应用维护，命令从本仓执行时使用所列相对路径。
