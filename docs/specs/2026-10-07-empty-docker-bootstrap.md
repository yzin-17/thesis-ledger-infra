# 空 Docker 开发环境的空间探针初始化

## 问题与授权

M31 目标更新时当前本地 Docker Desktop 的容器、镜像和 volume 均为零，`update.sh all` 在没有已有探针镜像时退出。用户明确选择使用当前空环境重建开发目标，旧结果回归另补。

## 边界与行为

沿用 `scripts/update.sh`，新增显式 `BOOTSTRAP_SPACE_PROBE=true`。默认仍不下载探针。选项只允许本地已验证的 docker driver，并在取得更新互斥锁后执行；没有探针时复核容器、镜像、volume 全为空，宿主机空间达到既有门槛且 builder 空闲，才拉取一个 `node:24-alpine` 基础镜像并固定实际镜像 ID。该镜像只用于首次取得 Docker 文件系统余量，不挂业务卷。

首次下载后必须执行完整宿主机与 Docker 空间门禁，不能以初始下载成功代替空闲证明。任何失败立即停止，不清除业务数据，不放宽空间、并发、保留数据升级或恢复门禁。已有可用探针时保持原流程。旧数据库、结果和 Snapshot 的不存在不能标为恢复成功。

当前 Compose 的四个数据卷均为 external，新环境还须显式 `INITIALIZE_EMPTY_DEV_VOLUMES=true` 并确认 `EMPTY_DEV_CONFIRM=thesis-ledger-dev/thesis_ledger`。在正式更新入口的锁与空间门禁后、构建前初始化已配置的四个卷；只允许没有容器和其他卷的本地开发环境。已有完整卷集合不作变更；部分初始化重试只允许本入口已标记的卷，其他现有卷拒绝。该路径只创建卷，不删除、清空或覆盖。新数据库仍由完整 migration 初始化并经过既有结构门禁。

## 验收

测试默认缺镜像仍拒绝；显式空环境允许初始化；非空环境、宿主机不足、并发构建、下载失败/无有效镜像 ID 均拒绝。Shell 语法、既有空间编排回归通过后，通过正式 `BOOTSTRAP_SPACE_PROBE=true ./scripts/update.sh all` 运行并记录结果。
