# 更新前 Docker 空间整备目标验收

关联：[Spec](../../specs/2026-09-08-docker-build-space-guard.md)、[Task](../tasks/docker-build-space-guard.md)。用户要求由脚本先删减Docker内容，使宿主达到20 GiB后执行更新。本次已实现并完成真实目标验收，既有工作树保留，未提交或推送。

## 实现与保护

`scripts/build-space.sh`在正式`update.sh`的更新锁内依次执行有界缓存维护、实测、全清可回收缓存、受保护镜像整备及再次实测。`scripts/docker-space-images.mjs`复用原回滚保留政策及锁/活动构建校验，默认预览；实际执行精确重读候选的ID、容器引用、标签和保护关系，再非强制删除。

候选限定超额且无额外标签的回滚、无引用无标签镜像、所选应用未使用的唯一开发标签。运行与停止容器引用、基础/其他标签、指定基线、探针、卷、工程、备份和宿主缓存保持。每个服务构建成功后立即登记完整镜像ID，防止后续空间整备删除本次已构建但尚未启动的产物。`REPAIR_BUILD_CACHE_ON_NO_SPACE=false`关闭自动整备，未知或未达到实际目标仍拒绝构建。

Mac标准Desktop且存在Docker.raw的环境提供固定摘要的[官方空闲块回收](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)条件分支。其镜像清单为已核验的linux/amd64、32021字节，使用临时自动删除、无网络、只读根文件系统容器；按官方要求临时使用privileged与VM host PID命名空间，不挂载业务或宿主目录、不改变磁盘上限。本次实际目标的余量在镜像整备后已经满足，因此该条件分支未激活；正反例由Shell替身回归覆盖，不记为实际执行过。

## 实际整备与完整更新

执行目录`thesis-ledger-infra`，入口及参数：

```bash
DEV_DATABASE_MODE=check PULL_SERVICE_IMAGES=false PULL_BASE_IMAGES=false ./scripts/update.sh all
```

用户本条指令授权Docker内容删减，没有扩展到宿主缓存或业务数据。只读预览唯一候选为未被任何容器引用的`daily-stock-analysis:thesisledger-dev`，ID `sha256:16ddf4039da61de56c289e47037f5715f9e0eaed5e8fbd9bab576af98d360543`。正式入口删除该未使用构建产物，Docker空闲由22110升至24144 MiB；最初宿主16611→16610 MiB，脚本如实拒绝继续，不把VM余量等同宿主余量。

后续正式入口实测宿主25782 MiB、Docker24144 MiB，均达到目标，开始构建。此为实际复测结果，不把宿主读数增加全部归因于镜像逻辑大小。

DSA构建完成后，完整ID立即受保护；Server构建前首次测量宿主17097 MiB、Docker16808 MiB，未达到目标。自动缓存整备后宿主19863 MiB、Docker22108 MiB，继续镜像整备/复测达到宿主22003 MiB，随后构建Server，没有要求用户手工清理，也没有删除刚完成的DSA产物。完整`update.sh all`退出0，数据结构检查、消费者启动与健康检查均通过。

| 目标 | 已部署镜像 |
| --- | --- |
| DSA | `sha256:18da63560fdf58978764a998adbded528ccce87a9f537a2e019423247ea12fc4` |
| Server / Worker | `sha256:d56b95284530a4d8b4f70cd3bb9aecce92d4d7849df5e5913ffe97d9753dc972` |

三个应用容器及PostgreSQL、Redis均healthy；原6个volume名称保持。14条已有业务终态的结果与Manifest摘要与更新前完全一致。完整镜像替代原可写层快更；未发布远端或执行正式灾备。

日志保存在主仓忽略目录`.recovery-artifacts/m31-2026-10-07/`：`docker-space-images-preview.json`、`docker-space-images-target-update.log`、`docker-space-reclaim-target-update.log`、`p6-image-before-terminal-jobs.json`及`p6-image-deployed-terminal-jobs.json`。原容器镜像/回退基线保留，没有删除数据库或回写历史结果。

## 业务回归

在新Worker中，M31已发放/应收、P6 CN/HK/US和旧US配置六条现有快照各两次重放，结果校验值保持，网络0。10-03原备份11条V3旧终态（5 complete、3 partial、3 unavailable）各两次生产验证/重放，原校验值保持，网络0、文件写入0、数据库未恢复。

此外，通过新镜像的标准准备/创建/Worker新增现金任务`a2274899-2d16-4a46-9b17-ad78c59c5f9a`，持久succeeded/attempt1/partial，校验值`5d1a7d83d42a4004`、Snapshot `0c06f2c585a46404ccc4de276cbf07dec059b1fd4d4e5c80c037819362429474`。当前实际原价来源Tencent，官方现金包保持原件/修订身份；独立Decimal复算12400份、793.6元现金、最终权益102777.6及全部权益点一致，两次离线重放网络0。

实际Safari显示已发放、资格数量、来源、未知上市/历史可见性和现金基准限制；真实下载`/Users/yzin/Downloads/backtest-a2274899-2d16-4a46-9b17-ad78c59c5f9a-diagnostics-v2.json`与完整当前客户端映射/API/Snapshot/校验值深度一致，文件SHA-256为`6d751e301a370e7312935f7a1a03f79c74d08ccad6cbaacc96780bd213a737fa`。

## 验证与结论

- 新旧Node镜像政策回归37项通过；包含保护、最小目标、数量保留、候选重验、活动构建、读取失败及非法借锁。
- `build-space.test.sh`通过；含镜像释放后达标、清理失败/无释放、关闭清理、新构建产物保护、Desktop回收达标/失败/非Desktop跳过及原串行/重试/探针场景。
- 回滚编排19场景、镜像固定与数据库保留回归通过；修复其缺失的既有空环境阶段替身，保留失败阶段拒绝。
- Shell语法、仓库兼容门禁、文档本地链接及`git diff --check`通过；新Node回归已接入`compatibility.yml`。没有运行远端GitHub Actions。

T9～T11通过，更新前主动Docker整备、实际目标满足、完整镜像更新及业务回归分别有证据。10-06缺失的指定旧B4资产仍由主仓补全Task等待较新备份，不用这11条旧样本冒充该身份已恢复。
