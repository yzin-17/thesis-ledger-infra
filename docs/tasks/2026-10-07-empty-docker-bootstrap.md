# 空 Docker 开发目标重建任务

关联：[Spec](../specs/2026-10-07-empty-docker-bootstrap.md)。独占新增探针初始化逻辑及其回归，保留 infra 原有 WIP；不创建其他部署入口。

- [x] 初始化：在正式更新入口锁内准备缺失探针，显式选项、严格空环境与宿主机/并发门禁。
- [x] 本地验证：Shell 语法、缺省/授权/错误分支及原编排回归。
- [x] 卷初始化：正式入口增加显式开发确认；未配置不操作，已有容器/其他卷/未标记部分卷拒绝，只创建缺失配置卷，完整集合保留；专属回归及空间编排回归通过。
- [x] 目标部署：正式 `update.sh all` 完成空间检查、镜像构建与配置卷初始化；默认 check 拒绝空库后，按用户空环境兜底授权，用既有显式开发结构入口初始化，再以现有镜像无构建启动。
- [x] 运行验收：80 张预期表、当前结构 head、五个服务与 API 依赖 healthy；两条 M31 标准任务 succeeded/attempt1，目标离线重放各两次且网络0、独立现金账、真实 Safari 页面及实际诊断下载全部通过。详见主仓 `docs/tasks/evidence/2026-10-07-m31-target-acceptance.md`。

旧目标资产在当前环境不存在；用户已确认旧结果回归另补，不能由新环境健康或新任务成功替代。

2026-10-07：首次正式 `BOOTSTRAP_SPACE_PROBE=true ./scripts/update.sh all` 已下载探针与基础镜像，并实测宿主机43,750MiB、Docker27,591MiB，门槛20,480/18,432MiB保持。沙箱拒绝 Docker CLI 写 builder 活动文件导致构建退出；随后以同一正式入口申请系统写入权限并重试，已进入 DSA 原生 SDK 冷构建。进程仍运行，未记为部署完成。

M31 的有界公告登记由本仓 `scripts/cash-notice-admission.mjs` 提供，缺省返回精确计划，显式 `--apply` 才在锁内核实目标 Compose 身份、挂载和现有 DSA 数据库后登记。包原文存入内容寻址路径并读回核验，只覆盖已复核的510300现金窗口，有效24小时；参数/扩大范围/摘要错误回归2项通过。实际准入及业务运行仍待目标启动。

后续：应用镜像已完成构建；首次 Server 构建发现共享量额可空合同遗漏，修复并完成宿主受影响检查后脚本唯一一次重试成功。启动时发现四个 external 数据卷缺失，未创建业务容器。新增有界开发卷初始化后，通过正式 `BOOTSTRAP_SPACE_PROBE=true INITIALIZE_EMPTY_DEV_VOLUMES=true EMPTY_DEV_CONFIRM=thesis-ledger-dev/thesis_ledger ./scripts/update.sh all` 继续；主仓 Docker context 排除本机忽略的 `.recovery-artifacts`，不把本机捕获输入及验收产物送入镜像构建上下文。

用户随后明确授权：空环境不能使用脚本时可直接用Docker命令建立环境。第三次正式更新已完成两类镜像构建与四卷初始化，默认check在新空库缺业务结构时正确退出。按该兜底授权，确认实际`thesis_ledger/thesis_ledger`及public业务表数0，Server/Worker未启动；使用镜像中既有开发结构入口以development/rebuild、精确项目/数据库/owner及数据丢失开关生成完整SQL，再通过该PostgreSQL执行退出0。没有直接拼接DDL、删除volume或用db push替代。后续直接以已构建镜像`compose up -d --no-build`启动开发服务，保留独立结构及业务检查；旧结果回归仍未补。
