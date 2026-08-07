# ThesisLedger 三仓契约矩阵

本文记录 thesis-ledger、正式 daily-stock-analysis Fork 与本基础设施仓的最小兼容边界。

| 层 | 约束 | 当前验证 |
| --- | --- | --- |
| 账户 | type=securities|fund|cash、mode=actual|shadow；来源不属于账户 | Server TypeScript + 账户服务回归 |
| 持仓 | 手动保存绝对当前余额；截图为增量草稿；写入 Ledger Adjustment | Server 72 tests |
| 基金估值 | .OF 只走 fund-nav；返回 unitNav 与 freshness；不可用不伪造零值 | DSA fixture Contract test 文件已加入；本机 pytest/FastAPI 依赖待安装 |
| DSA | Contract V1 保持 Bearer token 独立，fund-nav additive capability | tests/test_thesis_ledger_contract.py；源码 compile 通过 |
| Desktop | /position-entry；已有账户跳过创建；手动/截图并列；账户管理侧向弹层 | Desktop 8 tests + route/UI contract + typecheck/build |
| Mobile | 只读；actual/shadow 范围切换 | Mobile typecheck + 6 tests |

## 发布门禁

1. 先部署主仓 Prisma migration，并确认 API /api/v1/accounts 与 /api/v1/portfolio 使用新 schema。
2. 再部署 DSA Fork，确认 /api/v1/thesis-ledger/capabilities 返回 fund-nav.assetSuffix=.OF。
3. 最后运行 scripts/contract-test.sh；主仓 facade 与 DSA Contract 都要通过基金 NAV、行情、日线、指标和筹码检查。
4. 发现 capability、schema 或 migration 不匹配时停止发布，保留旧镜像和数据库卷，等待修复。
