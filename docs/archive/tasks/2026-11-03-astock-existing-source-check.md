# 既有 A 股来源采证入口任务

对应[规格](../../../../daily-stock-analysis/docs/specs/2026-11-03-astock-existing-source-check.md)，父项为[主仓 E1](../../../../thesis-ledger/docs/archive/tasks/2026-11-03-astock-existing-sources-delivery.md)。状态：已完成并归档。

- [x] I1 固定来源、样本类型、目标身份、只读配置与互斥锁；保护和输出契约明确。
- [x] I2 CLI／运行器和离线验证通过；不得将一次性任意命令包装为 Docker 维护入口。
- [x] I3 按主仓各叶执行合格样本采证，43 次 HTTP 尝试及 1 个 SDK 会话／查询保留真实结果、错误与协议修正，不写入正常准入。
- [x] I4 最终复核源码、权限、计数、证据与保护一致；合格数据经主仓／DSA 实际合同及双端消费验收，父项结案。
- [x] I5 合格资料路由追加。只读计划、Server 期望修订条件、并发拒绝、创建归属及 Provider／准入保护通过；原 20 条保留，最终新增 29 条均有效，修订 181 共 49 条。撤销 EPS／行业排名只作用于本轮创建且未变的精确路由，不自动启用来源。

## 最终结果

Node 两组共 5 项、Python 两组共 7 项离线测试通过。最终只读计划无新增／撤销；Provider／准入摘要不变。三服务仅通过维护的 `sync-code.sh all` 更新代码，镜像、挂载及外部卷保持；无数据库结构变更。

主仓[验收证据](../../../../thesis-ledger/docs/evidence/2026-11-03-astock-existing-sources-delivery.md)保存检查命令、输入、调用原件、29 类矩阵及三仓源代码／索引与业务保护结果。镜像更新、正式发布、外部 CI 不计本轮结论；无本仓遗留叶。
