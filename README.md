# ThesisLedger 开发栈

本仓库只负责把三个独立仓库串联起来：

- `../thesis-ledger`：主系统源码。
- `../daily-stock-analysis`：DSA Fork 及其 ThesisLedger Contract V1 兼容层。
- `thesis-ledger-infra`：固定镜像默认配置、源码构建 override 和黑盒契约测试入口。

父目录不纳入 Git。脚本只会 clone 缺失仓库；如果仓库已经存在，不会自动切换分支、拉取或修改工作树。

本仓库是唯一的 Docker 编排入口，Compose 项目名固定为 `thesis-ledger-dev`。`compose.yml` 是基础配置，`compose.dev.yml` 是源码构建覆盖；两者共同组成同一个开发栈，不是两套独立服务。主仓库不再单独启动 Docker。

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

该栈使用独立的 PostgreSQL/Redis 卷，并以 `THESIS_LEDGER_DSA_TOKEN` 连接 DSA。确定性 fixture 模式默认开启，是 Contract Test 的阻断门槛；在线 Provider smoke test 由 DSA 仓库单独安排。

## 同级源码栈

```bash
docker compose --env-file .env -f compose.yml -f compose.dev.yml up --build -d
```

`compose.dev.yml` 只切换两个应用服务的 build context，不会把 DSA 源码复制到主仓库。

固定镜像栈和同级源码栈都复用 `thesis-ledger-postgres-data`、`thesis-ledger-redis-data` 两个持久化卷；停止服务时不要添加 `-v`。

首次启动前，如果卷尚不存在，先创建一次：

```bash
docker volume create thesis-ledger-postgres-data
docker volume create thesis-ledger-redis-data
```

## 黑盒契约测试

测试脚本由主仓库提供，同一份脚本可以指向主系统 facade 或 DSA Contract：

```bash
CONTRACT_API_BASE=http://localhost:3000/api/v1 \
  ./scripts/contract-test.sh

CONTRACT_API_BASE=http://localhost:8000/api/v1/thesis-ledger \
THESIS_LEDGER_DSA_TOKEN=thesis-ledger-local-token \
CONTRACT_CHECK_CAPABILITIES=true \
  ./scripts/contract-test.sh
```

## 契约门禁

三仓发布以同一份能力矩阵为准，不能只更新某一个服务镜像：

| 组件 | 当前约束 | 门禁 |
| --- | --- | --- |
| ThesisLedger 主仓 | 0.1.0；Account/Position API V1 直接切换到新账户模型 | Prisma migration 20260807100000_account_entry_model 已部署 |
| DSA Fork | Contract V1；fund-nav 为新增能力 | /capabilities 声明 .OF，fixture 与真实 provider 共用响应结构 |
| Desktop / Mobile | 与主仓同一 API schema；Mobile 只读支持 actual / shadow | TypeScript、UI contract 和移动端测试通过 |
| PostgreSQL / Redis | 由本仓 compose 管理，卷名固定 | 迁移完成后才启动 ThesisLedger 服务 |

发布或升级时必须按“数据库迁移 → DSA capability → 主仓 facade → Desktop/Mobile”顺序完成；任一 schema 或 capability 不匹配都停止发布，不做静默降级。 本次账户模型迁移目录为 20260807100000_account_entry_model；DSA pytest 与真实黑盒运行需要先安装 DSA 的测试依赖。

## 版本关系

- ThesisLedger 初始版本：`0.1.0`。
- DSA Fork 镜像版本格式：`v3.28.0-thesisledger.1`，同时记录上游 commit。
- 生产部署使用 GHCR immutable digest；tag 只用于发布说明和兼容矩阵。
