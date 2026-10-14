# 已完成 DSA 镜像复用实施记录

对应当前规格：[更新中复用已完成的 DSA 镜像](../../specs/2026-10-07-update-resume-built-image.md)。状态：已完成，历史执行记录。

- [x] T01：正式入口支持精确 DSA 镜像 ID 复用，空间检查集中在入口一次。写入`update.sh`、构建辅助模块及使用说明；匹配身份后仅跳过重复构建，数据库、并发和健康门禁不变。
- [x] T02：定向复用及既有空间编排回归。写入独立Shell测试；非法／错配镜像、默认行为、只跳过DSA、保护与空间断言均验证。
- [x] I01：用已完成镜像恢复真实更新。只在既有镜像来自本次成功构建、源码未变化且宿主至少20GiB时执行正式入口；核对实际容器镜像、健康与公告功能。

用户补充：空间整备和门禁仅在脚本入口执行一次，各镜像构建不重复检查。对应测试分别断言入口低余量拒绝、正常全栈只有一次预检、运行中不重复探测；初始清理流程内部的复测保留，实际ENOSPC恢复仍有上限。

已完成候选：`sha256:b66af4e91a4bd5fb59214ed1d20a5066c50204a0a2a7c5671325d8fbb7b0e838`，由本次`update.sh all`成功构建DSA输出；随后Server前空间门禁退出75。运行容器仍使用原镜像，未直接改变Docker状态。

定向验证：`bash scripts/reuse-dsa-image.test.sh`、`bash scripts/build-space.test.sh`、`bash scripts/rollback-image-update.test.sh` 全部通过；最后一项19场景通过。`bash -n` 检查入口、辅助模块和两项测试通过。输入为本次入口单次检查与精确复用改动。

真实恢复执行前宿主空闲20,937 MiB。正式入口`REUSE_DSA_IMAGE_ID=sha256:b66af4e91a4bd5fb59214ed1d20a5066c50204a0a2a7c5671325d8fbb7b0e838 ./scripts/update.sh all`在infra目录执行，退出0；入口单次记录宿主20,963MiB、Docker19,612MiB，DSA复用，Server正常构建。日志`/tmp/announcement-target-resume.log`。

目标DSA实际镜像与指定ID一致，Server／Worker镜像`sha256:87ef0df18aeb80f596f1379dc06237593e19b8d588e4e17bbcc7b99d78973499`；五个服务健康，数据库和持久卷保留，回滚镜像移除0。新公告查询HTTP200，目标获取四家公司六份公告、六PDF、四份解析、两份保留未解析，实际浏览器显示六份并可筛选三份。

最终评审：默认构建行为不变，只有显式完整ID且身份匹配时跳过DSA；入口一次预检、产物保护、数据库及健康编排有测试和真实更新证据。范围内任务全部完成；无提交并行工作。公告项目独立的后续HTTP状态路由验收仍由主仓活动Task持有。
