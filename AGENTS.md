# 项目 Agent 规则

## 项目定位与职责

- 本仓是 ThesisLedger 与 DSA 的本地部署编排仓库，维护 Compose、环境配置、镜像更新、挂载、健康检查以及数据保留、互斥和空间保护。
- 应用仓库拥有业务命令、业务验收、业务数据保护断言及对应测试和说明；业务工具的宿主运行包装随业务工具维护。Provider、新闻和研报准入归 DSA；研究、账本、策略、回测、Arena、通知及消费侧跨应用验收归 ThesisLedger。
- 应用仓库拥有 Dockerfile、依赖安装、缓存和原生 SDK 构建定义，并提供明确的构建参数及构建上下文接口；本仓通过 Compose 消费这些接口，不匹配或改写 Dockerfile 的具体文本。
- 构建准备和快更通过应用的 `scripts/local-deployment.sh` 调用；载荷及容器内替换脚本、应用运行合同、SDK 源、workspace 布局和业务表权限由应用维护。本仓保留传输、锁和失败恢复编排，不复制这些实现清单；已确认的越界模式由 `scripts/check-boundaries.mjs` 门禁防止回归。
- 通用容器、卷、文件备份与恢复操作归本仓；需要读取业务表或应用内部模块的验证归业务项目。本仓的部署代码不得反向依赖应用内部实现。
- 新增维护能力先确认所有权并复用已有入口；专项业务工具在所属应用仓库建立，遵守工作区 Docker 操作规则。
- Docker 维护复用 `scripts/runtime/docker.mjs` 的本地 context、执行和健康等待能力；同步/异步进程适配由 `runtime/process.mjs` 维护，锁生命周期与祖先校验仅由 `runtime/lock.mjs` 维护，不新增独立锁或默认 context 执行器。二进制备份必须声明输出编码，文件流直接写入私有文件。

## Docker 操作入口

- 本仓实际编排、校验和维护工具使用 Node.js 24 与内置模块；Shell 只保留兼容启动器，不新增 source 函数、Shell 控制流程或内嵌 Python。应用自身的 Python 实现经应用维护命令消费，不构成 infra 的宿主依赖。
- `pnpm check` 检查运行时、实现所有权、依赖方向与兼容合同；门禁和 Vitest 测试均进入 CI。持锁应用命令须在所属仓库的 `scripts/deployment/maintenance.json` 登记。

- 执行任何 Docker 操作前，必须读取并遵守 [`../AGENTS.md`](../AGENTS.md) 的「Docker 操作入口强制约束」。所有状态变更只能通过仓库维护的脚本执行；只读检查除外。该约束同时适用于子代理、故障恢复和隔离测试，不能用临时包装命令绕过。
- 目标更新使用 `./scripts/sync-code.sh [all|dsa|thesis-ledger]` 或 `./scripts/update.sh [all|dsa|thesis-ledger]`，按工作区规则判断适用条件；禁止直接调用脚本内部函数跳过正式入口的空间、并发、兼容性和数据库门禁。
- 缺少专用运维入口时，先在拥有该职责的仓库补充维护脚本与必要验证，再执行；不得直接修改 Docker 运行态作为临时补救。
- 空间不足时默认自动清理缓存及未引用镜像；20/18 GiB 仅为参考目标，不因未达标反复阻塞任务。实际 ENOSPC 或清理后实测零空间由 `update.sh` 自动执行一次保卷恢复，保留命名/匿名卷及其挂载，必要时重建整个本开发项目。闲置镜像独立维护使用 `node scripts/docker-space-images.mjs all --all-unused --protect <完整空间探针镜像ID>` 预览，添加 `--apply` 执行；保留运行容器镜像和空间探针，不清理 volumes。
- 仅低于参考值时不得清空全部热缓存和基础镜像。普通中间层在每个应用完成后回收，依赖缓存保留；新服务健康后收敛构建缓存与已空闲磁盘块。显式保卷重建使用同一入口 `UPDATE_SPACE_MODE=compact ./scripts/update.sh all`，默认 auto，不另建更新入口；中断后继续读取原恢复挂载文件。
- 镜像清理按容器引用、空间探针、显式完整 ID 和本轮构建产物判断保护，显式保护使用 `BUILD_PROTECTED_IMAGES`。Docker 引擎故障时报告失败，由用户处理宿主引擎。

## 测试工具

- 测试直接使用 Vitest，由 `pnpm test` 统一运行；定向执行为 `pnpm test scripts/<名称>.test.mjs`，监听为 `pnpm test:watch`。测试文件不另建 Shell 入口。
- Vitest 仅属于 `devDependencies`；本地使用已安装的 pnpm，项目不固定 pnpm 版本，CI 安装最新版。依赖通过 `pnpm-lock.yaml` 固定，CI 使用 `pnpm install --frozen-lockfile`。生产脚本继续只依赖 Node 内置模块。
- 临时资源清理使用测试上下文的 `onTestFinished`；保留测试隔离和失败断言。真实只读 Docker 验收使用 `pnpm test:docker-readonly`，不允许引入 Docker 状态变更。
