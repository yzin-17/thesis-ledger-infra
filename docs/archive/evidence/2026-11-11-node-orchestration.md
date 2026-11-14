# Node.js 编排迁移验收

日期：2026-11-11。状态：已通过。[任务](../tasks/2026-11-11-node-orchestration.md)。

## 实现范围

infra 的更新、快更、启动、锁、构建与数据库执行、空间与容量工具使用 Node.js 24 和内置模块。原 Shell 入口与目标参数保留为两行透传；删除旧 Shell 实现及 Python 容量工具。应用部署接口继续拥有 SDK、载荷、运行合同及 SQLite 在线备份；持锁调用方通过登记命令传入祖先锁，不 source infra 内部实现。

DSA 宿主 SDK 源预取改用 Node，固定版本元数据由宿主与镜像内构建器共同读取。Dockerfile、兼容输入、对应 CI 和当前指南同步更新；应用镜像中的 Python 保持归属。

## 受控检查

- infra：`node --test scripts/*.test.mjs`，最终 85 通过，1 个真实 Docker 只读场景单独执行。涵盖参数、退出状态、并发、派生进程取消、构建重试、空间、镜像复用、数据库与同镜像恢复。
- 真实只读配置：`DOCKER_READONLY_ACCEPTANCE=true node --test scripts/docker-reinstall-plan.test.mjs`，5 通过，确认实际匿名/命名卷接回与绑定目录保持。
- DSA：`node --test scripts/deployment/*.test.mjs scripts/prepare-local-sdk-source.test.mjs`，最终 58 通过，覆盖原入口、SDK 固定源及无宿主 Python、状态导出二进制、标签拒绝、失败状态、归档排除项与标准输入模块导入。应用 Python 环境中的 SQLite 在线备份 2 通过、字节码 1 通过；固定 SDK 构建与 CI 合同 pytest 9 通过；数据运行合同检查通过。
- ThesisLedger：部署合同 2 通过；持锁调用方受控测试 10 通过。
- infra 兼容、依赖边界与 Node 薄入口门禁通过；51 个 Node 文件语法检查通过；两仓修改的 CI YAML 可解析；三仓 `git diff --check` 通过。
- 取消运行的受控测试覆盖派生进程终止，失败输出关闭后才释放维护锁。升级的准备、事务与确认失败均不启动消费者；共享 Docker 上未注入故障。

检查只使用临时样本、伪命令或明确只读的 Docker 查询，没有触发 Provider、新闻准入或模型调用。应用 Python 测试在 DSA 的环境执行，不构成 infra 运行依赖。

## 真实更新前状态

原始摘要见[更新前状态](2026-11-11-node-orchestration-before.json)：5 个服务健康，Server 与 DSA HTTP 均为 200；结构 head 为 `20261107010000_risk_notification_providers`，7 张受保护表及 84 条成功回测结果已记录摘要，无活动回测。全部实际挂载与不可变镜像已保存并逐项比较。

## 正式更新与快更

执行目录为 `/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`。宿主实际使用 Node.js `24.22.2`、pnpm `11.9.0`，PATH 优先选择其实际安装目录。命令及影响行为的非敏感参数如下：

```bash
DEV_DATABASE_MODE=check HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh all

npm_config_registry=https://registry.npmmirror.com \
pnpm_config_registry=https://registry.npmmirror.com \
COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
HEALTH_TIMEOUT_SECONDS=180 ./scripts/sync-code.sh all
```

两条命令均退出 0。更新完成固定 SDK 源预取、两个应用原始 Dockerfile 构建、数据库 check 门禁与 DSA/Server/Worker 健康等待；快更完成全部应用预检、宿主 workspace 构建、三服务代码替换、重启和同镜像核对。没有执行 rebuild、upgrade 或清库。

不可变产物：DSA 为 `sha256:07bc1d42366916f40852e73c93f7f8f800d2837298dbd9e505e3c3c623819c86`；Server 与 Worker 共同使用 `sha256:2b46a03dba861967507c6f49c034774b1a52522153685e972daf635498995fd3`。快更保留这些镜像及更新后的全部容器 ID，不作为新的镜像发布证据。

独立只读状态见[更新后](2026-11-11-node-orchestration-after-update.json)与[快更后](2026-11-11-node-orchestration-after-sync.json)：

- 7 张保护表摘要、84 条成功回测结果摘要及结构 head 与更新前一致，无活动回测。
- 5 个服务全部健康；Server `/api/v1/health` 与 DSA `/health` 均返回 200；PostgreSQL/Redis 原容器保留。
- 5 个服务的全部命名、匿名卷及实际挂载逐项一致，未删除或替换卷。
- DSA 镜像兼容基线与宿主应用输入结构化深比较一致；Server/Worker 容器内结构执行器的 SHA-256 与宿主构建产物一致。
- Server/Worker 本轮日志中的缺表错误计数均为 0；快更前后全部镜像及容器身份一致。

运行复核同时修复了标准输入导入维护模块时误把 `-` 当作文件路径的入口判断，并以三仓相关测试回归。该调整属于宿主模块，应用镜像和数据库输入未改变；最终快更使用修复后的正式入口成功，复用已完成的镜像构建验证。

最终一致性审查确认 Node 编排及职责边界符合规格，现有未提交改动保留。没有执行 Provider 实读、新闻准入、模型调用、共享故障注入、Desktop 扩容、Git 提交或推送。CI 配置与本地对应门禁已验证，未声称运行远程 CI。
