# 空 Docker 开发目标重建任务

关联：[现行规格](../../specs/2026-10-07-empty-docker-bootstrap.md)。状态：实施、运行验收及适用旧样本回归已完成，指定缺失资产追补已按 2026-10-08 用户决定取消；2026-11-03 复用既有证据最终复核并归档。独占新增探针初始化逻辑及其回归，保留 infra 原有 WIP；不创建其他部署入口。

- [x] 初始化：在正式更新入口锁内准备缺失探针，显式选项、严格空环境与宿主机/并发门禁。
- [x] 本地验证：Shell 语法、缺省/授权/错误分支及原编排回归。
- [x] 卷初始化：正式入口增加显式开发确认；未配置不操作，已有容器/其他卷/未标记部分卷拒绝，只创建缺失配置卷，完整集合保留；专属回归及空间编排回归通过。
- [x] 目标部署：正式 `update.sh all` 完成空间检查、镜像构建与配置卷初始化；默认 check 拒绝空库后，按用户空环境兜底授权，用既有显式开发结构入口初始化，再以现有镜像无构建启动。
- [x] 运行验收：80 张预期表、当前结构 head、五个服务与 API 依赖 healthy；两条 M31 标准任务 succeeded/attempt1，目标离线重放各两次且网络0、独立现金账、真实 Safari 页面及实际诊断下载全部通过。详见主仓 `docs/tasks/evidence/2026-10-07-m31-target-acceptance.md`。

起始空环境中旧目标资产不存在，当时按用户决定另补旧结果回归；后续原备份样本回归与缺失身份的取消决定见下节，不以新环境健康或新任务成功替代。

## 2026-11-03 旧结果证据复核与归档

- [x] 既有旧样本回归已完成。主仓 [M31/P6 补全证据](../../../../thesis-ledger/docs/tasks/evidence/2026-10-07-p6-completion-gates.md#旧资产资格与实际回归)确认 10-03 原备份的 47 条持久任务中，11 条成功 V3 的旧结果、Snapshot 和制品身份对齐；各在实际 Worker 两次无网络内存重放，原校验值保持。后续正式镜像固化后又通过同一组旧样本重放。原数据库没有恢复入当前库，不能将兼容回归解释为整库恢复。
- 指定缺失资产的追补已取消。B4 `873ba8dd…` 和旧 partial `652ba051…` 不在该备份，仍为缺失、未验证；[2026-10-08 用户范围决定](../../../../thesis-ledger/docs/specs/2026-10-03-multi-source-remaining-acceptance.md#scope-cancellation-20261008)及 [P6-G2 记录](../../../../thesis-ledger/docs/archive/tasks/2026-10-07-p6-market-state-expansion.md#2026-10-07-补全执行叶)已取消这两项专项追补，不属于延期，也不计为验收通过。
- [x] 最终一致性复核通过。正式空环境初始化及 M31 运行验收保持原结论，适用旧结果回归已有原件和报告，取消项不再作为待办；现行 Spec 保留，任务归档。此次只核对证据及摘要，没有重新运行测试、构建、恢复或业务任务。[跨仓复核记录](../../../../thesis-ledger/docs/tasks/evidence/2026-11-03-cross-repository-closeout.md)保留原始证据摘要与剩余边界。

## 2026-10-07 执行历史

2026-10-07：首次正式 `BOOTSTRAP_SPACE_PROBE=true ./scripts/update.sh all` 已下载探针与基础镜像，并实测宿主机43,750MiB、Docker27,591MiB，门槛20,480/18,432MiB保持。沙箱拒绝 Docker CLI 写 builder 活动文件导致构建退出；随后以同一正式入口申请系统写入权限并重试，已进入 DSA 原生 SDK 冷构建。进程仍运行，未记为部署完成。

M31 的有界公告登记由本仓 `scripts/cash-notice-admission.mjs` 提供，缺省返回精确计划，显式 `--apply` 才在锁内核实目标 Compose 身份、挂载和现有 DSA 数据库后登记。包原文存入内容寻址路径并读回核验，只覆盖已复核的510300现金窗口，有效24小时；参数/扩大范围/摘要错误回归2项通过。实际准入及业务运行仍待目标启动。

后续：应用镜像已完成构建；首次 Server 构建发现共享量额可空合同遗漏，修复并完成宿主受影响检查后脚本唯一一次重试成功。启动时发现四个 external 数据卷缺失，未创建业务容器。新增有界开发卷初始化后，通过正式 `BOOTSTRAP_SPACE_PROBE=true INITIALIZE_EMPTY_DEV_VOLUMES=true EMPTY_DEV_CONFIRM=thesis-ledger-dev/thesis_ledger ./scripts/update.sh all` 继续；主仓 Docker context 排除本机忽略的 `.recovery-artifacts`，不把本机捕获输入及验收产物送入镜像构建上下文。

用户随后明确授权：空环境不能使用脚本时可直接用Docker命令建立环境。第三次正式更新已完成两类镜像构建与四卷初始化，默认check在新空库缺业务结构时正确退出。按该兜底授权，确认实际`thesis_ledger/thesis_ledger`及public业务表数0，Server/Worker未启动；使用镜像中既有开发结构入口以development/rebuild、精确项目/数据库/owner及数据丢失开关生成完整SQL，再通过该PostgreSQL执行退出0。没有直接拼接DDL、删除volume或用db push替代。后续直接以已构建镜像`compose up -d --no-build`启动开发服务，保留独立结构及业务检查；当时旧结果回归尚未补，后续处置以上方最终复核为准。
