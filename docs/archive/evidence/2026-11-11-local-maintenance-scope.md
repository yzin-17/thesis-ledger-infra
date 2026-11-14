# 本地维护能力收敛验证

日期：2026-11-11。[任务](../tasks/2026-11-11-local-maintenance-scope.md)，[现行合同](../../specs/2026-11-11-local-maintenance-scope.md)。

## 变更范围

删除 Docker Desktop 引擎恢复命令及专属测试；删除历史镜像数量、创建时间排序和回退标签维护实现，以及 update 与空间整备中的调用。锁归属、本地 context、活动构建与完整镜像 ID 保护独立维护于 docker-maintenance-lock.mjs。显式保护配置改用 BUILD_PROTECTED_IMAGES，仅接受完整 SHA256 ID；DSA 快照自动传入其镜像 ID。

普通镜像清理保留所有其他带标签镜像；all-unused 继续用于显式空间维护与保卷恢复，执行前逐项重查容器引用及候选身份。未删除实际镜像、历史标签、容器或卷。Docker Desktop 的正常启动、状态和空闲块回收继续保留。

生产脚本统计只包含 scripts/ 下非测试的 .mjs 和 .sh：上一检查点3664行，本轮3052行，减少612行。测试和说明不计入该口径。

## 检查结果

| 输入与命令 | 结果 |
| --- | --- |
| node --test scripts/docker-space-images.test.mjs scripts/docker-maintenance-lock.test.mjs | 19项通过，覆盖引用、任意数量旧标签保留、all-unused、状态漂移、完整 ID、祖先 PID、锁释放与远端拒绝 |
| node --test scripts/*.test.mjs | 77项：76通过，0失败，1项真实只读验收默认跳过 |
| bash 执行 scripts/*.test.sh 的全部15个文件 | 全部通过，包含空间整备、更新失败停止、保卷重装、镜像复用、快更和 Compose 契约 |
| DOCKER_READONLY_ACCEPTANCE=true node --test scripts/docker-reinstall-plan.test.mjs | 5项通过，显式补验默认跳过的真实只读卷映射合并 |
| node scripts/check-boundaries.mjs | 通过 |
| node scripts/check-compatibility.mjs | 通过，V3 数据与控制契约 |
| 兼容 CI 的 YAML 解析、git diff --check | 通过 |
| 当前源码、CI 和非归档文档的旧配置及入口扫描 | 零引用；历史记录保持原内容 |
| infra 全部 Markdown 本地文件链接检查 | 无失效路径；迁移规格的跨仓链接同步调整 |

Node 使用本机24.22.2。Context Mode 的精简 PATH 缺少 docker 与 rg，四个 Shell 检查初次无法执行；在宿主完整 PATH 下重跑这四项后全部通过，其他11项原检查通过。测试没有因此降低断言或跳过分支。

## 只读运行核对

开始与结束的五个容器 ID 一致，结束时全部 healthy：

| 服务 | 容器 ID | 结束时镜像 |
| --- | --- | --- |
| Server | 663b7ca1cc38 | sha256:c24e1b1906cf4302cfe3c7bfdba417876dc620f45940957475c023398edb9a36 |
| Worker | 2765b9538c1f | sha256:c24e1b1906cf4302cfe3c7bfdba417876dc620f45940957475c023398edb9a36 |
| DSA | 89f477853e1e | sha256:1ec1f963ebaaafb59bfa8b4fb21bba484fdde6081f172b5c508f959d68c18b4e |
| PostgreSQL | a92d4445d11e | sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b |
| Redis | 8c070714b51c | sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537 |

共享环境中 DSA 的 uptime 在两次读取间发生变化，不能据此宣称整个工作区期间无人重启。该容器身份未变；本任务执行记录没有真实状态变更命令。

本轮仅改变宿主维护脚本及文档，应用源码、运行时依赖、数据库结构和 Dockerfile 均未改变，因此不重建生产镜像，也不重复前一轮已通过的正式 update。受控测试证明维护分支行为，真实只读检查证明配置可合并和当前健康状态，不作为真实故障注入或重装执行的证据。
