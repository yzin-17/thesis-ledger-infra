# ThesisLedger 三仓契约矩阵

本文记录 thesis-ledger、正式 daily-stock-analysis Fork 与本基础设施仓的最小兼容边界。

| 层 | 约束 | 当前验证 |
| --- | --- | --- |
| 账户 | type=securities|fund|cash、mode=actual|shadow；来源不属于账户 | Server TypeScript + 账户服务回归 |
| 持仓 | 手动保存绝对当前余额；截图为增量草稿；写入 Ledger Adjustment | Server 81 tests |
| 基金估值 | `.OF` 只走 fund-nav；最新与历史净值返回真实 Provider、时间和 freshness；历史序列持久化到 PostgreSQL；不可用不伪造零值 | Contract fixture 与跨仓 smoke 已补充；本机 pytest/FastAPI 依赖待安装 |
| DSA | Data Contract V1 保持 Bearer token 独立；Control Contract V1 使用独立 Control Token；fund-nav/history、Catalog snapshot/delta 和 Provider policy 为兼容扩展 | Contract fixture、Control Contract 原子性/权限测试文件与源码语法检查；运行测试待依赖环境 |
| Desktop | /position-entry；已有账户跳过创建；手动/截图并列；账户管理侧向弹层；独立 `/market-data` 管理页 | Desktop 15 tests + route/UI contract + typecheck/build |
| Mobile | 只读；actual/shadow 范围切换 | Mobile typecheck + 6 tests |

## 发布门禁

1. 先部署 DSA Fork 的 Data/Control Contract 和独立 SQLite 卷，确认 `/api/v1/thesis-ledger/capabilities` 与 Control handshake 通过。
2. 再部署主仓 Prisma migration，并确认 API `/api/v1/accounts`、`/api/v1/portfolio` 与 `/api/v1/market-data` 使用新 schema。
3. 最后运行 `scripts/contract-test.sh`；主仓 facade 与 DSA Contract 都要通过基金最新/历史 NAV、行情、日线、目录和无效 Token 拒绝检查。
4. 发现 capability、schema、Control Token 或 migration 不匹配时停止发布，保留旧镜像和所有数据卷，等待修复。
