# Docker 本地构建空间保护实施任务

## 当前检查点：更新峰值与实际保卷重建（2026-10-17）

本轮用户要求一次性解决重复空间中断。沿用前轮实现和真实清理，按 AC19～AC23 补齐缓存策略、服务间回收、健康后占用收敛及实际恢复验收。全部既有未提交改动保留。

- [x] T21 更新前缓存策略：不因低于参考目标清空热缓存或全部基础镜像；零余量继续走恢复。空间编排定向验证通过，覆盖低参考值、零/未知、禁用及清理失败。
- [x] T22 构建间与健康后回收：新增职责独立的 `build-space-lifecycle.sh`；保护完成镜像后回收普通中间层，保留依赖缓存；健康后释放旧基线，按实际容量退役旧回滚并复测。生命周期、回滚编排20场景及产物复用测试通过。
- [x] T23 正式 compact 模式：同一入口、同一锁、禁用冲突和单次恢复，保留所有卷及持久挂载配置；固定 SDK 源停机前预取并复用。恢复、空间编排、SDK源及模式配置回归通过。
- [x] T24 真实保卷重建：compact 已实际停止/删除全部本项目容器，随后通过原持久挂载配置跨进程续接；正式 auto all 更新退出0，完成冷构建、原数据库门禁和服务恢复。6卷/挂载保持，SQLite 11表行数全同，PostgreSQL 80表仅健康检查行数+1，其他79表一致；5容器healthy、两健康HTTP端点200。健康后宿主约10.26 GiB、Docker约18 GiB，未达宿主参考值也成功。
- [x] T25 最终一致性核对：48项Node测试及相关Shell/兼容/差异检查通过，已同步规则、README、指南与CI。完整命令、失败原因、恢复与数据证据见[实际验收](evidence/2026-10-17-docker-update-peak-acceptance.md)。未提交推送。

规划核对：Ready。最终占用与构建峰值分别验收，不承诺任意宿主剩余容量下都能编译。必要的本项目停机重建已获用户授权；不停止其他项目、不删除任何 volume 或业务数据、不提交推送。

当前状态：本轮实现、真实保卷删除/续接/重建及健康后空间收敛均完成；运行仍为32 GiB Docker虚拟盘，没有扩容。恢复挂载配置保留，`incomplete` 已清除。初次运行的权限问题、GitHub TLS和一次PyPI超时有完整记录，未误报为空间不足；进程检查已前置，固定源已缓存并沿用系统代理。未人为注入实际ENOSPC，未执行第二次无变更全量构建，不扩大为全部业务或真实供应商验收结论。

## 前轮检查点：自动清理与保卷恢复（2026-10-17）

本轮用户授权清理 Docker 可重建资源，必要时保留 volumes 重装；按 Spec AC15～AC18 实施，以下为当前状态，后续章节为历史证据。

- [x] T17 参考目标与镜像整备：20/18 GiB 改为参考值，清理全部未引用镜像并复核保护；正余量继续，零余量先恢复，未知余量及并发拒绝。47项 Node 测试和空间编排通过。
- [x] T18 保卷恢复编排：`docker-reinstall-plan.mjs` 与 `reinstall-preserving-volumes.sh` 接入正式更新；单次恢复、all 重建、命名/匿名卷挂载持久保存和中断续接完成。替身验证副作用顺序、上限及失败路径，真实只读 Compose 合并通过。**未触发真实停机重装**。
- [x] T19 实际库存清理：正式维护入口退出0，删除8个唯一闲置镜像、11个引用；镜像占用10.6→3.75 GB。5容器身份/镜像/健康及6卷/挂载一致，宿主一次测得15.14 GiB空闲。
- [x] T20 最终一致性核对：README、更新指南、工作区及infra规则、CI测试同步；兼容性、源预取、Dockerfile、产物复用、回滚和快更回归通过。详见[本轮验收记录](evidence/2026-10-17-docker-space-recovery.md)。

前轮结束时：实现、局部回归、真实闲置清理与只读挂载合并完成，完整重装尚未实测；该边界已由上方本轮实际保卷重建验收补齐，实际ENOSPC故障注入仍未执行。未修改应用源码、数据库结构或已有未提交改动，未提交或推送。

