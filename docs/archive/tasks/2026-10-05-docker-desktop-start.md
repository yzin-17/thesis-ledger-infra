# Docker Desktop 启动实施

对应[现行规格](../../specs/2026-10-05-docker-desktop-start.md)。状态：D1～D5 已完成；2026-11-03 真实强制分支、正式应用恢复与保护核对通过，最终复核后归档。

- [x] D1 维护 start/status 入口；命令替身验证已运行、启动成功、失败和未知参数。
- [x] D2 执行 start，独立检查 daemon、既有服务和投资复盘健康；不把 daemon 可连接当成应用验收。

本轮 `start` 在 daemon 已就绪时退出 0，属于幂等无操作，不宣称执行过启动故障恢复。初始业务服务停止，随后经官方 `update.sh thesis-ledger` 保数据更新后五个服务健康，投资复盘候选、快照与已存在模型报告读取通过。daemon 与应用两层证据分别记录于主仓[复盘收口证据](../../../../thesis-ledger/docs/evidence/2026-10-05-journal-review-completion.md)。

## 2026-10-25 残留后台恢复

- [x] D3 在既有恢复入口增加显式强制停止分支，保留默认普通恢复语义、磁盘／活动更新检查和有限超时；停止失败不启动，启动失败不追加变更。
- [x] D4 命令替身覆盖显式选择、预览／健康幂等、停止失败、启动失败、恢复后仍不可用，以及磁盘／活动更新拒绝；`node --test scripts/docker-desktop-recover.test.mjs` 共 11 项通过，不触及真实资源。
- [x] D5 在真实 daemon 不可连接输入下执行一次强制停止／启动分支，独立检查引擎，经正式入口恢复应用并核对新旧记录、业务数据、来源和挂载。原 G3-D25 的 V2 关闭与模型失败证据继续保留；当前配置按后续已启用状态保留，恢复不调用模型。

10-25 的 `--execute --force-stop` 进入时 daemon 已恢复，返回 `engineReady=true`、`restarted=false`，实际命中健康幂等分支，未执行强制停止／启动。随后正式 `update.sh thesis-ledger` 自动整备空间、数据库 check 与关闭更新退出 0；五服务健康，V2=false、capabilities200／canCreate=false，新旧记录、保护表、来源与挂载保持，未新增模型调用。具体事实见主仓 [G3-D25 证据](../../../../thesis-ledger/docs/evidence/2026-10-25-g3-single-formal-response.md)。当时 D5 的真实强制分支未覆盖，因此保留未勾选；该历史结论保持。

## 2026-11-03 补验前证据复核

首次核对主仓后续部署、恢复报告和两仓保留的运行制品，未找到该真实强制分支通过的记录。G3-D21 的 `restarted=true` 指向 Server／Worker 容器重启，10-30 的在途恢复也只重启应用容器，均不覆盖 Docker Desktop 强制停止／启动；当次 D5 保留未勾选，未归档。

当时剩余条件为：在原规格的 daemon 不可连接、磁盘正余量、无活动更新及保护基线成立时，经维护入口实际完成强制停止与启动，再完成正式应用／数据核对。首次按用户要求仅复核既有证据，没有操作 Docker；用户随后明确要求完成 D5，补验结果见下节。[跨仓复核记录](../../../../thesis-ledger/docs/evidence/2026-11-03-cross-repository-closeout.md)保留两阶段边界。

## D5 本次执行条件

2026-11-03 用户明确要求完成 D5。当前 `desktop-linux` 的真实 daemon 不可连接，Docker Desktop 状态亦不可取得，未发现 Docker 后台或活动更新进程，宿主余量为正。保护基线保存于主仓 `.recovery-artifacts/docker-desktop-d5-20261103/`；最多调用一次既有 `node scripts/docker-desktop-recover.mjs --execute --force-stop`，以实际步骤和退出结果判定覆盖，失败时保留原结果并处理具体根因。

恢复后独立检查引擎、应用、持久终态、旧结果、来源配置及挂载。G3-D25 的 V2 关闭与正式更新通过证据继续复用；当前 `.env` 已由后续工作启用 V2，本次保留当前配置。需要重新收敛应用运行态时仍走正式维护入口，优先复用同一已验镜像。验收只发出本机只读请求，不主动提交模型生成或外部来源业务请求；既有后台目录／健康活动单独留证。

<a id="d5-completion-20261103"></a>
## 2026-11-03 D5 完成与最终复核

- [x] 真实强制分支通过。既有恢复入口退出 0，stop force／start 各一次、均退出 0；`forcedStop=true`、`restarted=true`、`engineReady=true`，独立 info 取得引擎 `29.9.2`。初态无可见 Docker 后台，不声明重现旧 ENOSPC 或残留故障成因。
- [x] 正式应用恢复通过。原镜像 `1654b11a1f4b…` 经 `update.sh thesis-ledger` 复用，结构 check 与五服务健康通过；再经 `sync-code.sh thesis-ledger` 补回原后续快更，两角色各 725 份编译文件与当前已验证构建一致，未重新构建镜像。
- [x] 数据／来源／挂载通过。12 表原 601 行全文摘要一致，99 条回测及 26 条 AI 任务均终态；两条成功研究报告和 G3-D25 失败记录正确 API 读取 200。DSA 四表、9 条准入、12 份原件保持；原完整挂载、镜像、当前 V2 配置及其他项目容器保护核对通过，目录与健康元数据的正常启动变化单列。
- [x] 最终一致性复核通过。D1～D5、原失败事实、当前配置及证据层次一致；输入未变的静态测试复用，三仓源码／配置、HEAD／索引保护通过。任务归档，现行 Spec 保留；没有新增模型生成请求、提交或推送。

命令、参数、原始回执及数据差异见 [D5 完整验收](../evidence/2026-11-03-docker-desktop-d5-acceptance.md)。
