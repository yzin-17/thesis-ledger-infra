# 本地部署仓库职责收敛实施与验证

对应[归档任务](../tasks/2026-11-11-infra-project-boundaries.md)和[持续维护规格](../../specs/2026-11-11-infra-project-boundaries.md)。本轮职责迁移、构建接口与保留数据更新验收完成；当前状态以任务为准。

## 基线与迁移

2026-11-11 初始工作区均有未提交修改：infra 10 条状态记录，ThesisLedger 439 条，DSA 141 条。本轮保留既有改动，未执行提交或推送。

114 个脚本、宿主入口及测试的旧新路径和原始摘要见[迁移清单](2026-11-11-infra-script-migration.json)。业务工具位于各应用 scripts/local-runtime/，主仓原有同名业务实现保持原路径，由迁入的宿主入口调用。研究备份的业务表、活动回测和结果校验由主仓维护；通用备份、归档与隔离恢复操作留在 infra。

11 份说明文档迁移如下。历史文档仅修复指向迁移文件的 Markdown 链接，历史命令、冻结 JSON 和原始事实保持。

| 原 infra 路径 | 当前正文 |
| --- | --- |
| `docs/guides/2026-11-10-intraday-provider-observation.md` | [2026-11-10-intraday-provider-observation.md](../../../../daily-stock-analysis/docs/guides/2026-11-10-intraday-provider-observation.md) |
| `docs/guides/backtest-target-recovery.md` | [backtest-target-recovery.md](../../../../thesis-ledger/docs/guides/backtest-target-recovery.md) |
| `docs/guides/provider-credentials.md` | [provider-credentials.md](../../../../daily-stock-analysis/docs/guides/provider-credentials.md) |
| `docs/specs/2026-10-05-journal-target-recovery.md` | [2026-10-05-journal-target-recovery.md](../../../../thesis-ledger/docs/specs/2026-10-05-journal-target-recovery.md) |
| `docs/specs/2026-10-06-authoring-target-recovery.md` | [2026-10-06-authoring-target-recovery.md](../../../../thesis-ledger/docs/specs/2026-10-06-authoring-target-recovery.md) |
| `docs/specs/2026-10-08-current-state-recovery.md` | [2026-10-08-current-state-recovery.md](../../../../thesis-ledger/docs/specs/2026-10-08-current-state-recovery.md) |
| `docs/specs/2026-11-03-astock-existing-source-check.md` | [2026-11-03-astock-existing-source-check.md](../../../../daily-stock-analysis/docs/specs/2026-11-03-astock-existing-source-check.md) |
| `docs/specs/2026-11-03-mobile-notification-acceptance.md` | [2026-11-03-mobile-notification-acceptance.md](../../../../thesis-ledger/docs/specs/2026-11-03-mobile-notification-acceptance.md) |
| `docs/specs/2026-11-04-derivative-source-check.md` | [2026-11-04-derivative-source-check.md](../../../../daily-stock-analysis/docs/specs/2026-11-04-derivative-source-check.md) |
| `docs/specs/2026-11-04-public-reference-source-check.md` | [2026-11-04-public-reference-source-check.md](../../../../daily-stock-analysis/docs/specs/2026-11-04-public-reference-source-check.md) |
| `docs/specs/2026-11-04-reference-backup-source-check.md` | [2026-11-04-reference-backup-source-check.md](../../../../daily-stock-analysis/docs/specs/2026-11-04-reference-backup-source-check.md) |

## 本地验证

使用 Node 24.22.2、pnpm 11.9.0。Node 的实际安装目录置于 PATH，避免 Volta shim 在测试合成 HOME 中选择失败。

| 执行位置 | 命令 | 结果 |
| --- | --- | --- |
| DSA | `node --test scripts/local-runtime/*.test.mjs` | 38 项通过 |
| DSA | `PYTHONPATH=$PWD .venv/bin/python -B <scripts/local-runtime 下每个 *.test.py>` | 13 个文件通过 |
| DSA | `.venv/bin/python -m pytest -q tests/test_longbridge_sdk_build_source.py tests/test_data_runtime_contract.py tests/test_data_process_recovery.py tests/test_report_metadata_page.py tests/test_report_metadata_http.py` | 99 项通过 |
| DSA | `bash scripts/prepare-local-sdk-source.test.sh` | 通过 |
| 主仓 | `node --test scripts/local-runtime/*.test.mjs` | 80 项通过 |
| 主仓 | `pnpm db:generate`、`pnpm --filter @thesis-ledger/server... build` | 通过 |
| infra | `node --test scripts/*.test.mjs` | 110 项通过，真实只读检查默认跳过；新增边界用例另行通过 |
| infra | `DOCKER_READONLY_ACCEPTANCE=true node --test scripts/docker-reinstall-plan.test.mjs` | 5 项通过 |
| infra | `bash <scripts 下每个 *.test.sh>` | 17 个文件通过 |
| infra | `node scripts/check-boundaries.mjs`、`node --test scripts/check-boundaries.test.mjs` | 通过 |

