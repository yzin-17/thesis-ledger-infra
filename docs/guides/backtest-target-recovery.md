# 回测目标生命周期验收

主仓的验收合同见 [`2026-09-09-backtest-bullmq-lifecycle.md`](../../../thesis-ledger/docs/specs/2026-09-09-backtest-bullmq-lifecycle.md)，运行记录见[目标验收证据](../../../thesis-ledger/docs/evidence/2026-10-06-backtest-target-lifecycle.md)。本入口只验证当前 V3 Run。

## 执行前提

从 infra 根目录执行，使用本机 `desktop-linux` context。目标必须精确为 `thesis-ledger-dev/thesis_ledger`，五个服务健康，Server/Worker 镜像一致，数据库名及 owner 均匹配。脚本与正式更新共享互斥锁；存在其他业务在途任务或活动镜像构建时退出。

脚本读取主仓 Server 构建产物；主仓构建、结构检查和定向测试必须先通过。目标已有镜像的生命周期输入应与本次验收输入一致。主仓并行新增 migration 时，基础生产启动从实际目标镜像派生完整结构输入；目标更新仍必须通过正式更新入口及其数据库结构门禁。

## 目标故障

```sh
node --test scripts/backtest-target-recovery.test.mjs
node scripts/backtest-target-recovery.mjs \
  --confirm thesis-ledger-dev/thesis_ledger \
  --scenario hard-kill \
  --output /private/tmp/tl-backtest-target-hard-kill.json
```

场景可选择 `normal`、`hard-kill`、`redis-active`、`redis-queued`、`queued-cancel`、`running-cancel`、`cancel-crash`，必须串行运行。`BACKTEST_T4_UI_CANCEL=true` 使 running 取消场景等待浏览器或 Electron 实际点击取消，最长等待 150 秒；超时即验收失败。

脚本只创建自有幂等前缀的 V3 Run，使用该 Run 的快照读取屏障确认真实领取；正常执行参数保持默认。故障过程中保存业务表摘要及原快照字节；退出时恢复该快照、原容器及镜像身份，并等待五个服务健康。原始结果 JSON 权限为 0600，不记录密钥。发生清理失败时保留错误证据及互斥锁，应先恢复目标并核查在途任务再重试。

## 基础生产启动

```sh
node scripts/backtest-production-compose-smoke.mjs \
  --confirm isolated-production-smoke
```

脚本创建独立项目、四个专属卷和专属空库，复用当前目标镜像 ID，不拉取或发布镜像。先执行镜像内全部 migration 和应用角色初始化，再启动 Server/Worker。验证正确结构 head、预期表数、五服务健康及宿主机临时回环端口的 API 返回 200。

所有卷都必须属于本次独立项目，不能连接共享外部卷；只有这个专属环境会使用 `down --volumes` 清理。完成后再次核对原共享目标健康、身份和受保护摘要。此项记录生产配置启动；共享目标部署使用 `./scripts/update.sh thesis-ledger`，保留数据升级使用该入口的 `DEV_DATABASE_MODE=upgrade` 及精确目标确认、备份和演练要求。

基础 Compose 的 Server 在容器内监听 `0.0.0.0`，宿主机端口默认绑定 `127.0.0.1`。容器内健康和宿主机映射 API 都必须通过。只检查容器内健康不足以证明 Desktop 可以访问 API。
