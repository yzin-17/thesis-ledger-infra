# 应用部署接口归属验证

日期：2026-11-11。状态：验证完成。[规格](../../specs/2026-11-11-application-deployment-interfaces.md)，[任务](../tasks/2026-11-11-application-deployment-interfaces.md)。

## 所有权迁移

| 内容 | 当前所有者与接口 |
| --- | --- |
| 角色权限与业务表保护 | 主仓 infra/docker/bootstrap-app-role.sql；infra 绑定并执行，SQL 与原跟踪输入字节一致 |
| Server/workspace 快更 | 主仓 scripts/local-deployment.sh 与 scripts/deployment/；infra 不再列举包、Prisma 或产物目录 |
| DSA 快更、载荷与缓存清理 | DSA scripts/deployment/；源码、原生输入和业务路径测试一并归位 |
| DSA 运行快照语义 | DSA scripts/deployment/runtime-contract.mjs；infra 经标准输入 JSON 调用，继续持锁和执行容器恢复 |
| 固定 SDK 源与构建上下文 | DSA local-deployment.sh 的 build-config、prepare-build 和 cleanup-build；infra 保留通用命令编排和停机前调用顺序 |
| AI 业务配置断言与说明 | 主仓 scripts/local-runtime/ai-deployment-contract.test.sh 与本地部署指南 |

已更新主仓数据库 CLI 默认权限路径、隔离测试输入和消费侧恢复工具；默认权限路径从实际 Prisma 输入根推导，在仓库根和 Server 包目录下生成的 SQL 一致。应用兼容判断失败时仍阻止任何容器修改；修改或健康失败时仍使用同镜像恢复。应用相关入口与恢复测试由 DSA 维护，infra CI 调用所属仓库测试。

infra 的边界门禁现在覆盖子目录、Shell、Python 和 SQL 的已确认实现标识，以及 MJS 的静态和动态依赖。该门禁防止已确认模式回归，不代替所有权审查；公开 Compose 参数、服务名和部署命令继续由 infra 消费。

生产脚本按 scripts/ 下非测试 .mjs 与 .sh 同一口径统计：3052行降至2600行，减少452行。SQL、Python、测试和说明另计。

## 定向、包级与门禁

| 检查 | 结果与输入范围 |
| --- | --- |
| infra node --test scripts/*.test.mjs | 最终32项：31通过、0失败、1项真实只读检查默认跳过 |
| DSA node --test scripts/deployment/*.test.mjs | 50项通过，含真实入口配合命令替身的快更、恢复、原生输入拒绝与保护测试 |
| 主仓 node --test scripts/deployment/*.test.mjs | 2项通过，含依赖/结构漂移、载荷、重复输出与构建失败 |
| 主仓和 DSA scripts/local-runtime/*.test.mjs | 分别80和38项通过；更新了跨仓导入及源摘要调用方 |
| infra scripts/*.test.sh | 最终14个文件全部通过，含保卷重装、空间、复用、配置、快更与失败停止 |
| DSA prune-bytecode.test.py、prepare-local-sdk-source.test.sh | 通过，保留符号链接和资料、固定版本与缓存检查 |
| 主仓 AI 配置及权限 --check-only | 通过；业务开关与权限断言由应用维护 |
| Server 数据库 structure/upgrade-sql/upgrade-plan | 25项通过 |
| pnpm --filter @thesis-ledger/server... build | 四个 workspace 包通过；默认权限路径调整后又完成最终 Server build |
| 默认权限 SQL 生成 | 根目录与 Server 包目录均成功，输出126043字节且一致；只生成 SQL，未连接数据库 |
| python scripts/test-dev-database-rebuild.py | 隔离 PostgreSQL 通过：101表、当前 head、失败回滚、错误目标拒绝、业务表权限及缺表拒绝；临时样本和容器由原维护脚本清理 |
| DOCKER_READONLY_ACCEPTANCE=true node --test scripts/docker-reinstall-plan.test.mjs | 5项通过，显式补验默认跳过的真实只读卷映射合并 |
| infra 部署边界、主仓 import 边界、兼容清单、DSA AI 治理、三仓 YAML 与 diff 检查 | 通过；当前旧入口扫描无失效调用，三仓全部文档相对文件链接有效 |

迁移时受控测试发现临时路径经系统别名规范化后会跳过 Node CLI 主入口比较，现按真实路径判断；应用命令的参数拒绝和载荷目录保护改用明确失败退出。最终测试保留原断言，没有因迁移放宽兼容或数据保护条件。

## 正式更新

执行目录为 thesis-ledger-infra，实际入口为 DEV_DATABASE_MODE=check HEALTH_TIMEOUT_SECONDS=180 ./scripts/update.sh all（通过 Bash 调用同一维护脚本）。退出0，耗时350.5秒；日志为 /var/folders/v1/gvgmk4cx1mz59vj63jj8_9m80000gn/T/infra-application-interface-update-0m4ctmxx.log。应用命令成功完成固定源码预取；复用本地基础镜像后构建两个应用，运行 check 结构门禁，再启动 DSA、Server 和 Worker，最后完成空间收敛。

更新前已通过主仓 protectionSql 只读记录七张业务表摘要、84个成功回测结果的摘要、数据库目标与 head，以及五个服务的全部挂载，见[更新前状态](2026-11-11-application-deployment-runtime-before.json)。完成后经独立 SQL、Docker inspect、产物校验和 HTTP 读取核对，见[更新后状态](2026-11-11-application-deployment-runtime-after.json)：

- 七张受保护表的摘要、84个成功结果摘要、数据库名与 owner 保持，activeBacktests 为0，head 为20261107010000_risk_notification_providers。
- 五个服务的命名卷、匿名卷及绑定挂载与更新前一致；全部 running/healthy，PostgreSQL 和 Redis 原容器保留。
- DSA 镜像为 sha256:5eed039c1862325b05c5b6a69a35286150de5e51f4c2ab81632d6a2538e8423f；Server/Worker 共用 sha256:dd12fd88e7d43e93eb0f9beb81059386ad87efbb620e735a4e1a516fd678084b。
- Server/Worker 容器中数据库部署 CLI 的编译产物摘要与本机最终构建一致；DSA 容器的兼容基线与当前应用输入深比较一致。
- 独立读取 Server /api/v1/health 和 DSA /health，均返回200。没有通过业务 API 创建任务、新闻准入、来源实读或模型调用。

## 最终一致性审查

AC1～AC5 全部通过。业务实现、测试和说明随应用维护，infra 只消费命令与公开部署配置；旧调用路径、测试位置、CI 与文档导航已同步。已有未提交改动保留，未新增延期事项或执行 Git 提交/推送。

真实运行覆盖正常保留数据更新和当前目标状态；失败恢复、路径越界、授权与受控业务输入通过替身/隔离样本验证。本次没有对共享开发运行态做故障注入。远端 GitHub Actions 未触发，本地门禁与 YAML 校验通过；跨仓交付顺序应为 DSA、主仓、infra，确保消费者能找到新接口。
