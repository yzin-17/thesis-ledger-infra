# ThesisLedger 开发栈

本仓库只负责把三个独立仓库串联起来：

- `../thesis-ledger`：主系统源码。
- `../daily-stock-analysis`：DSA Fork 及其 ThesisLedger Contract V1 兼容层。
- `thesis-ledger-infra`：固定镜像默认配置、源码构建 override 和黑盒契约测试入口。

父目录不纳入 Git。脚本只会 clone 缺失仓库；如果仓库已经存在，不会自动切换分支、拉取或修改工作树。

本仓库是唯一的 Docker 编排入口，Compose 项目名固定为 `thesis-ledger-dev`。`compose.yml` 是基础配置，`compose.dev.yml` 是源码构建覆盖；两者共同组成同一个开发栈，不是两套独立服务。主仓库不再单独启动 Docker。

PostgreSQL 使用 owner 角色执行 Prisma migration，应用容器使用 `POSTGRES_APP_USER` 运行；`POSTGRES_OWNER_USER` 与 `POSTGRES_APP_USER` 必须是不同的非空角色。Compose 会在 `db-bootstrap` 前执行角色预检，缺失或同名配置会阻止应用启动；bootstrap SQL 也会重复校验。启动流程先由 `db-bootstrap` 创建或更新应用角色，再由 `db-migrate` 以 owner 执行 Prisma migration，最后由 `db-permission-hardening` 撤销应用角色对 `LedgerEvent` 的 UPDATE/DELETE，应用容器不会获得 owner 连接串。现有持久卷不会被重置：`POSTGRES_OWNER_PASSWORD` 只在 PostgreSQL 初始化新卷时生效，已有卷必须继续使用原 owner 密码，否则 bootstrap 无法连接；`POSTGRES_APP_PASSWORD` 会由 bootstrap 每次启动时通过 `ALTER ROLE` 同步，轮换后需重建应用容器使新连接串生效。

## 初始化

```bash
./scripts/bootstrap.sh
cp .env.example .env
```

`.env` 中的两个应用镜像必须填写首次发布后记录的 GHCR digest，不能只填写可漂移的 tag。当前示例使用占位 digest；在镜像尚未发布前，默认镜像栈不能启动。

## 固定镜像栈

```bash
docker compose --env-file .env up -d
```

该栈使用独立的 PostgreSQL/Redis/DSA SQLite 卷，并以独立的 `THESIS_LEDGER_DSA_TOKEN` 和 `THESIS_LEDGER_CONTROL_TOKEN` 区分数据消费与控制面。确定性 fixture 模式默认开启，是 Contract Test 的阻断门槛；在线 Provider smoke test 由 DSA 仓库单独安排。

## 同级源码栈

```bash
docker compose --env-file .env -f compose.yml -f compose.dev.yml up --build -d
```

`compose.dev.yml` 只切换两个应用服务的 build context，不会把 DSA 源码复制到主仓库。

### 一键更新源码栈

```bash
./scripts/update.sh
```

脚本默认使用 `.env`；如果文件不存在，则回退到 `.env.example`。它会拉取应用基础层、重建 `dsa` 和 `thesis-ledger` 应用镜像、启动服务并等待健康检查完成。默认不强制刷新 PostgreSQL 和 Redis 的服务镜像；如需同时刷新它们，可显式开启：

```bash
ENV_FILE=.env PULL_SERVICE_IMAGES=true HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh
```

脚本不会执行 `docker compose down -v`，不会删除或重置 PostgreSQL、Redis 和 DSA SQLite 数据卷；如果宿主机端口被其他进程占用，脚本会报告 Compose 状态并退出，不会自动停止占用者。

固定镜像栈和同级源码栈复用 `thesis-ledger-postgres-data`、`thesis-ledger-redis-data` 和 `thesis-ledger-dsa-data` 三个持久化卷；停止服务时不要添加 `-v`。DSA SQLite 卷保存 ProviderConfig、Effective Policy、Catalog generation、Job 和诊断，不能与主系统数据库共享。

首次启动前，如果卷尚不存在，先创建一次：

```bash
docker volume create thesis-ledger-postgres-data
docker volume create thesis-ledger-redis-data
docker volume create thesis-ledger-dsa-data
```

## 黑盒契约测试

测试脚本由主仓库提供，同一份脚本可以指向主系统 facade 或 DSA Contract：

```bash
CONTRACT_API_BASE=http://localhost:3000/api/v1 \
  ./scripts/contract-test.sh

CONTRACT_API_BASE=http://localhost:8000/api/v1/thesis-ledger \
THESIS_LEDGER_DSA_TOKEN=thesis-ledger-local-token \
THESIS_LEDGER_CONTROL_TOKEN=thesis-ledger-local-control-token \
CONTRACT_CHECK_CAPABILITIES=true \
CONTRACT_CHECK_CONTROL=true \
  ./scripts/contract-test.sh
```

## 契约门禁

三仓发布以同一份能力矩阵为准，不能只更新某一个服务镜像：

| 组件                            | 当前约束                                                                                                                                            | 门禁                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ThesisLedger 主仓               | 0.1.0；Account/Position API V1 直接切换到新账户模型                                                                                                 | Prisma migration 20260807100000_account_entry_model 已部署        |
| DSA Fork                        | Data Contract V1 保持 Bearer token 独立；Control Contract V1 使用独立 Control Token；fund-nav、Catalog snapshot/delta 和 Provider policy 为兼容扩展 | Contract fixture、Control Contract 原子性/权限测试；源码语法检查  |
| Desktop / Mobile                | 与主仓同一 API schema；Mobile 只读支持 actual / shadow                                                                                              | TypeScript、UI contract 和移动端测试通过                          |
| PostgreSQL / Redis / DSA SQLite | 由本仓 compose 管理，卷名固定且不共享                                                                                                               | 迁移、Control Contract 和卷挂载检查完成后才启动 ThesisLedger 服务 |

发布或升级时必须按“DSA Data/Control Contract 与独立 SQLite 卷 → 主仓数据库迁移与 facade → Desktop/Mobile/Infra”顺序完成；任一 schema、Control Token 或 capability 不匹配都停止发布，不做静默降级。本次账户模型迁移目录为 `20260807100000_account_entry_model`，市场数据迁移目录为 `20260818000000_market_data_provider_v12`；DSA pytest 与真实黑盒运行需要先安装 DSA 的测试依赖。

## 版本关系

- ThesisLedger 初始版本：`0.1.0`。
- DSA Fork 镜像版本格式：`v3.28.0-thesisledger.1`，同时记录上游 commit。
- 生产部署使用 GHCR immutable digest；tag 只用于发布说明和兼容矩阵。
