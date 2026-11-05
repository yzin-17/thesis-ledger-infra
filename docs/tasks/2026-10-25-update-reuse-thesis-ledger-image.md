# 已验 ThesisLedger 镜像复用实施任务

对应[Spec](../specs/2026-10-25-update-reuse-thesis-ledger-image.md)。当前依赖主仓G3-D29的单次trace验收与最终关闭，不新增调用额度，不stage／commit。

- [x] R1：完整ID／标签／运行形态核验接入原update入口和构建阶段；复用模式仅强制同镜像重建Server／Worker。新复用替身测试、既有DSA复用、21场景更新编排、空间编排、构建网络、数据库check／停止边界、Dockerfile合同及Shell语法／diff检查通过，CI已接入；保留主仓既有4096 MiB构建参数，未改Dockerfile。真实关闭／重建仍由R2验收。
- [x] R2：主仓G3-D29唯一请求在TLS建立前失败，失败trace完整保存；正式 `update.sh thesis-ledger` 提供 `REUSE_THESIS_LEDGER_IMAGE_ID=sha256:d1e5369eefa33638b2847dc30563c84e41a1511e836a11200bd25a5467c738de`、V2=false／无临时策略、数据库check，退出0，无应用构建。两消费者身份改变、镜像相同，同卷12文件／123169字节和原业务／环境／挂载保持，五服务健康；[真实回执](../../../thesis-ledger/docs/tasks/evidence/2026-10-25-g3-real-trace-persistence.md)。真实上游正文仍未获得，由主仓D29c保留未勾选，不影响本叶已验镜像复用与持久化事实。

规划预检：Ready。新选项只用于已验镜像的运行态重配／重建，未选中时原构建路径不变；主仓负责单次模型预算、原业务数据与配置恢复、trace原文和重建持久化的总验收。
