# Docker 仅代码更新 Spec

> 任务标识：CODE-ONLY-DOCKER-UPDATE
> 日期：2026-09-15
> 状态：已完成
> 对应任务：[`../archive/tasks/2026-09-15-code-only-docker-update.md`](../archive/tasks/2026-09-15-code-only-docker-update.md)

## 背景与问题

现有 `scripts/update.sh` 面向完整本地运行态更新，会生成本地 Dockerfile、维护 BuildKit cache、构建应用镜像、执行数据库结构门禁并启动服务。即使只修改 TypeScript、Python 或 DSA WebUI 源码，也需要承担镜像构建的时间和网络成本。

开发期间需要一个更快且边界明确的入口：复用当前运行容器和镜像中的依赖，只更新可由宿主机构建或直接复制的代码产物。该入口不能让“代码已写入容器”冒充“镜像已更新”或“数据库结构已升级”。

## 目标

- 提供 `all`、`dsa`、`thesis-ledger` 三个目标，与现有更新入口保持一致。
- 在宿主机生成必要产物，并同步到现有运行容器的可写层。
- ThesisLedger 同时更新 Server 与 Backtest Worker；DSA 同时更新 Python 源码与 WebUI 静态产物。
- 全流程不构建、拉取、标记或删除镜像，且在完成前后核对容器镜像 ID 未变化。
- 对依赖和数据库结构漂移保持 fail-closed；不适合仅代码更新时明确要求使用完整 `update.sh`。
- 同步或健康检查失败时，使用相同镜像重建目标容器，撤销容器可写层中的本次代码更新。

## 非目标

- 不更新镜像、基础镜像、系统包、Node/Python 运行时或原生 SDK。
- 不安装 ThesisLedger Server 的生产依赖，不替代 `pnpm deploy`。
- 不执行数据库迁移、开发数据库重建或结构修复。
- 不更新 Desktop、Mobile 原生应用或其发布产物。
- 不提供生产部署或可持久发布能力。

## 现状与约束

- ThesisLedger 镜像以 `/app/apps/server/dist/src/main.js` 和 `/app/apps/server/dist/src/backtest/backtest-worker.main.js` 分别启动 Server 与 Worker；运行时 workspace 包位于 `/app/node_modules/@thesis-ledger/*` 的 pnpm 链接路径中。
- DSA 镜像从 `/app` 读取根目录 Python 文件、`api/`、`data_provider/`、`bot/`、`src/`、`strategies/` 与 `static/`。
- Compose 数据目录均为外部卷；仅代码更新不得触碰这些卷。
- 容器可写层中的更新在容器重建后会消失，这是开发快更路径的预期行为。
- 本能力依赖现有目标容器已经创建并处于运行状态；缺少容器时不能用快更入口代替完整初始化。

## 设计方案

### 入口与构建

新增 `scripts/sync-code.sh [all|dsa|thesis-ledger]`，默认目标为 `all`。

- ThesisLedger 在宿主机执行 `pnpm --filter @thesis-ledger/server... build`，复用 workspace 的拓扑构建顺序；同步 Server `dist` 以及 `domain`、`schemas`、`shared` 的 `dist`。
- DSA WebUI 在锁文件指纹变化或本机依赖缺失时执行 `npm ci`，随后执行 `npm run build`；同步 Dockerfile 当前声明的 Python 源码范围与根目录 `static/`。
- 同步前先完成全部本机构建，避免在构建失败后留下部分运行态更新。

### 兼容性门禁

- ThesisLedger 的 Server、`domain`、`schemas`、`shared` package manifest 必须与运行容器一致，否则说明运行依赖布局可能已变化，拒绝快更。
- ThesisLedger 的 `prisma/` 内容必须与运行容器一致；Schema、migration 或 raw-owned inventory 发生变化时拒绝快更，交由完整 `update.sh` 的数据库门禁处理。
- DSA 的 `requirements.txt` 必须与运行容器一致；Python 依赖变化时拒绝快更。
- Compose 当前镜像引用必须仍解析为目标容器正在使用的镜像 ID，确保失败回滚不会意外切换到另一个镜像。

### 容器同步、重启与回滚

构建产物先复制到容器内的唯一临时目录，再替换固定的代码目录。脚本随后通过 Compose `restart` 重启目标服务，并等待健康检查。