## 历史检查点：共享磁盘清理范围（2026-10-14）

复用T9～T13已完成的候选、保护及回收机制，T14已修复单目标遗漏另一应用超额回滚的问题。用户本轮明确取消紧张期保留1个历史版本的底线，允许退役未引用、未保护的历史回滚；按Spec AC14新增T16的逐个清理及实际缺口复测，然后沿T15完成TickFlow镜像固化。

- [x] T14 紧张期共享回滚范围：scripts/build-space.sh及其测试复用现有rollback-image-policy.mjs，两个单目标的全局回滚/所选常规整备、保护传递、关闭及失败停止定向验证通过；原政策37项、更新编排20场景、基线保护11场景通过，帮助/更新指南同步。未扩大到非目标开发标签、业务数据或无关重构。
- [x] T16 按实际缺口逐个退役：build-space.sh、rollback-image-policy.mjs及定向测试采用默认紧张期目标0，仅专属恢复接缝接受零，常规默认2保持。每次最多退役1个最旧未引用/未保护回滚、实测及按需回收后达标即停；无候选/无实际删除/错误退出。空间编排、原政策及新规则41项、更新20场景、保护11场景、真实配置校验和语法/diff通过，帮助/指南同步。
- [x] T15 正式最小更新验收：update.sh dsa退出0；默认零目标仅退役1个最旧DSA回滚，回收后宿主21731MiB/Docker23494MiB达标即停。目标DSA新镜像d9cdba416f1f…，三个生产文件哈希及SDK0.1.25/三个免费绑定核对，源码未在构建后覆盖；Server/Worker镜像、原DSA更新前基线、另一Server回滚及6卷/挂载保持。新09741358529bd3a8/旧a180c8307c637ac3各两次重放一致、网络0。不重采供应商或重验RQ/Tushare外部条件。

当前检查点：T14/T16/T15完成；取消紧张期1个底线、按实际缺口逐个退役及正式TickFlow镜像固化均通过。最终一致性核对通过，完整镜像ID、精确删除对象、空间及新旧重放见[本轮证据](evidence/2026-10-14-shared-docker-space.md)。既有T1～T13历史验收保持；本轮无提交、推送、发布或业务数据删除。

## 2026-10-08 容量紧张时清理历史回滚镜像

用户明确允许清理只读预览中的最旧Server `fc4df9e94993…`、DSA `b66af4e91a4b…`，并要求更新脚本加入清理回滚镜像功能。沿用原候选与保护规则，在常规整备/回收仍不足时增加默认保留1个历史回滚版本的容量恢复阶段，常规默认2不变。

- [x] T12 紧张期回滚整备接入与定向验证。写集限build-space.sh/测试、update.sh帮助及环境示例/对应说明；默认/自定义保留数、保护传递、关闭清理、失败停止及复测验证。现有保留计划与删除器不重写。Shell空间编排通过、新旧Node37项通过、镜像保留11场景通过，语法及diff检查通过。
- [x] T13 实际容量与更新验收。正式`DEV_DATABASE_MODE=check PULL_SERVICE_IMAGES=false PULL_BASE_IMAGES=false ./scripts/update.sh all`完整退出0。紧张期删除获准的Server `fc4df9e94993…`和DSA `b66af4e91a4b…`旧回滚标签；宿主23572 MiB、Docker20661 MiB达到目标后开始构建。更新前基线、运行镜像和本次DSA产物保护生效，命名业务卷和备份保留。新DSA镜像`5260ad9aec56…`、Server/Worker镜像`46b4ff775cbc…`及五容器健康核验通过；主仓F01的新镜像恢复/代表性重放也已通过，见[验收记录](../../../thesis-ledger/docs/tasks/evidence/2026-10-08-f01-image-recovery-acceptance.md)。完整日志为主仓忽略目录`f01-image-update-with-rollback-cleanup.log`。

规划核对：Ready；此前正式整备后宿主19369 MiB、Docker18109 MiB不足目标，没有开始构建。更新锁、活动builder及基线保护保持，不通过降低空间门槛放行。

