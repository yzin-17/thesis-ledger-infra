# DSA SDK 构建下载恢复实施记录

对应当前规格：[构建下载恢复](../../specs/2026-10-07-dsa-sdk-build-network.md)。状态：2026-10-08全部完成并归档，本文为历史执行记录。

- [x] T01：补齐SDK安装命令转换及定向测试。仅拥有`scripts/update-dsa-dockerfile.sh`、对应测试及操作说明；不改DSA源Dockerfile或SDK版本。验证两个stage镜像源／重试、缓存保留、结构错配拒绝，源文件摘要不变。
- [x] I01：真实SDK构建与公告镜像固化。等待当前旧配置正式重试返回后，用`./scripts/update.sh dsa`执行新配置；记录入口空间、Native验证、最终镜像与目标功能，复用主仓I01.2验证，避免重复构建。

- [x] T02：精确失败构建记录维护入口。拥有`scripts/prune-failed-build-history.sh`及定向测试；复用当前context验证、空闲builder及共享更新锁。只清理本次旧SDK两次失败记录，宿主完整失败日志保留。验证拒绝非法／非失败／活动状态、精确删除及无全量参数。
- [x] T03：DSA字节码缓存维护入口。拥有`scripts/prune-dsa-bytecode.{sh,py}`与定向边界测试；默认预览，仅显式apply清理四个源码目录的可再生成pyc。验证符号链接、源码及非缓存保留，不进入持久卷；不停止服务。

准备评审：改动限定既有临时Dockerfile转换，已找到SDK原始单行命令；不绕过正在执行的更新锁，不降低空间阈值。主仓公告HTTP验收已完成；本任务只处理阻塞镜像固化的SDK下载路径。

当前旧配置日志：`/tmp/announcement-target-final-image.log`。第一次SDK安装退出100，正式脚本保留BuildKit缓存重试一次；第二次同一`libbinutils`下载再次报错。未替换服务。

T01证据：`bash scripts/update-dsa-dockerfile.test.sh`、两个修改脚本`bash -n`均通过；`bash scripts/compose-contract.test.sh`通过，未触达真实Docker状态变更。输入为SDK单行APT转换及结构／缓存／镜像源断言。Compose日志`/tmp/announcement-sdk-compose-contract.log`。

旧SDK两次失败后，新配置入口宿主22532MiB，但Docker内部18428MiB低于18432MiB。缓存与镜像整备未再释放空间，未降低门槛；只读确认本次失败记录`43zfa8y7f3246xxp0asdetus6`、`wuoqlmt32hkiqe014h5nsllw3`均为Error／failed。维护入口完成定向验证后精确移除这两条元数据。

T02定向拒绝／精确删除与语法测试通过，正式维护退出0，删除上述两条失败记录。日志`/tmp/announcement-failed-records-cleanup.log`；清理未释放足够内部空间，不把记录删除当成空间门禁通过。只读确认DSA源码pyc约7,850,043字节，为可再生成缓存，继续完成T03。

T03路径边界定向测试及Shell语法通过；正式预览381文件／7,850,043字节，显式apply退出0。Docker可用空间由18,871,144KiB增至18,879,360KiB，达到18GiB门槛，未停止服务。日志`/tmp/announcement-dsa-bytecode-cleanup.log`。

2026-10-08，修复后在infra目录正式`./scripts/update.sh dsa`退出0，日志`/tmp/announcement-target-sdk-solid-image.log`。入口一次实测宿主22511MiB、Docker18436MiB；SDK采用HTTPS源、有界重试和下载缓存，APT安装188.9秒通过，wheel及原生Storage验证成功。

DSA实际新镜像`sha256:2bb9b824a289d704fe7b097508310cf2a9832d2cc9788eba0ec4dc5be7a3f3b0`健康；公告用途修复已在镜像中。重建后六份记录／六原件摘要保持；列表、筛选、分页及两家公司实际HTTP停复牌响应Schema通过，原风险警示路由恢复至revision15、syncState=applied，凭证配置标记及准入不变。沿用两份历史回滚镜像b66与18da，按原政策淘汰旧e6cf标签，数据库和数据卷保留。

## 最终一致性 Review

- [x] AC01～AC05全部通过：两阶段APT配置一致、精确结构守卫、源码未改、维护边界与真实构建均有证据
- [x] 失败构建记录删除没有被误记为空间释放成功；实际通过字节码缓存清理达标，保持原门槛
- [x] T01～T03各自定向／语法验证及已有Compose门禁通过，I01由同一次主仓镜像固化验证完成
- [x] 无运行服务被缓存维护停止，源码、业务文件、成功记录、凭证及数据卷保持；仅原政策淘汰一条旧回滚标签
- [x] 当前范围无未完成任务、Blocking问题或后续义务，Spec保留当前入口契约，Task归档，无提交

结论：通过。SDK旧HTTP下载失败已通过精确转换修复，缓存与空间恢复均使用仓库维护入口；主仓最终证据见`thesis-ledger/docs/archive/tasks/2026-10-07-local-history-library.md`。
