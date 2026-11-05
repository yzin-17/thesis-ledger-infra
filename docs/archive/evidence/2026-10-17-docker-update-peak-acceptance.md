# Docker 更新峰值与真实保卷重建验收

日期：2026-10-17。对应 [Spec AC19～AC23](../../specs/2026-09-08-docker-build-space-guard.md) 和 [当前任务](../tasks/docker-build-space-guard.md)。本记录承接[前轮镜像清理](2026-10-17-docker-space-recovery.md)，记录本轮完整重建和恢复结果。

## 根因与修复

运行镜像的最终占用不等于更新所需峰值。实际构建输入中，DSA 包含 Rust 编译工具链、SDK 测试与 wheel 编译、Python 依赖安装、Web 构建和多阶段快照；Server 包含安装、编译及生产依赖部署。旧容器镜像、依赖缓存和临时层在此期间并存。

此前还有两个流程问题：宿主低于20 GiB参考值便清空全部可回收缓存，促使后续反复冷构建；两应用全部完成后才维护缓存，新服务健康后仍保护旧基线，容易使临时占用和历史镜像叠加。近几次成功构建的 history 记录也显示缓存命中接近0；这一记录本身不能单独证明某一次 ENOSPC 的原因。

现已实施：

- 20/18 GiB只作清理参考，不作为应用容量要求；正余量继续，不因参考值清空全部热缓存和基础镜像。
- 每个应用构建完成并保护镜像后，用 `type!=exec.cachemount` 回收普通中间层，再进入下一应用；命名依赖缓存保留。缓存仍按8 GB最大目标、4 GB保留底线和 Docker 18 GiB参考空闲值进行有界维护。
- 全部服务健康后解除旧基线保护，按实际容量逐个退役未引用旧回滚并回收 Desktop 空闲块；显式保护继续有效。
- 实际零余量/ENOSPC自动保卷恢复一次；正式 `UPDATE_SPACE_MODE=compact` 可主动验证同一恢复路径。
- 进程查询权限检查放到取得更新锁和 Docker 变更之前；Codex若遇沙箱限制，按工作区规则自动对正式入口使用批准执行权限，不跳过锁。
- 容器已删除时，再次生成恢复计划也继承已有匿名卷配置；成功后保留挂载配置，清除 `incomplete` 标记。
- 固定 SDK 源按构建脚本摘要保存于被忽略的宿主缓存；复用仍校验固定 revision、Git对象和干净工作树。首次获取在macOS尊重已配置的HTTPS/ALL代理；无显式代理时可沿用系统已启用的本机HTTPS代理，不修改系统设置。

## 正式执行与中断恢复

执行目录为 `/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`；全部 Docker 状态变更通过正式 `scripts/update.sh`，目标始终 all，数据库模式 check。

1. `DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=compact ./scripts/update.sh all`：已保存恢复配置并停止、删除本项目容器，随后因沙箱 `spawnSync ps EPERM` 失败。全部卷保留，没有跳过祖先校验；现已将该权限检查前置。
2. 以批准执行权限运行 `DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=auto ./scripts/update.sh all`：读取原恢复文件和 `incomplete`，自动扩大为all继续；固定SDK源码GitHub直连TLS失败。未重置卷或数据库。
3. 沿用系统本机代理，以批准执行权限执行下列正式入口，**最终退出0**：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
DEV_DATABASE_MODE=check UPDATE_SPACE_MODE=auto ./scripts/update.sh all
```

本轮由显式 compact 开始，再经持久恢复配置跨进程续接，完成两应用冷构建、原数据库结构门禁和全部服务恢复。一次 PyPI `files.pythonhosted.org` 读取超时由原普通构建重试恢复，保留 BuildKit cache，不将网络故障误判为空间不足。历史部分失败记录也是TLS/下载错误，不能概括为ENOSPC。

完整日志位于忽略目录：`.maintenance-backups/compact-update-2026-10-17.log`、`compact-update-resume-2026-10-17.log`、`compact-update-resume-proxy-2026-10-17.log`。未人为制造实际ENOSPC；真实执行的是保卷删除、跨进程恢复和完整重建路径。

## 真实运行与数据核对

- 5个容器全部重新创建并 healthy；Server与Worker使用 `sha256:1d91cb246e789a404b4b8738b2adc6efb00dd50606b645fba6ffe7624d76208a`，DSA使用 `sha256:cc15730b336fa1304262f13354d8ac792e98ae83614dc38664b4f5077aacb188`。PostgreSQL/Redis复用原基础镜像。
- 6个volume名称、每个服务的卷名及目标路径全部一致，包含匿名 `/app/logs`、`/app/reports`。没有删除volume、绑定目录、备份或宿主业务文件。
- PostgreSQL逐表计数：80张表重建前共36638行；重建后仅 `ProviderHealthCheck` 从248变249，其他79张表行数一致，没有出现行数减少。
- DSA SQLite：11张表重建前共221行，重建后每张表行数全部一致。
- 计数属于行数级对比，未对所有字段作逐字节校验。基线和结果保存在 `.maintenance-backups/compact-baseline-2026-10-17.json` 与 `compact-after-2026-10-17.json`。
- 绕过本机系统代理直接访问 `http://127.0.0.1:3000/api/v1/health` 和 `http://127.0.0.1:8000/api/health` 均HTTP 200。开始默认urllib代理请求失败，直接访问验证后通过；未据此修改应用。
- Server/Worker/PostgreSQL等容器最近日志未发现缺表、Prisma P2021/P2022、权限拒绝或FATAL。恢复挂载配置保留，`incomplete` 已清除。

