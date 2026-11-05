# Docker 自动清理与保卷恢复验收记录

本文件记录前轮清理时的状态；后续真实保卷删除、跨进程续接和冷构建已完成，见[更新峰值与实际恢复验收](2026-10-17-docker-update-peak-acceptance.md)。下文“未实测”仅表示前轮检查点。

对应 [Spec AC15～AC18](../../specs/2026-09-08-docker-build-space-guard.md) 与 [当前 Task](../tasks/docker-build-space-guard.md)。日期：2026-10-17。

## 来源与授权

20 GiB 来自 `scripts/build-space.sh` 的 `BUILD_HOST_MIN_FREE_SPACE` 默认值及旧版构建空间 Spec，Docker 对应默认值为18 GiB；没有发现应用运行或正式研究镜像自身声明必须空闲20 GiB的要求。本轮用户明确要求自动清理 Docker，必要时保留 volumes 重装。因此将容量值改为清理参考目标，更新工作区规则、infra 规则、脚本、README 和更新指南；旧 Spec 中的硬门槛与容器保护范围由当前 AC15～AC18 替代。

主仓原有大量未提交改动保留；infra 起始工作树干净。未提交、推送或发布，未修改应用源码和数据库结构。

## 实现与验证边界

- 低于参考目标时按原流程清理，再扩展为全部未引用镜像清理；清理后已知正余量允许继续。未知空间、并发构建、锁冲突和清理失败仍停止。
- 全部未引用模式逐标签、逐次重读库存，非强制删除；保留容器引用、显式保护、探针、显式复用及本轮已构建镜像。
- 实际 ENOSPC 或整备后零余量触发一次本开发项目保卷恢复。先记录实际挂载并持久保存恢复 override，再 stop/down，不使用卷删除参数；核对原有全部卷后清缓存和镜像，按 all 重建，经原数据库门禁和健康检查启动。已构建产物继续复用。
- 挂载配置位于 `.maintenance-backups/docker-space-recovery/compose.json`，后续正式更新自动沿用。恢复失败保留 `incomplete`，下次正式更新自动按 all 继续；恢复成功后删除该标记。
- 真实 Docker 仅执行闲置镜像清理及只读检查，**没有触发实际 ENOSPC、容器停机重装、冷构建和重新部署**。完整恢复副作用顺序由替身验证；实际挂载恢复配置通过真实只读 Compose 合并验证，不能等同于实际停机重装验收。

## 实际清理

执行目录：`/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra`。

维护入口（先以相同参数不带 `--apply` 预览，再执行；退出0）：

```bash
node scripts/docker-space-images.mjs all --all-unused --apply \
  --protect sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
```

目标为当前本地 `desktop-linux` daemon 的未引用镜像，复用更新锁及活动构建检查；额外保护 Node 24 空间探针。删除8个唯一镜像的11个标签/引用，跳过0：

| 类别 | 删除的镜像ID前缀 | 内容 |
| --- | --- | --- |
| Server 旧回滚 | `6d709bc37663`、`71621979c96c` | 两个旧版本 |
| DSA 旧回滚 | `3429d2609376`、`d9cdba416f1f` | 两个旧版本 |
| 可重拉构建镜像 | `0a310eeecf4e`、`2cf067cfed83`、`cf9dd0ec73e7` | Python 3.11、Node 20、Rust 1.94.1，及各自本地别名 |
| 临时工具镜像 | `8b26e45c5163` | Desktop 空闲块回收工具，可按需重新拉取 |

`docker system df` 镜像从13个、10.6 GB降至5个、3.75 GB，报告的镜像占用减少约6.85 GB。构建缓存前后均为0。宿主开始读数约2.8 GiB空闲，清理后一次测得15.14 GiB；宿主空间会随其他进程及 Desktop 后台回收变化，不把该差值全部归因于镜像逻辑大小。

清理前后按容器ID、镜像ID、健康和卷挂载比较：5个容器完全一致且全部 healthy；6个 volume 名称及挂载全部一致，包含 DSA 的匿名 `/app/logs` 与 `/app/reports`。剩余镜像：

| 镜像 | ID前缀 | 用途 |
| --- | --- | --- |
| `thesis-ledger:dev` | `2f4419bb125c` | Server 与 Worker 使用 |
| `daily-stock-analysis:thesisledger-dev` | `03913531fa82` | DSA 使用 |
| `postgres:17-alpine` | `b0f9560a2de0` | PostgreSQL 使用 |
| `redis:8-alpine` | `3811787313eb` | Redis 使用 |
| `node:24-alpine` 与本地别名 | `ebfe2f904627` | 同一镜像，保留作空间探针 |

当前无其他应优先清理的未引用镜像；没有为释放空间中断运行中的服务。

## 验证证据

- `DOCKER_READONLY_ACCEPTANCE=true node --test scripts/docker-space-images.test.mjs scripts/docker-reinstall-plan.test.mjs scripts/rollback-image-policy.test.mjs`：47项全部通过。包含真实当前容器挂载清单生成、Compose 配置合并，命名/匿名卷重新接回及绑定目录保持；无容器创建或删除。
- `bash scripts/build-space.test.sh`：通过。覆盖完整更新在参考值以下继续、零余量先恢复、未知值拒绝、禁用自动修复、全局未引用清理、保护传递、并发、普通错误后再 ENOSPC、恢复失败不再构建、恢复后再次 ENOSPC 停止。
- `bash scripts/reinstall-preserving-volumes.test.sh`：通过。覆盖保卷计划先于停止、stop/down/核卷/清理/重建顺序、恢复文件持久保留、锁、全部目标与各阶段失败停止。
- `bash scripts/rollback-image-update.test.sh`：20场景通过；`bash scripts/retain-rollback-images.test.sh`：11场景通过；`bash scripts/reuse-dsa-image.test.sh`：通过。
- `bash scripts/longbridge-build-source.test.sh`、`bash scripts/update-dsa-dockerfile.test.sh`、`bash scripts/update-server-dockerfile.test.sh`：通过；`bash scripts/sync-code.test.sh`：通过。
- `node scripts/check-compatibility.mjs`：通过。
- Shell 语法与 `git diff --check`：通过；新恢复测试加入 `.github/workflows/compatibility.yml`。

## 最终核对

实现、局部回归、真实闲置镜像清理和真实只读挂载合并完成。真实 ENOSPC 后的完整保卷重装尚未实测，当前 Task 保持该边界，不以 healthy 状态替代此分支验收。没有新增 TODO、没有归档当前任务。

卷删除参数与默认行为核对依据：[Docker Compose down 官方文档](https://docs.docker.com/reference/cli/docker/compose/down/)、[Docker volumes 官方文档](https://docs.docker.com/engine/storage/volumes/)。
