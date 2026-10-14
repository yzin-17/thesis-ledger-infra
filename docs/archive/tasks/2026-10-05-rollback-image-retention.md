# 回滚镜像数量保留机制实施任务

对应规格：[回滚镜像数量保留机制](../../specs/2026-10-05-rollback-image-retention.md)

> 状态：本轮实施与真实只读验证完成，未执行真实镜像删除。
> 执行范围：同级 infra 脏工作树；保留其他聊天已有改动，不提交、不构建、不更新 Docker。
> 协作：已告知原聊天由本聊天承担完整实施；原聊天拥有构建 context 修复，接入其最终更新流程时仅改动保留机制所需位置。

## 任务

- [x] T1：实现数量规划、保护规则与维护执行器。
  - 覆盖：AC01、AC02、AC03。
  - 依赖：已核对回滚标签、容器挂载、更新锁与现有固定镜像函数，设计无阻塞问题。
  - 入口：Spec 保留与执行契约；`scripts/retain-rollback-images.sh`、`scripts/build-space.sh`。
  - 可写：新 `scripts/rollback-image-policy.mjs` 与对应测试；固定镜像函数及其测试。
  - 完成条件：默认预览无移除调用，应用只移除精确标签，保护与错误路径通过模拟 Docker 命令测试。
  - 验证：Node 定向测试、现有固定镜像测试；仅替身，不接触真实 Docker 状态。
  - 执行记录：数量规划与执行器已实现；最终 Node 23 个测试、固定镜像 11 个场景通过。逐项复核与 `--no-prune` 均有命令替身断言；没有真实镜像删除。
- [x] T2：接入成功更新阶段及维护文档、CI。
  - 覆盖：AC04、AC05。
  - 依赖：T1 完成。
  - 可写：`scripts/update.sh` 的配置预检、成功后调用及帮助文案；新增更新阶段测试、已有 `build-space.test.sh` 的保留阶段替身；CI、README 与更新流程文档。
  - 完成条件：前置失败不清退，健康成功后清退，清退失败独立警告且不重建；已有更新门禁回归通过。
  - 验证：提取实际更新函数后以替身执行各阶段；现有相关脚本与兼容性门禁。
  - 执行记录：更新阶段 17 个场景通过，覆盖前置失败、成功后的顺序、维护失败告警、锁/基线参数与 macOS Bash 3.2 的空数组兼容；CI 纳入三类测试。已有空间编排测试新增两个保留阶段替身后通过，原聊天的 Bake/context 改动保持原样。
- [x] G1：真实 Docker 只读计划与最终一致性检查。
  - 覆盖：AC06、本轮交付范围的全部 AC。
  - 依赖：T1、T2 完成。
  - 可写：本 Task、Spec 状态与验证证据；不修改 Docker 状态。
  - 完成条件：默认入口生成真实候选与保护清单，核对当前/停止容器及显式基线保护，所有实际移除仍为零。
  - 验证：维护入口默认预览、配置保护后的只读预览、局部 diff 和中文文档检查。
  - 执行记录：真实 Docker `desktop-linux` 默认 `all` 预览保留四个历史镜像、列出两个 Server 候选；Server-only 预览保留两个、列出两个；将最旧候选显式保护后，它进入保护清单。没有调用 `--apply`，不声明空间已经释放。

## 验收映射

| 验收 | 实现与定向验证 | 真实证据 |
| --- | --- | --- |
| AC01—AC03 | T1 | G1 只读规划 |
| AC04—AC05 | T2 | 本轮不启动正式更新 |
| AC06 | G1 | 后续正式运行另记实际移除与释放量 |

## 计划预检

结论：Ready。T1、T2 为独立可验证的运维执行面；G1 为真实只读检查。真实清退未纳入本轮执行范围，不以测试替代其后续运行证据。已确认需保留当前更新前基线并处理停止容器，不采用仅按未使用状态批量 prune。

## 最终一致性 Review

- [x] Spec 的 AC01—AC06 均有实现与符合本轮范围的证据；真实删除与释放量仍明确为未执行。
- [x] 全部已勾选任务满足自身完成条件，未将替身测试当作真实清退证据。
- [x] 更新接入、目标选择、锁、容器引用、基线与错误语义一致，前置失败不淘汰。
- [x] 文档、配置帮助与 CI 同步，保留其他聊天的脏工作树和构建 context 修复。
- [x] 无阻塞问题、未分配的本轮工作或源码/规则/数据库范围扩展；未提交或推送。

结论：通过，范围为保留机制实施、隔离回归和真实 Docker 只读计划。实际清退及宿主块回收未执行；它们由正式更新/维护运行日志证明，本记录不承担额外清理或后续实现任务。

## 验证证据

验证日期：2026-10-05；输入为当前 infra 未提交工作树，保留原有改动。

| 命令或过程 | 结果与证据边界 |
| --- | --- |
| `node --test scripts/rollback-image-policy.test.mjs` | 23 个测试通过；数量、保护、并发变化、锁、失败及精确非强制移除的替身证据 |
| `bash scripts/retain-rollback-images.test.sh` | 11 个场景通过；现存/多容器和更新前 ID 固定 |
| `bash scripts/rollback-image-update.test.sh` | 17 个场景通过；实际更新函数的阶段与参数替身证据 |
| `bash scripts/build-space.test.sh` | 空间、互斥、逐服务 Bake/context 及重试编排通过；仅新增保留阶段替身 |
| `bash scripts/update-server-dockerfile.test.sh` | Server 临时 Dockerfile 合同通过 |
| `bash scripts/update-dsa-dockerfile.test.sh` | DSA 临时 Dockerfile 合同通过 |
| `bash scripts/preserve-database.test.sh` | 数据库模式、目标确认及停止失败边界通过 |
| `node scripts/check-compatibility.mjs` | 兼容清单门禁通过 |
| `bash -n` 修改的 Shell；`node --check scripts/rollback-image-policy.mjs` | 语法检查通过；macOS 自带 Bash 3.2 |
| 维护入口默认 `all`、`thesis-ledger` 及显式保护基线预览 | 真实 Docker 只读通过；Server 候选为 `5106eaea9167`、`ca749e4f5a28`；这些是当时读数，后续更新会改变计划 |
| `git diff --check`、局部 diff 和相对链接检查 | 通过；没有广泛格式化、提交、Docker 状态变更 |

首次已有空间测试因新阶段缺少替身失败；补齐两个记录桩后通过。最终自审补上 `--no-prune`，并重验全部 Node 策略测试；移除输入未变化的高成本检查未重复。
