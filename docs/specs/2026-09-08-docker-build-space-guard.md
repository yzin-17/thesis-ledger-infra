# Docker 本地构建空间保护 Spec

## 背景与问题

本地 Docker Desktop 虚拟磁盘容量为 32GB。一次故障前，BuildKit 累积了 209 条缓存记录并占用 27.6GB；镜像、容器和数据卷另占约 4.8GB。ThesisLedger 在 `pnpm deploy` 下载和解包生产依赖时因此触发 `ERR_PNPM_ENOSPC`，而更新脚本只在构建失败后识别空间不足，且默认要求调用方再次显式授权清理，导致本次更新直接失败。

BuildKit 的缓存未命中只会产生新的缓存分支，不会立即删除旧分支。当前 builder 的 GC 策略还会保留较大的近期缓存，因此更新脚本需要在自身执行边界内主动控制缓存规模与冷构建峰值。

## 目标

- 普通本地更新开始前为冷构建预留足够空间，避免旧缓存挤占构建临时空间。
- 构建成功后淘汰较旧的缓存分支，防止缓存长期回到接近虚拟磁盘容量的水平。
- 降低同时冷构建 DSA 与 ThesisLedger 时的磁盘峰值。
- 让 ThesisLedger 的 `pnpm install` 与 `pnpm deploy` 复用同一 BuildKit pnpm store。
- 空间不足时仅清理未使用的 BuildKit 缓存并自动重试一次。

## 非目标

- 不修改共享 DSA、ThesisLedger Dockerfile 或 Compose 文件的生产行为。
- 不修改 Docker Desktop 的全局磁盘容量或 GC 配置。
- 不删除镜像、容器、网络或任何数据卷。
- 不保证在单个串行冷构建本身超过 Docker 虚拟磁盘可用容量时仍能成功。
- 不通过解析 BuildKit 文本日志判断每一个缓存步骤是否命中。

## 现状与约束

