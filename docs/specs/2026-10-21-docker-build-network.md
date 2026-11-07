# Docker 构建网络配置

任务标识：`docker-build-network`。对应[实施任务](../archive/tasks/2026-10-21-docker-build-network.md)。

## 问题与范围

本地正式更新先遇到 PyPI TLS 连接中断；网络恢复后 DSA 构建通过，Server 的 Alpine HTTPS 索引仍失败。宿主与运行容器的访问结果不能替代 BuildKit 中的真实连接结果。正式入口需允许显式提供构建代理，继续使用已有 Compose、Bake、锁、缓存和数据门禁。

本增量仅修改 infra 的构建参数透传及验证，不改依赖版本、共享 Dockerfile、全局 Docker/系统代理或业务 Provider 配置。

## 验收标准

- **AC-NET-01**：`update.sh` 可选接受 Shell 环境参数 `BUILD_HTTP_PROXY`、`BUILD_HTTPS_PROXY`、`BUILD_NO_PROXY`，未配置时维持原构建参数；参数作为单个引用参数传给 Bake 的标准代理 build args，各构建阶段可用，不写入运行时 ENV。
- **AC-NET-02**：HTTP/HTTPS 代理只允许非空白的 `http://` 或 `https://` URL，排除换行；NO_PROXY 排除换行。非法参数在正式构建/清理前失败，不回显代理内容。
- **AC-NET-03**：保留 HTTPS 证书校验与原依赖来源；不通过 HTTP 镜像、trusted-host 或关闭校验解决 TLS 失败。代理采用 Docker 官方预定义参数语义，不在 Dockerfile 引用或输出代理值。
- **AC-NET-04**：首次完成的 DSA 精确镜像可通过既有 `REUSE_DSA_IMAGE_ID` 续接 all 更新；保留源码/兼容校验、Server 构建、默认数据库 check、启动与独立运行态验收。
- **AC-NET-05**：正式更新前形成数据库/文件备份及逻辑指纹、卷挂载基线；更新后核对原记录、配置、研究产物及六个卷，确认新代码在 Server/Worker/DSA 中运行。合成账号权限落盘与两个独立进程恢复在目标 `/tmp` 验证，禁止出站请求并清理临时目录。

## 依据

[Docker 代理构建参数](https://docs.docker.com/build/building/variables/#proxy-arguments)说明无需在 Dockerfile 声明即可传入代理，默认从 history/cache 排除；[Bake args](https://docs.docker.com/build/bake/reference/#targetargs)负责目标参数。业务账号权限验收仍以主仓 TAP 规格与任务为准。


## Alpine下载故障的可选恢复参数（2026-11-06）

`BUILD_ALPINE_MIRROR` 仅用于ThesisLedger本轮临时构建层。默认空值保持原Dockerfile逐字输入；有值时仅在既有 `apk add --no-cache g++ make python3` 前改写仓库基址，保留版本路径、包选择及签名校验，不写源Dockerfile或运行层。值仅允许无凭据/查询参数的HTTPS主机及 `/alpine` 路径，非法值在构建前拒绝。官方入口及全部数据库/空间/并发门禁保持。`build-compose-service.test.sh` 覆盖默认保真、受控改写、签名保持、非法输入和重置；不为替换下载地址新增更新入口。
