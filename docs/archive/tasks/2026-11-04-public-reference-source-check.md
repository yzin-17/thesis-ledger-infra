# 公开参考来源采证任务

对应[规格](../../specs/2026-11-04-public-reference-source-check.md)，承接[主仓来源核对](../../../../thesis-ledger/docs/archive/tasks/2026-11-04-astock-public-source-reuse.md)。状态：已完成并归档。见[主仓最终证据](../../../../thesis-ledger/docs/evidence/2026-11-04-astock-public-source-reuse.md)。

- [x] I1 固定公开接口、样本参数、只读行为、独占证据与失败语义的 CLI 及离线检查；5 项离线测试通过。
- [x] I2 宿主固定 CLI 30 次来源采证，含失败与依原件修正后的请求；目标 DSA 另有 1 次申万 TLS 核对，共 31 次资格尝试。产品 API 和客户端读取另留回执，不混入采证计数。
- [x] I3 原 Provider／准入、49 条路由、三仓 HEAD／索引／无关源文件和 19 表业务摘要保全；新 18 条正常策略 API 条件追加后为修订 182、67 条，全数合格。最终只读计划无新增／撤销。产品独立门禁通过后随父项归档，无模型／通知调用和新增费用。

目标按维护入口先 `sync-code.sh all`，其后再完成 `sync-code.sh thesis-ledger`；Desktop 静态构建与生产预览在宿主独立验收；镜像、卷和数据库结构不变。旧通用路由脚本未修改，原离线测试按相同输入复用；新增采证入口的来源链衔接均校验父响应身份和摘要，不接受任意 URL／凭据／代码。
