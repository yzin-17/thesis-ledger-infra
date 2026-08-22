# Docker 更新流程

## 更新源码栈

默认更新：

```bash
./scripts/update.sh
```

默认行为：

- 重建 `dsa` 和 `thesis-ledger` 镜像；
- 使用本地 Docker build cache；
- 不主动刷新基础镜像。

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