## 2026-10-07 构建前 Docker 空间整备

用户要求先由脚本删减可回收Docker内容，使宿主达到20 GiB空闲目标后继续更新。既有WIP及T1～T8记录保留；本组按Spec AC12推进，不提交、推送或修改全局Docker设置。

- [x] **T9：受保护镜像整备计划与执行**。复用回滚数量/保护规则及更新锁，增加纯候选计划和精确重验执行；候选限定超额回滚、无引用无标签、所选应用未使用唯一开发标签。保护容器/卷/额外标签/指定基线/探针/其他基础镜像。新旧Node回归37项通过，覆盖候选漂移、活动构建、读取失败、非强制删除及借锁身份。
- [x] **T10：正式更新前整备接入**。同一入口/更新锁内缓存、镜像整备后实测20/18 GiB；本次已构建但尚未启动的产物按完整ID保护。增加Mac标准Desktop的固定摘要官方空闲块回收；不缩小磁盘、不挂载业务/宿主目录。Shell正反例、回滚编排、镜像保留、数据库保护、兼容门禁及diff卫生通过，文档同步。
- [x] **T11：实际库存与空间整备验收**。正式入口先删减唯一未使用开发镜像，随后实际余量达到宿主25782 MiB；Server构建前再次不足，经自动整备复测22003 MiB继续。完整更新退出0，新DSA/Server/Worker镜像已部署、五容器healthy、六volume及14条旧终态保持；17条现有/旧备份快照各两次无网络重放，新现金任务、独立复算、真实页面与下载通过。见[目标验收](evidence/2026-10-07-docker-space-preparation.md)。

规划审查：Ready。清理语义、候选、数据保护与真实测量已固定；不扩展到删除业务卷、普通有标签镜像或宿主应用缓存。实际容量结果独立验收。

真实检查点：正式`update.sh all`按新整备逻辑删除唯一候选`daily-stock-analysis:thesisledger-dev`→`sha256:16ddf4039da61de56c289e47037f5715f9e0eaed5e8fbd9bab576af98d360543`，该镜像无容器引用；Docker空闲22110→24144 MiB，最初宿主16611→16610 MiB，未把虚拟盘释放当作宿主已达标，脚本退出1。后续正式入口实测宿主25782 MiB、Docker24144 MiB，目标均满足，开始实际构建；此次起步未激活空闲块回收。分别记录于主仓忽略目录的`docker-space-images-target-update.log`与`docker-space-reclaim-target-update.log`，完整更新结束后追加运行验收。未清理宿主缓存或改变Docker磁盘上限。

对应 Spec：[`../specs/2026-09-08-docker-build-space-guard.md`](../specs/2026-09-08-docker-build-space-guard.md)

> 2026-10-05 增补：原 T1～T6 是历史已验收范围，空间硬门禁由 T7～T8 负责。T8于2026-10-07随T9～T11的真实自动整备及正式更新验收完成，见[目标验收](evidence/2026-10-07-docker-space-preparation.md)；下方10-05记录保留当时检查点。

## 空间门禁增补任务

- [x] T7：实现并验证更新入口空间硬门禁
  - 覆盖：AC9、AC10、AC11 的本地回归部分。
  - 启动依赖：既有更新/缓存辅助函数；本轮已核对干净 infra 工作树和真实 Docker CLI 能力。
  - 上下文：Spec「2026-10-05：实测空间门禁」、`scripts/update.sh`。
  - 执行边界：infra 的 `scripts/build-space.sh`、`scripts/build-space.test.sh`、`scripts/update.sh`、CI、README 和更新指南；保留主仓全部既有修改。
  - 完成条件：一次有界维护及必要的一次全清后复测，不足或未知不构建；关闭清理不绕过门禁；拉取前、逐服务和重试均受保护；同 daemon 更新互斥。
  - 验证：Shell 语法、行为替身、已有纯脚本测试、diff 检查。通过后停止本地实现，单独进入 T8。
  - 执行记录：已完成；新增 helper、行为回归及 CI 入口，`update.sh` 行数减少。门禁故障不会进入构建重试；第二个服务余量不足不会重新构建第一个服务。修改未提交。