任何复制、替换、重启或健康检查失败都会触发 `docker compose up -d --no-build --no-deps --force-recreate`。因为前置门禁已经确认 Compose 引用仍指向原镜像，该操作会丢弃容器可写层中的本次代码并恢复镜像内版本；外部数据卷保持不变。

### 镜像不变证明

脚本在修改前记录每个目标容器的 `.Image` ID，完成后重新读取并逐一比较。脚本不包含 `build`、`pull`、`tag`、`commit`、`push` 或镜像删除调用。

## 对外行为或接口变化

- 新增命令：`./scripts/sync-code.sh [all|dsa|thesis-ledger]`。
- 沿用 `ENV_FILE` 与 `HEALTH_TIMEOUT_SECONDS`；默认使用 `.env`，不存在时使用 `.env.example`。
- DSA WebUI 的 `npm ci` 默认使用当前用户的独立临时缓存目录，可通过 `CODE_SYNC_NPM_CACHE_DIR` 覆盖，避免依赖全局 `~/.npm` 权限状态。
- 成功输出会明确说明容器已更新但镜像未更新，并提示容器重建会丢失本次快更。
- 不改变 `scripts/update.sh` 的现有语义。

## 数据、状态或兼容性影响

- PostgreSQL、Redis、DSA 数据卷与 Backtest Snapshot 卷均不修改。
- 目标服务会短暂重启；进行中的请求或 Worker 作业可能被中断，因此该入口只用于本地开发环境。
- 成功结果只存在于目标容器可写层，后续 `up --force-recreate`、完整更新或容器删除会恢复镜像内容。
- 依赖、原生扩展或数据库结构有变化时必须执行完整更新，不能通过放宽门禁宣称兼容。

## 测试策略

### 关键可观察行为

- Shell 语法与帮助/非法参数行为正确。
- 脚本不包含任何镜像变更命令，目标集合与 Compose 服务映射固定。
- 不兼容 manifest、Prisma 结构或 DSA requirements 会在复制前失败。
- `thesis-ledger` 会同时更新并重启 Server 与 Backtest Worker；`dsa` 会更新 Python 与静态资源。
- 真实执行后目标容器健康，且执行前后镜像 ID 完全相同。
- 注入失败或健康失败时，以同一镜像重建目标容器，且不删除外部卷。

### 测试层级与证据边界

1. `bash -n`、静态禁用命令扫描与参数契约测试证明脚本边界。
2. 本地构建证明当前源码可生成待同步产物。
3. 当前 Docker 开发运行态的真实快更证明代码写入、重启、健康检查及镜像 ID 不变；它不证明镜像或生产发布已更新。

### 必要真实运行态门禁

在当前 `thesis-ledger-dev` Compose 项目中执行一次 `all`，记录执行前后三个应用容器的镜像 ID和健康状态。若环境中存在依赖或 Prisma 漂移，门禁应以明确拒绝结束，不得跳过兼容性检查强行更新。

## 风险与备选方案

- 容器进程在代码替换和重启之间存在极短的可写层变更窗口；失败时通过同镜像重建恢复，而不是继续运行未知混合状态。
- DSA 新代码可能隐式依赖未声明或原生依赖变化；健康检查只能覆盖启动路径。此类修改应主动使用完整更新。
- 若需要让代码更新跨容器重建保留，可另行设计只读 bind mount 的开发模式；本任务不改变当前 Compose 拓扑。

## 未决问题

### Blocking

无。

### Non-blocking

无。

## 验收标准

- AC1：`sync-code.sh` 支持 `all`、`dsa`、`thesis-ledger`，并在修改任何容器前完成所选目标的本地构建和运行容器预检。
- AC2：脚本不执行任何镜像构建、拉取、标记、提交、推送或删除，真实运行前后目标容器镜像 ID 保持一致。
- AC3：ThesisLedger manifest/Prisma 与 DSA requirements 漂移会在复制前明确失败，不修改数据库或外部卷。
- AC4：ThesisLedger Server 与 Backtest Worker、DSA Python 与 WebUI 产物按目标完整同步，重启后通过现有健康检查。
- AC5：同步、重启或健康检查失败时，脚本使用当前同一镜像重建目标容器并返回失败，不把部分更新声明为成功。
- AC6：文档明确区分容器可写层快更、镜像更新、数据库结构升级和生产发布，且提供正确的使用与回退说明。