- `update.sh` 通过临时 Dockerfile 和 Compose override 注入本地镜像别名、国内软件源与命名 cache mount，退出时删除临时文件。
- 修改前的脚本默认 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false`，仅在构建已经失败后执行一次 `docker builder prune --min-free-space`。
- `all` 目标目前将两个服务交给一次 Compose build，Compose 可并行执行构建。
- 临时 ThesisLedger Dockerfile 只在 `pnpm install` 使用命名 pnpm store；`pnpm deploy --legacy` 未挂载同一个 store。
- 当前 Docker/Buildx 支持 `max-used-space`、`min-free-space` 与 `reserved-space`。

## 设计方案

### 有界缓存维护

默认启用 BuildKit 缓存空间维护，并保留 `REPAIR_BUILD_CACHE_ON_NO_SPACE=false` 作为显式关闭入口。默认阈值为：

- 最大缓存占用：8GB；
- 目标最小空闲空间：18GB；
- 缓存保留底线：4GB。

应用构建前执行一次有界维护。若维护命令失败，则在开始应用构建前退出，避免在无法确认空间状态时继续消耗磁盘。

应用构建成功后再次执行相同的有界维护，以 LRU 顺序优先淘汰旧分支并保留刚使用的缓存。构建后维护失败只输出警告，不阻止已成功构建的镜像继续启动。

上述阈值是 BuildKit GC 目标而非 `docker system df` 总数的硬上限。正在使用的记录不能删除；与最终镜像共享的层即使删除缓存元数据也不会释放镜像仍引用的实际层；缓存保留底线还会限制本轮 GC 能继续释放的空间。验收时需同时记录 Private、Reclaimable 与 Docker 磁盘实际空闲空间，不能只用 Build Cache 总数判断维护是否生效。

### 构建并发

`all` 目标逐个 service 调用 Compose build，不把 DSA 与 ThesisLedger 同时提交给 BuildKit。Compose 的全局并发参数无法阻止同一次多目标 build 在 BuildKit 内并行，因此不能用它代替逐服务调用。单目标行为保持一致。

### pnpm store 复用

临时 ThesisLedger Dockerfile 为 `pnpm deploy --prod ... --legacy` 注入与 `pnpm install` 相同的命名 cache mount。共享 ThesisLedger Dockerfile 保持原状。

### 空间不足恢复

若构建日志包含 `no space left on device`、`not enough disk space` 或 `insufficient disk space`：

1. 默认对当前 builder 的全部未使用 BuildKit cache 执行一次清理；
2. 从应用构建起点重试一次；
3. 第二次失败时保留现场并返回失败，不进行第三次构建，也不触碰其他 Docker 资源。

普通构建错误仍保留缓存并重试一次。

## 对外行为或接口变化

- `REPAIR_BUILD_CACHE_ON_NO_SPACE` 默认值由 `false` 改为 `true`，并同时控制构建前后有界维护与 ENOSPC 自动恢复；设置为 `false` 可关闭所有自动缓存清理。
- 新增 `BUILD_CACHE_MAX_USED_SPACE`，默认 `8gb`。
- `BUILD_CACHE_MIN_FREE_SPACE` 默认值由 `8gb` 改为 `18gb`。
- 新增 `BUILD_CACHE_RESERVED_SPACE`，默认 `4gb`。

## 数据、状态或兼容性影响

- 被清理的 BuildKit 缓存不可恢复，后续构建可能重新下载或编译依赖。
- 镜像、运行中或停止的容器、网络及数据卷不受缓存维护影响。
- 本地临时构建定义仍在脚本退出时删除，仓库中的共享 Dockerfile 与 Compose 配置不包含本地缓存策略。
- 若本地 Docker/Buildx 版本不支持空间阈值参数，构建前维护会明确失败，不会静默继续。

## 测试策略

### 关键可观察行为

- 默认成功更新在构建前后各执行一次带三个空间阈值的 Buildx prune。
- 显式关闭缓存维护时不执行任何 prune。
- `all` 构建对 DSA 与 ThesisLedger 分别执行一次 Compose build，不出现包含两个 service 的单次 build 调用。
- 临时 ThesisLedger Dockerfile 的 install 与 deploy 均使用同一个 pnpm store ID。
- 首次 ENOSPC 会执行一次全量未使用缓存清理并重试；普通错误不执行全量清理。
- 共享 Dockerfile 与 Compose 文件保持原样。

### 优先测试层级

1. Shell 语法检查。
2. 静态核对缓存维护、逐服务构建、pnpm store 复用和重试分支。
3. 在清空 BuildKit cache 后执行一次真实本地更新，并核对构建结果与缓存/磁盘占用。

### 可复用的现有测试入口

- `bash -n scripts/update.sh`
- `git diff --check`

### 需要新增的测试入口

无需新增专用测试脚本。该本地运维脚本以 Shell 语法检查、静态契约核对和真实更新验证为主。

### 关键边界与回归场景

- 非法预检参数不得触发 prune、pull、build 或 up。
- 基础镜像准备失败不得开始应用构建。
- 启动或健康检查失败不得额外清理 BuildKit cache。
- 第二次构建失败不得进行第三次重试。
- 显式关闭自动缓存管理时继续保持原有“不自动删除缓存”行为。

## 风险与备选方案

- 8GB 上限可能淘汰较旧分支的依赖缓存，使分支切换后的首次构建变慢；相较 32GB 虚拟磁盘发生 ENOSPC，该取舍可接受。
- Build Cache 总数可能因活跃记录或镜像共享层高于 8GB；该差异不等于同等规模的额外物理占用，也不应通过删除镜像或数据卷强行满足阈值。
- 当前验证策略不覆盖普通失败、ENOSPC 修复和二次失败等负向分支的自动回归；后续修改这些分支时需要静态复核，必要时在隔离环境中注入失败进行验证。
- `--all` 允许清理内部/frontend 缓存；空间紧张后的首次构建可能重新解析 frontend。使用本地临时 Dockerfile移除 DSA 的外部 frontend 声明，可减少该影响。
- 若真实串行冷构建仍使用超过清空缓存后的约 24GB 可用空间，需要提高 Docker Desktop 虚拟磁盘容量，脚本无法通过清缓存突破物理上限。

## 未决问题

### Blocking

无。

### Non-blocking

无。

## 验收标准

- AC1：默认更新在构建前后执行仅针对 BuildKit cache 的有界维护，默认最大缓存 8GB、最小空闲空间 18GB、缓存保留底线 4GB，且可显式关闭。
- AC2：`all` 目标逐个 service 调用 Compose build，不将 DSA 与 ThesisLedger 同时提交给 BuildKit，以降低冷构建峰值。
- AC3：本地临时 ThesisLedger Dockerfile 的 `pnpm install` 与 `pnpm deploy` 复用同一命名 pnpm store，共享 Dockerfile 保持不变。
- AC4：首次 ENOSPC 默认全量清理当前 builder 的未使用 BuildKit cache 并重试一次，普通错误不执行全量清理，第二次失败不再重试。
- AC5：更新流程不会因缓存维护而删除镜像、容器、网络或数据卷，相关文档准确描述默认行为与可配置参数。
- AC6：Shell 语法检查、静态契约核对和一次真实冷缓存更新均提供明确验证结果；若运行时阶段因独立环境问题失败，应分别记录构建阶段结果与运行时阻塞。