DSA 的 13 个 Python 测试文件全部通过；研报入口最终覆盖旧版证据、当前合同和非对象 result 的 ValueError 拒绝，共 11 项。受影响包级 pytest 99 项通过。主仓 80 项通过；infra 原测试 110 项通过，新增边界用例通过，默认跳过的真实 Docker 只读检查单独开启后 5 项通过。

通过的仓库检查：infra 兼容清单与部署依赖边界；主仓 import 边界、workspace 依赖、文件尺寸（6 个既有警告）和 migration matrix；DSA 运行合同、能力边界及协作资产。迁移路径、脚本语法和三仓 git diff --check 通过，三份 CI YAML 可解析。远端 CI 未触发。

全仓 lint-workspace.mjs --guardrails 返回 1：本轮未修改的 apps/desktop/src/features/strategy/use-strategy-submission.test.tsx 第 34、37、44、58、62、71、75、82、84、91 行有 10 个 require-await 错误，另有 190 个警告。该全仓失败未记为通过，也未计入本轮迁移代码的验收结果。

## 验证中的修正与边界

- 首轮 Node 26 检查中，Volta shim 在合成 HOME 下导致 infra 入口测试失败；使用实际 Node 安装路径后通过，并以 Node 24 复验全部相关测试，没有放宽源码或运行保护。
- 研报工具原固定读取 V1，但当前来源返回 V2。按证据 metadataVersion 选择对应合同，保留旧证据验证；补充非对象 result 拒绝用例，11 项隔离测试通过。
- 研究备份宿主 CLI 拆分后补齐目标常量绑定，以真实 CLI 的错误目标参数验证写入前拒绝，主仓 80 项通过。
- 宿主 domain/schemas 有 11 个缺少当前源码的旧 JS 输出。确认没有有效产物引用后，按当前源码对应产物核对；未删除这些宿主缓存，也未把旧输出当成镜像缺失。
- 日志按 ERROR/FATAL 级别及缺表/缺模块类别复核；正常 daily-error 路由映射不作为错误日志。

recommend 核对项目实际安装的 es-toolkit 1.51.0，当前入口没有哈希或进程执行候选；维护摘要复用 [Node createHash](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)，容器执行使用 Node 标准库，没有新增 npm 依赖。

## 正式更新与独立运行态验收

- 执行目录：/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra。
- 正式入口：DEV_DATABASE_MODE=check HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh all；实际 PATH 使用 Node 24.22.2 和 pnpm 11.9.0。
- 北京时间 2026-11-11 00:52:57 启动，最后日志时间 01:15:22，耗时约 22.4 分钟，脚本退出 0。Server 的 Alpine 官方源系统包下载较慢，完整流程没有失败或重新调用更新入口。
- 两个应用均通过各自原始 Dockerfile 构建。默认历史镜像维护退役两个旧回滚标签，保留更新前基线和所有卷。
- 新 Server/Worker 镜像：sha256:c24e1b1906cf4302cfe3c7bfdba417876dc620f45940957475c023398edb9a36。
- 新 DSA 镜像：sha256:1ec1f963ebaaafb59bfa8b4fb21bba484fdde6081f172b5c508f959d68c18b4e。

[更新前](2026-11-11-infra-runtime-before.json)与[更新后](2026-11-11-infra-runtime-after.json)保存独立只读核对结果，更新后全部检查项通过：

- 五个服务健康，Server/Worker 使用同一新镜像，DSA 使用新镜像；PostgreSQL/Redis 容器身份保持。
- 业务保护 SQL 结果完全相同，包括七张业务表摘要、成功回测清单、无活动回测及结构 head；实际挂载类型、卷名、来源、目的地和读写权限保持。
- migration matrix 为 49 个 migration、101 张表、head 20261107010000_risk_notification_providers；目标结构 head 与更新前保持一致，正式结构门禁通过，无缺表启动日志。
- Server 834 个 JS、shared 1 个、domain 91 个有效文件、schemas 226 个有效文件逐项与容器一致；DSA 527 个 Python/JSON 文件及其应用自有兼容基线一致。
- Server/DSA 健康 HTTP 均为 200，Worker Redis 心跳及 TTL 有效；启动日志无结构或模块错误。

验收只读取健康、文件、数据库保护摘要、挂载和日志，没有主动触发 Provider、模型、准入或业务写入。未清库。维护载荷的最终参数校验修正不属于 Dockerfile 打包输入，未改变上述运行镜像。

完整临时日志位于 /var/folders/v1/gvgmk4cx1mz59vj63jj8_9m80000gn/T/infra-boundaries-update-ma9zselc.log，仅辅助排障；完成结论由本记录和持久 JSON 支持。

## 调用方与最终核对

Codex 已启用的「盘中 K 线来源更新采样」（id k）中两个命令改为 DSA 的 scripts/local-runtime/intraday-provider-observation.mjs。通过 automation_update 更新并反读，原提示词除路径外、调度、ACTIVE 状态及目标 chat 均保持；没有执行采样或扩大授权。

最终 Review 覆盖规则、业务所有权、备份职责、迁移映射、CLI、构建参数与 SDK 上下文、更新/快更保护、CI、说明与自动任务路径，以及真实镜像、业务保护和挂载验收。本轮范围通过，任务及独占证据归档。全仓 Desktop lint 失败保留上述归属和边界，没有扩大通过结论。
