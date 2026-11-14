# Node.js 部署编排统一

日期：2026-11-11。[已完成任务](../archive/tasks/2026-11-11-node-orchestration.md)。[验收证据](../archive/evidence/2026-11-11-node-orchestration.md)。

## 目标与接口

infra 的实际编排、配置解析、校验、维护锁、空间与磁盘工具统一使用无需编译的 Node.js 24 和内置模块。既有 Shell 命令路径与参数保留为薄启动器，不在 Shell 中保留控制流程或内嵌程序。应用内部语言和业务实现继续由所属项目维护。

保留 update.sh、sync-code.sh、bootstrap.sh、restore-dsa.sh、docker-desktop.sh 与 prune-failed-build-history.sh 的公开行为；Python 容量工具改为 docker-desktop-disk.mjs，并提供 docker-desktop-disk.sh 启动器。原容量参数和禁止缩盘、并发配置保护、资源清单与磁盘身份校验保持。bootstrap 与 Compose 保持同级应用仓库结构，已有工作树不得覆盖。

锁与空间等内部 Shell 导出函数迁为明确的 Node 模块与持锁子命令，三仓调用方和测试同步更新。应用构建、快更载荷与快照语义仍经应用命令消费；SQLite 在线备份实现由 DSA 提供，infra 不直接执行 Python。

DSA 的宿主 SDK 源预取也改为 Node，保留原命令和固定 tag/revision、对象完整性与干净工作树校验；Node 预取和镜像内 Python 构建器读取同一份应用 JSON 元数据。同步维护 Dockerfile 打包和兼容输入，消除更新入口对宿主 Python 虚拟环境的间接要求；镜像内应用 Python 保持。

## 不变量与验收

- AC1：生产 Shell 仅执行 Node 启动器；infra 不含 Python 实现、内嵌 Python 或宿主 Python 依赖；不引入运行时 npm 依赖或编译流程。
- AC2：目标、环境参数、退出状态、兼容拒绝、锁归属与祖先进程保护保持；本地 Unix context、同一 builder、活动构建和空间未知失败保护保持。
- AC3：构建保持逐目标、完成产物保护、一次普通重试与最多一次保卷恢复；预取在停机前完成；命名/匿名卷、挂载、中断恢复文件和数据库失败停止语义保持。
- AC4：快更仍在容器变更前通过应用兼容预检，保持镜像身份，失败时只恢复已修改服务到同一镜像；恢复、配置保护、容量扩展和维护工具覆盖受控失败验证。
- AC5：测试随实现改用 Node，保留有效行为场景和原错误边界；三仓调用方、CI、规则和当前指南无失效引用。定向检查通过后再进行包级/仓库检查与正式 update.sh all 保留数据验收，并验证快更正式入口。

不重新设计空间政策、应用协议或业务行为；不触发新闻准入、来源实读、模型调用，不清理历史业务数据，不提交或推送 Git。受控故障与容量扩展不在共享 Docker Desktop 上注入。
