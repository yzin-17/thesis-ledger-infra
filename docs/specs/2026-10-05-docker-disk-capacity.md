# Docker Desktop 虚拟盘容量扩展

投资复盘保数据部署在清空可回收构建缓存后仍被空间门禁阻止：Docker 虚拟盘上限 32 GiB，实际空闲约 12.6 GiB，低于 18 GiB；宿主缓存清理后空闲约 27 GiB。扩展到 48 GiB，保留宿主 20 GiB 和 Docker 18 GiB 门槛。

## 边界与验收

维护入口只允许增加现有 `DiskSizeMiB`，禁止缩小、换位置、修改其他设置或删除镜像、容器、卷。启动前检查本地 Desktop context、活动构建和统一更新锁；停止 Desktop 后备份配置，仅更改容量并重启。保护配置文件权限，输出不包含配置正文。

扩展后核对原始磁盘文件 inode、全部镜像 ID、容器 ID 和卷名保持一致。失败保留配置备份与明确阶段；已经扩展后不自动降低容量，因为缩盘可能损失数据。该入口只负责容量，应用和数据库仍通过 `update.sh`。

依据：[Docker Desktop 设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)及 [Mac 磁盘说明](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)。
