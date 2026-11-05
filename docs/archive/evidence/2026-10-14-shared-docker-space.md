# 共享 Docker 磁盘紧张期回滚范围核对

对应[空间保护Spec AC13](../../specs/2026-09-08-docker-build-space-guard.md)及[Task T14/T15](../tasks/docker-build-space-guard.md)。以本地未提交工作树为事实源，保留全部并行修改。

## 已确认的根因

前次正式`update.sh dsa`日志`/tmp/tickflow-free-image-update.log`：宿主10271→12646→13697→17269→18545→19325MiB；Docker12651→18851→20906MiB。自动缓存整备、紧张期DSA旧回滚删除和两次官方Desktop空闲块回收均执行；最终宿主比20480MiB少1155MiB，没有进入构建。

`repair_docker_image_space`将所有阶段的目标绑定为更新target=dsa，因此紧张期遗漏同一磁盘上Server的超额回滚版本。2026-10-14在infra通过正式回滚规划器的只读全局预览（ROLLBACK_IMAGE_KEEP_COUNT=1）发现候选`thesis-ledger:rollback-e03d149eeea2e7bf632a08b06b9320431c1d8f12b4b1b5f4fa6ee295f7e8b945`；同次默认保留2个的预览没有候选。原文分别保存于`/tmp/docker-space-current-tight-preview.json`与`/tmp/docker-space-current-all-preview.json`。未执行删除，不以逻辑镜像大小承诺释放量。

修复只改变最后紧张期的历史回滚规划范围，两个应用共享同一更新锁和空间目标；复用原rollback-image-policy执行器，其他保护、普通整备及最小构建目标保持。

## 验证与运行态

新回归先按dsa/thesis-ledger两个单目标设定只有全局超额回滚能释放空间，原实现失败“单目标遗漏另一应用的超额回滚空间”。修复后空间编排通过，日志`/tmp/docker-shared-space-green.log`；原镜像/回滚政策37项通过、更新编排20场景、基线保护11场景及Shell语法通过。空间测试的完整更新替身补齐当前已存在的SDK源预取阶段，不改变生产SDK构建逻辑。

在`/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`执行正式`bash scripts/update.sh dsa`，默认保数据check及原拉取/构建参数；完整日志`/tmp/tickflow-free-shared-space-image-update.log`，退出1。共享回滚阶段确实移除此前计划的旧Server标签`thesis-ledger:rollback-e03d149eeea2e7bf632a08b06b9320431c1d8f12b4b1b5f4fa6ee295f7e8b945`，跳过0个。Docker实际20906→21439MiB，只释放533MiB，不能把镜像逻辑大小当作共享层实际释放量。

随后官方Desktop空闲块回收使宿主19227→19759MiB，Docker仍21439MiB；宿主比20480MiB少721MiB。脚本在拉取和构建前停止，目标服务/镜像未切换，TickFlow仍为已有正式sync-code的容器可写层版本。当前紧张期规则仍保留每应用1个历史回滚；本轮只修共享范围，没有取消最后历史版本的保留政策。没有清理容器、业务卷、备份或宿主文件，也没有重采供应商。

## 本轮用户授权的零底线及逐个退役

用户明确允许清理未引用、未保护的历史回滚，保留当前运行镜像、指定基线和数据卷，并要求按实际缺口清到门槛后完成dsa固化。现行默认BUILD_SPACE_ROLLBACK_KEEP_COUNT=0；以上保留1个的不足记录作为历史保留，由当前Spec AC14取代。

专属space-recovery只在正式更新锁内执行，每次至多退役1个最旧候选；无实际删除返回2，失败返回1，普通维护仍拒绝零。Shell以每次实际空间复测决定继续或停止，不靠镜像逻辑大小预测。零目标下的当前/停止容器、指定基线及额外标签保护、候选并发转为保护对象、一次/多次达标、无候选及关闭均通过定向验证。

验证日志：`/tmp/docker-space-zero-green-shell.log`，政策41项`/tmp/docker-space-zero-green-policy.log`；更新20场景、基线11场景分别为`/tmp/docker-space-zero-update.log`和`/tmp/docker-space-zero-retain.log`；Shell语法、真实零模式配置校验及diff通过。旧普通零参数拒绝测试保留，不改变日常保留默认2。开始正式update.sh dsa，日志`/tmp/tickflow-free-zero-floor-image-update.log`；真实结果返回后补充。

正式入口的空间恢复已通过：起步宿主19674MiB/Docker21438MiB；零目标阶段仅退役最旧DSA `daily-stock-analysis:rollback-791828afc03ecce923cf7d0393c18535adb73b28ef744e8c9211c470d82ca50a`，移除1个/跳过0个。退役后Docker23494MiB，官方Desktop回收后宿主21731MiB达到20480目标，随即停止退役、进入固定SDK预取及dsa构建。没有继续退役另一个旧Server回滚，验证实际缺口达标即停，不删除全部候选。

## 正式固化与独立核对结果

同一正式`bash scripts/update.sh dsa`完整退出0，固定SDK预取、构建和目标启动通过。DSA新镜像及实际容器一致为`sha256:d9cdba416f1f56b974adf5090ebf5f8d45a68bc484e735c67c08481b989fd48f`；Server/Worker仍为`sha256:71621979c96cc7f4713406ac55d1202c48b63d1fba074e791669cf094e4bd12b`，五容器健康。仅DSA镜像变化，六卷名称及三应用全部挂载逐项一致，原DSA基线`51b6b86b755b…`及剩余Server回滚`3e978118f765…`仍可inspect。

只读目标Python导入确认免费URL、三个绑定、SDK0.1.25及沪深A股/B股范围；tickflow_free_history.py、tickflow.py和thesis_ledger_capability_sources.py三文件SHA256与宿主相等。新容器diff无这三个源文件变更，且容器镜像ID等于新开发标签，证明来自已固化镜像；本轮未在构建后再sync-code。对应原文`/tmp/tickflow-image-zero-source.json`、容器前后/卷前后及diff，派生核对`/tmp/tickflow-image-zero-verification.json`。

在同一Worker只读使用原research-window-replay.mjs及原比较模块字节，阻断fetch/http/https/net/tls。原比较模块以内联data URL供stdin入口读取，没有写容器或更改计算。TickFlow新Run `9f2cfeaa-b8dc-4ba0-8b5f-2c275a04696c`，快照`9b8f81456596b19122a1ab6d3c9ab2af28ca83fcaca98c5e77bc24d767af3b34`，两次checksum均`09741358529bd3a8`；旧现金v2 Run `8db8879d-e27d-4d8b-8df2-96eba083fee6`，快照`ce9aec6e5322e4ba9712454e6e38ac50a2e63e6b549f4d048f88b253a3832457`，两次均`a180c8307c637ac3`。均identicalReplay=true、replayCount=2、networkCalls=0，所有物理产物验证保持；原文为`/tmp/tickflow-free-image-new-replay.json`和`/tmp/tickflow-free-image-old-replay.json`。

T15真实门禁通过，空间与TickFlow固化阻塞解除。此前读取/口径/正常新研究/独立复算/页面下载证据复用；有限样本、单位/调整锚点和历史可见性限制保持，RQ/Tushare实现完成与外部权益条件分层保持。本轮没有新供应商请求、凭据写入、真实Ledger写入、清库删卷、提交推送或生产发布。
