# Docker 更新流程

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 首次更新尝试失败时，清理全部未使用的 BuildKit 缓存后，从更新流程起点重试一次；第二次失败直接退出；
- 不主动刷新基础镜像。
- Docker CLI、Docker daemon 或环境参数预检失败时无法安全清理缓存，直接退出。
- 在 `db-bootstrap` 前校验 owner/app role 都存在且互不相同。
- 以 owner 执行 Prisma migration，再在应用启动前撤销 app role 对 `LedgerEvent` 的 UPDATE/DELETE。

## 刷新应用基础镜像

需要主动刷新基础镜像时：

```bash
PULL_BASE_IMAGES=true ./scripts/update.sh
```

该模式会执行：

```bash
docker compose build --pull dsa thesis-ledger
```

## 刷新基础服务镜像

PostgreSQL 和 Redis 默认不刷新。

如需刷新：

```bash
PULL_SERVICE_IMAGES=true ./scripts/update.sh
```

## 设计原则

- 不绑定 development / production 等环境名称；
- 通过显式参数控制构建行为；
- 避免开发环境每次更新等待基础镜像检查；
- 保持数据卷安全，不执行 `docker compose down -v`。
- 自动重试只清理 BuildKit 缓存，不执行 `docker system prune`，不删除数据卷，也不停止运行中的容器。
- PostgreSQL 已有持久卷时，`POSTGRES_OWNER_PASSWORD` 必须保持为卷初始化时的密码；`POSTGRES_APP_PASSWORD` 可由 bootstrap 同步轮换。
- 应用容器只接收 app role 连接串；owner 连接串仅提供给 migration/hardening 一次性服务。