- [x] T8：核对真实空间并验收官方更新
  - 覆盖：AC11 的目标运行态部分；依赖 T7。
  - 执行边界：只读空间探测；无其他活动构建时通过 `./scripts/update.sh` 的最小必要目标执行清理和更新。
  - 完成条件：真实探测、实际缓存维护和更新结果分别有证据；不足时明确保留阻塞，不人为降低阈值。
  - 停止条件：发现其他活动构建或空间达不到门槛，不清理并发构建、不启动重复部署；记录所需容量处理。
  - 执行记录：真实探针通过；固定已有 `node:24-alpine` 镜像 ID 创建临时只读、无网络、无卷容器执行 `df`，自动删除探针容器。记录宿主机 20161 MiB（门槛 20480）、Docker 9309 MiB（门槛 18432）。`desktop-linux` history 仍返回 Running，实际并发保护明确拒绝。未运行真实 prune 或重复官方更新，T8 保留未完成；读数为本轮采样，活动构建可能继续改变余量。
  - 最终验收：2026-10-07正式入口在同一更新锁下完成真实缓存/受保护镜像整备和逐阶段复测，Server构建前宿主恢复至22003 MiB后继续，`update.sh all`完整退出0；新镜像、实际业务、旧快照与数据保持证据见上方T11。

规划预检：Ready。T7 为单一脚本门禁结果，T8 独立验证运行态；无全局设置写入、卷删除或镜像删除范围。当前活动 DSA 构建阻止 T8 的清理与部署部分。

### 2026-10-05 增补最终一致性 Review

- 本地范围通过：AC9/AC10 的实现、命令替身及真实探针一致；参数、用户文档、CI 与行为一致。测试包含正常放行、全清后恢复、清理成功仍不足、宿主机不足、未知/失败读取、清理关闭、其他活动构建、重复锁、builder/daemon 错配、拉取前阻断、第二个服务阻断、普通错误与 ENOSPC 两次失败上限。
- 验证通过：逐文件 `bash -n`；`bash scripts/build-space.test.sh`；既有 `update-server-dockerfile.test.sh`、`update-dsa-dockerfile.test.sh`、`retain-rollback-images.test.sh`（9 场景）、`preserve-database.test.sh`；`node scripts/check-compatibility.mjs`；`git diff --check`。
- 整体验收阻塞：AC11 的实际清理和官方更新仍由 T8 持有。活动 DSA 构建与当前实测不足为停止原因，未降低门槛或把只读探针当作真实更新通过。
- 保留风险：互斥只覆盖新版入口；外部构建仍可能在检查之后写入。32 GiB 上限及全局 20 GiB GC 保留底线尚未调整；旧回滚镜像保留策略未修改。脚本防止已知空间不足时开工，不能保证无限期容量充足。
- 工作树：本轮仅修改 infra 所列文件，保留主仓既有 WIP；没有提交、全局 Docker 设置变更、业务卷或镜像删除。

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

- [x] T5：配置 pnpm 11 本地依赖镜像
  - 覆盖验收标准：AC7
  - 依赖：T2
  - 涉及范围：`scripts/update.sh`、`docs/docker-update-workflow.md`
  - 完成条件：临时 ThesisLedger build stage 为 pnpm 11 设置 `pnpm_config_registry=https://registry.npmmirror.com`，并保留 Corepack、npm 兼容子进程与 node-gyp 的独立镜像配置；共享 Dockerfile 不变。
  - 验证方式：Shell 语法检查；在相同 Node/pnpm 环境读取有效 registry；执行一次 `./scripts/update.sh thesis-ledger` 并检查构建与服务健康结果；`git diff --check`。

