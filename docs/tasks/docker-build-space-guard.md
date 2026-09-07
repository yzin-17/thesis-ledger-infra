# Docker 本地构建空间保护实施任务

对应 Spec：[`../specs/2026-09-08-docker-build-space-guard.md`](../specs/2026-09-08-docker-build-space-guard.md)

## 任务

- [x] T1：实现有界缓存维护、构建峰值控制与 ENOSPC 自动恢复
  - 覆盖验收标准：AC1、AC2、AC4
  - 依赖：无
  - 涉及范围：`scripts/update.sh`
  - 完成条件：默认在构建前后以 8GB/18GB/4GB 阈值维护当前 builder；`all` 对两个应用逐个执行 Compose build；首次 ENOSPC 全清未使用 BuildKit cache 并重试一次；显式关闭时不清理。
  - 验证方式：Shell 语法检查；静态核对默认成功、显式关闭、普通失败、ENOSPC 恢复、二次失败及非法参数分支；真实冷缓存更新验证主成功路径。

- [x] T2：让本地 `pnpm deploy` 复用命名 store，并同步使用文档
  - 覆盖验收标准：AC3、AC5
  - 依赖：无
  - 涉及范围：`scripts/update.sh`、`docs/docker-update-workflow.md`、`README.md`
  - 完成条件：临时 ThesisLedger Dockerfile 为 install 与 deploy 注入相同 store ID；共享 Dockerfile/Compose 仍不包含本地配置；使用文档说明新默认值、空间边界与负面影响。
  - 验证方式：静态核对临时 Dockerfile 转换规则和共享文件；真实冷构建确认 deploy 复用 store；`git diff --check`。

- [x] T3：执行真实冷缓存更新验证并完成一致性 Review
  - 覆盖验收标准：AC6
  - 依赖：T1、T2
  - 涉及范围：本地 `desktop-linux` builder、更新脚本运行结果、任务验证证据
  - 完成条件：在本轮已清空 BuildKit cache 的前提下运行真实更新；分别记录构建阶段、运行时阶段和更新后的 BuildKit/磁盘占用；任何独立运行时故障均如实记录而不冒充构建失败。
  - 验证方式：真实执行 `./scripts/update.sh all`，随后执行 `docker system df`、`docker buildx du` 与容器状态检查。

- [x] T4：收敛本地更新验证入口与契约
  - 覆盖验收标准：AC6
  - 依赖：无
  - 涉及范围：`scripts/`、对应 Spec 与任务文档
  - 完成条件：脚本目录仅保留实际使用的更新入口及公共辅助脚本；验证策略与实际保留的检查一致。
  - 验证方式：引用扫描、`bash -n scripts/update.sh`、`git diff --check`。

## 最终一致性 Review

- [x] Spec 中的全部验收标准均有对应实现
- [x] 所有已勾选任务均有验证证据
- [x] 所有任务依赖均已满足且无错误阻塞关系
- [x] 跨任务接口、类型和命名保持一致（如适用）
- [x] 不存在未解决的 Blocking 问题、占位描述或未定义的实现契约
- [x] 实现未超出 Spec 声明的范围
- [x] 验证策略、验证入口与验证结果一致
- [x] 验证入口与文档已同步更新
- [x] 必要实施 Step 均已验证；本次未获得提交授权，改动保持在工作区
- [x] 未发现实现、Spec 与任务文档之间的不一致

### Review 结论

- 结论：通过。AC1 至 AC6 均已有实现与验证证据。
- 发现的问题：真实验证确认 Compose 的全局 `--parallel 1` 不能阻止同一次多目标 build 在 BuildKit 内并行，已改为分别调用 `compose build dsa` 与 `compose build thesis-ledger`；本地更新验证入口已收敛为语法检查、静态契约核对和真实更新验证，复核后无未解决问题。
- 遗留风险：BuildKit 空间阈值是 GC 目标，活跃记录、镜像共享层与缓存保留底线可能使 `docker system df` 的 Build Cache 总数高于 8GB；单个冷构建若超过物理可用空间仍需扩容。负向重试分支不再有专用自动回归覆盖；当前环境未安装 `shellcheck`，因此本轮未获得其静态分析结果。
- 验证命令与结果：
  - `bash -n scripts/update.sh`：通过。
  - 静态契约核对：默认缓存维护、显式关闭、逐服务构建、pnpm store 复用、普通失败、ENOSPC 修复、二次失败及预检分支均与 Spec 一致。
  - 已删除入口引用扫描：无匹配；`scripts/` 中仅保留实际使用的更新、启动、契约检查与数据库初始化脚本。
  - `./scripts/update.sh all`：在清空 BuildKit cache 后真实冷构建通过，DSA 完成后才开始 ThesisLedger；`pnpm deploy` 全程 `downloaded 0`；最终 DSA 与 ThesisLedger 均为 healthy。
  - `docker system df` 与 `docker buildx du`：脚本完成后 Build Cache 为 8.836GB，其中 Shared 4.873GB、Private 3.963GB；Docker 根文件系统可用 17,394,304 KiB。后续阈值诊断仅移除 327.1MB 共享缓存元数据，Private 与实际空闲空间基本不变，符合共享镜像层不会释放实际空间的边界。
  - ThesisLedger 容器日志：`Nest application successfully started`，未再次出现 `systemKey` 或 `P2022`。
  - `git diff --check`：通过。
