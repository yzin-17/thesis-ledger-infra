# Compose 构建 context 绑定

官方 `update.sh thesis-ledger` 已验证本地 `desktop-linux` 的 Docker driver，但 Compose 子进程的 Buildx 上下文与 builder 名不一致，实际构建报 `use docker --context=desktop-linux buildx`。空间门禁通过后仍未开始构建和数据库升级。

Compose 5.5.1 直接启动 Buildx 可执行文件，并额外传递 Docker endpoint；该路径下仅传 `DOCKER_CONTEXT` 或父 CLI 的 `--context` 均未通过目标复验。官方入口改为先用 `compose build --print <service>` 导出等价 Bake 定义，再通过 Docker CLI 的 `--context` 启动 `buildx bake --builder`。配置、标签、基础镜像映射与临时 Dockerfile 继续由原 Compose 配置决定，每次只构建已选服务。定义通过管道传递，不输出或保存潜在构建参数；Compose 导出失败或 Bake 失败均停止更新。

维护 helper `build-compose-service.sh` 仅供 `update.sh` 调用，不新增操作入口。仅允许读取既有 workspace 和脚本拥有的临时构建目录。不修改用户全局 context、不跳过驱动、活动构建、更新锁、容量、备份或结构门禁。维护测试要求显式 context 与空间探针 builder 一致，并覆盖定义导出失败，再由正式更新入口独立验收。

依据：[Buildx context 校验](https://github.com/docker/buildx/blob/master/builder/builder.go)。

官方接口：[Compose 等价 Bake 定义](https://docs.docker.com/reference/cli/docker/compose/build/)、[Bake 与 Compose](https://docs.docker.com/build/bake/compose-file/)。子进程依据：[Compose 5.5.1 构建调用](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/build_bake.go)、[endpoint 传递](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/shellout.go)。