- [x] T6：持久化本地 Prisma 引擎下载缓存
  - 覆盖验收标准：AC8
  - 依赖：T5
  - 涉及范围：`scripts/update.sh`、`docs/docker-update-workflow.md`
  - 完成条件：临时 ThesisLedger Dockerfile 的 build/runtime 两次 `prisma generate` 使用同一个 `/root/.cache/prisma` 命名 cache；不设置缺失目标产物的 npmmirror Prisma 镜像，不关闭 checksum 校验，共享 Dockerfile 保持不变。
  - 验证方式：Shell 语法检查与静态契约核对；首次真实构建填充 Prisma cache；使源码复制层失效后再次构建，确认 `prisma generate` 成功且不再访问 `binaries.prisma.sh`；检查服务健康；`git diff --check`。

## 历史最终一致性 Review（T1–T6）

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

- 结论：通过。AC1 至 AC8 均已有实现与验证证据。
- 发现的问题：真实验证确认 Compose 的全局 `--parallel 1` 不能阻止同一次多目标 build 在 BuildKit 内并行，已改为分别调用 `compose build dsa` 与 `compose build thesis-ledger`；本地更新验证入口已收敛为语法检查、静态契约核对和真实更新验证；pnpm 11 的有效 registry 已在临时 build stage 中配置为 npmmirror。复核后无未解决问题。
- 遗留风险：BuildKit 空间阈值是 GC 目标，活跃记录、镜像共享层与缓存保留底线可能使 `docker system df` 的 Build Cache 总数高于 8GB；单个冷构建若超过物理可用空间仍需扩容。负向重试分支不再有专用自动回归覆盖；npmmirror 本轮出现过瞬时超时但重试成功；当前环境未安装 `shellcheck`，因此本轮未获得其静态分析结果。
- 验证命令与结果：
  - `bash -n scripts/update.sh`：通过。
  - 静态契约核对：默认缓存维护、显式关闭、逐服务构建、pnpm store 复用、普通失败、ENOSPC 修复、二次失败及预检分支均与 Spec 一致。
  - 已删除入口引用扫描：无匹配；`scripts/` 中仅保留实际使用的更新、启动、契约检查与数据库初始化脚本。
  - `./scripts/update.sh all`：在清空 BuildKit cache 后真实冷构建通过，DSA 完成后才开始 ThesisLedger；`pnpm deploy` 全程 `downloaded 0`；最终 DSA 与 ThesisLedger 均为 healthy。
  - `docker system df` 与 `docker buildx du`：脚本完成后 Build Cache 为 8.836GB，其中 Shared 4.873GB、Private 3.963GB；Docker 根文件系统可用 17,394,304 KiB。后续阈值诊断仅移除 327.1MB 共享缓存元数据，Private 与实际空闲空间基本不变，符合共享镜像层不会释放实际空间的边界。
  - ThesisLedger 容器日志：`Nest application successfully started`，未再次出现 `systemKey` 或 `P2022`。
  - 相同构建环境 registry 检查：Node 24 Alpine、pnpm 11.9.0 下的 `pnpm config get registry` 返回 `https://registry.npmmirror.com/`。
  - `./scripts/update.sh thesis-ledger`：通过；Buildx 记录 `rp4cxxqhzcvqt2e0cbolrxsau` 中 Corepack 与所有可见依赖元数据请求均使用 `registry.npmmirror.com`，未出现 `registry.npmjs.org`；deploy 保持 `downloaded 0`，服务最终 healthy。
  - Prisma 引擎 cache 首次构建：Buildx 记录 `jk0uvu1y3h7zxmjt7kvixcmsz` 中 build/runtime 两次 `prisma generate` 均通过同一个命名 cache 执行并成功，最终服务 healthy。
  - Prisma 引擎 cache 复用：加入临时构建上下文探针使 `COPY . .` 后的步骤失效后，Buildx 记录 `t4pnk9td4u3lodxn9ark7ixdn` 再次执行两次 `prisma generate` 并成功，日志中未出现 `binaries.prisma.sh`；`docker buildx du --verbose` 显示 `/thesis-ledger-prisma-engines` cache 为 15.74MB、usage count 为 6；探针随后已删除。
  - 服务检查：`thesis-ledger-dev-thesis-ledger-1` 为 healthy，日志包含 `Nest application successfully started`，未出现 `P2022` 或 `systemKey` 错误。
  - `git diff --check`：通过。