## 实际空间

重建前宿主15.91 GiB；清理旧应用镜像并回收空闲块后约19.8 GiB。构建过程中曾观察到11.44 GiB、Server导出时8.25 GiB，均继续执行。采样不是完整时间序列，不能把8.25 GiB声明为全程精确最低值。

健康后维护的脚本读数：宿主10501 MiB（约10.26 GiB），Docker18433 MiB（约18 GiB）；宿主未达到20 GiB参考值，正式更新仍成功退出0。`docker system df` 最终报告镜像9个、5.173 GB；构建缓存22条、5.908 GB，保留用于后续更新的依赖缓存。没有旧应用回滚镜像残留，额外镜像主要为可复用基础镜像。最终状态保留了依赖缓存，因此不能只拿运行镜像3.75 GB与整个Docker占用作等量比较。

这验证了当前32 GiB Docker虚拟盘及本机实际余量下的完整保卷恢复；没有修改Desktop容量。没有承诺任意宿主剩余空间下都能编译，也没有执行第二次无变更全量构建来扩大验收结论。

## 验证与最终核对

- Node测试48项全部通过，含真实只读Compose合并、容器已删除后继承匿名卷、候选复核、锁与保护。
- 空间编排、生命周期、固定SDK源、保卷恢复、回滚更新20场景、镜像基线11场景、产物复用、两种Dockerfile转换和快更测试全部通过；兼容性检查通过。
- 新增生命周期测试加入CI。SDK源测试使用独立fixture，不依赖CI存在相邻DSA仓库。
- Shell语法、差异卫生与文档一致性核对通过。未修改两应用源码、数据库结构或无关未提交改动；未提交、推送或发布。

当前范围的真实保卷重建和恢复验收完成；实际ENOSPC故障注入、所有业务端到端操作及真实供应商验收不在本轮结论内。

机制参考：[Docker构建缓存与GC](https://docs.docker.com/build/cache/garbage-collection/)、[Buildx prune筛选](https://docs.docker.com/reference/cli/docker/buildx/prune/)、[Docker Desktop空闲块回收](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)。

## 镜像保留与自动恢复复核

用户确认保留有用途的镜像、清理其余镜像后，在 `/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra` 先预览，再执行仓库维护入口：

```bash
rtk proxy node scripts/docker-space-images.mjs all --all-unused \
  --protect sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
  --protect sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
  --protect sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89 \
  --protect sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 \
  --protect sha256:8b26e45c51632fd78131f3bddca76122bebc1dd8376f16dd26f769c7f33121fd \
  --apply
```

预览与应用均退出0，`remove`、`removed`、`skipped` 均为空。剩余9个镜像分别为4个运行镜像、4个构建基础镜像和1个Desktop空间回收工具镜像，没有新的无用镜像。四组 `thesis-ledger-local-*` 标签与官方标签共用相同镜像ID，不重复存储内容。保留可复用依赖缓存，未因其显示为可回收而清空。

维护后独立核对：5个容器全部健康，原6个volumes及命名/匿名卷挂载目标完全一致；Server与DSA健康接口均HTTP 200；恢复挂载文件存在且没有未完成恢复标记。镜像仍为9个、5.173 GB。

源码及本地配置复核确认：默认 `UPDATE_SPACE_MODE=auto`、`REPAIR_BUILD_CACHE_ON_NO_SPACE=true`，`.env`、`.env.example` 和当前Shell均未关闭自动修复。仅低于20/18 GiB参考目标时保留有用途的基础镜像与依赖缓存，继续构建；实际零余量/ENOSPC在正式更新入口内自动执行一次保卷重装并继续构建。恢复失败仍保留卷和恢复文件，不进行无限重装。

同步修正更新说明中残留的“空间不足也不删除镜像、容器”旧表述，并补齐Rust基础镜像别名及刷新示例。本次未修改脚本逻辑，沿用上方已通过的定向测试与真实保卷重建证据，没有重复进行冷构建。
