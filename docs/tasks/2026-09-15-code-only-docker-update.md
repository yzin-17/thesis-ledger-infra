# Docker 仅代码更新实施任务

对应 Spec：[`../specs/2026-09-15-code-only-docker-update.md`](../specs/2026-09-15-code-only-docker-update.md)

> 状态：已完成；当前脏工作区的本地 Docker 运行态门禁已通过

## 任务

- [x] T1：实现仅代码更新入口与兼容性保护
  - 覆盖验收标准：AC1、AC2、AC3、AC4、AC5
  - 依赖：无
  - 涉及范围：`scripts/sync-code.sh`
  - 完成条件：三个目标完成本地构建、兼容性预检、固定范围同步、容器重启、健康检查、失败回滚与镜像 ID 核对；不调用镜像变更命令，不修改数据库或数据卷。
  - 验证方式：Shell 语法检查、静态命令边界检查、帮助/非法参数检查，以及真实运行态成功路径。
  - 验证证据：`bash -n scripts/sync-code.sh scripts/sync-code.test.sh` 通过；先后执行 `dsa`、`thesis-ledger` 与 `all` 目标均完成宿主机构建、同步、重启和健康检查。实施期间的容器暂存参数错误真实触发同镜像回滚，回滚后 DSA、Server、Worker 均恢复 healthy；修复后成功路径通过。

- [x] T2：补齐契约测试与使用文档
  - 覆盖验收标准：AC2、AC3、AC6
  - 依赖：T1
  - 涉及范围：`scripts/sync-code.test.sh`、`docs/docker-update-workflow.md`、`README.md`
  - 完成条件：自动检查禁用的镜像操作、目标与保护性错误文案；文档说明适用范围、依赖/Prisma 漂移门禁、短暂停机、可写层易失性与完整更新入口。
  - 验证方式：执行契约测试、链接与命令扫描、`git diff --check`。
  - 验证证据：`./scripts/sync-code.test.sh` 通过，覆盖帮助、非法目标、镜像变更与 Docker 清理禁令、漂移保护文案、回滚命令及服务映射；`git diff --check` 通过。当前环境未安装 `shellcheck`，未获得该工具的附加静态分析结果。

- [x] I1：验证当前 Docker 开发运行态
  - 覆盖验收标准：AC1、AC2、AC4、AC5
  - 依赖：T1、T2
  - 环境前提：当前 `thesis-ledger-dev` 容器健康，Compose 镜像引用未漂移。
  - 涉及范围：当前本地 DSA、ThesisLedger Server 与 Backtest Worker 容器。
  - 完成条件：执行 `./scripts/sync-code.sh all` 后三个服务健康；执行前后镜像 ID 一致；输出明确保留数据库和外部卷。
  - 验证方式：脚本自身镜像 ID 核对与健康检查；随后读取 Compose 状态和容器镜像 ID复核。
  - 验证证据：`./scripts/sync-code.sh all` 约 51 秒完成，DSA、Server、Worker 均为 healthy。DSA 镜像 ID 前后均为 `sha256:67f695fadf32a2576f7a3c3519718a7f8a0ffb14aaf5019cb5d854a5ee521b76`；Server 与 Worker 前后均为 `sha256:1b64b01df062a59cec45ebe5c74d678e6ad913c79bbcc4c1b80ef996891d0e7c`。容器中的 DSA `main.py`、WebUI `build-info.json`、Server `main.js` 与 Worker 入口分别和宿主机构建产物逐字节一致。

## 验收映射

| AC / 断言 | 实现责任任务 | 验证责任任务或门禁 |
| --- | --- | --- |
| AC1 / 目标与构建前置 | T1 | T1、I1 |
| AC2 / 镜像不变 | T1、T2 | T2、I1 |
| AC3 / 漂移拒绝与数据边界 | T1、T2 | T2；I1 验证当前兼容路径 |
| AC4 / 产物同步与健康 | T1 | I1 |
| AC5 / 失败回滚 | T1 | T2；真实故障注入不属于本轮必要门禁 |
| AC6 / 证据边界与使用说明 | T2 | T2 |

## 规划预检

- 结论：Ready。
- 范围：一个本地开发运维入口、对应契约检查和一次真实运行态门禁。
- 依赖：T1 可独立实施；T2 依赖已确定的命令行为；I1 仅在本地检查通过后执行。
- 验收边界：I1 只证明当前容器可写层快更，不证明镜像或生产发布已经更新。
- Blocking 问题：无。

## 最终一致性 Review

- [x] Spec 的全部验收断言均有明确实现与适当验证
- [x] 所有已勾选任务满足自身完成条件且证据仍有效
- [x] 必要集成、真实运行态与条件性门禁均已通过或有合法不适用依据
- [x] 启动依赖、验收依赖与契约就绪证据正确且无循环
- [x] 跨任务接口、类型、状态、时间、错误与副作用语义一致（如适用）
- [x] 不存在未解决的 Blocking 问题、占位要求或未定义契约
- [x] 实现未超出 Spec 范围，未把可选设施变成强制要求
- [x] 证据类型、场景覆盖、代码版本与目标环境支持所声明的验收结果
- [x] 测试、配置、文档、Spec/Task 状态与实际实现一致
- [x] 必要实施 Step 已验证；提交处理符合授权且保留既有用户修改
- [x] 未发现未处理的实现、Spec、任务或验收证据不一致

### Review 结论

- 结论：通过；本地开发容器可写层的仅代码更新范围已完成，AC1 至 AC6 均有对应实现与证据。
- 已确认的问题及责任任务：首次 DSA `npm ci` 受全局 `~/.npm` 历史 root-owned 缓存阻断，已改为当前用户独立临时 cache；容器内 `sh -s` 参数位置错误导致首次替换失败，已修正并通过后续 `dsa`、`thesis-ledger`、`all` 三条真实路径。
- 尚未通过的必要门禁与阻塞原因：无。
- 遗留风险或已确认的后续范围：容器可写层更新会在重建后消失；进行中的请求或 Worker 作业会受重启影响；隐式原生依赖变化仍需调用方选择完整 `update.sh`。当前环境没有 `shellcheck`，但 Shell 语法、契约测试、真实成功路径和真实失败回滚均已验证。
- 验证命令/过程、结果与证据引用：`bash -n scripts/sync-code.sh scripts/sync-code.test.sh`、`./scripts/sync-code.test.sh`、`./scripts/sync-code.sh dsa`、`./scripts/sync-code.sh thesis-ledger`、`./scripts/sync-code.sh all`、Compose 状态与容器/宿主产物逐字节比较、`git diff --check`；全部通过。测试基线为三个仓库当前未提交工作区，未创建提交。
