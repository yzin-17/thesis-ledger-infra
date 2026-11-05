# 手机通知单次验收维护入口

日期：2026-11-03。状态：维护入口实施与本轮验收完成。对应[任务](../archive/tasks/2026-11-03-mobile-notification-acceptance.md)，产品范围由[主仓规格](../../../thesis-ledger/docs/specs/2026-11-03-mobile-notification-provider-live-acceptance.md)拥有；统一证据见[验收与最终复核](../../../thesis-ledger/docs/tasks/evidence/2026-11-03-mobile-notification-provider-live-acceptance.md)。本轮两次许可已用尽，入口保留有界维护合同。

## 输入和执行边界

提供 `scripts/mobile-notification-acceptance.mjs` 的预检、单平台显式投递、检查和精确清理。目标仅为本地 `desktop-linux` 的 `thesis-ledger-dev` Server、现有主库和现有加密凭据入口。宿主仅解析被选定的 `~/.zshrc:FEISHU_HOOK` 字面量，复用主仓已有解析函数；凭证通过标准输入进入目标进程，不写入命令参数、文件或输出。

固定授权为两个平台各一次，总外部请求最多两次。持久台账与互斥锁在首次发送前占用许可；未知结果保留占用。预检、检查与清理不发送通知，重复投递同一平台必须拒绝。每个目标进程的出站观察器再限制一次，只允许选定 Webhook 的原始 POST，返回实际响应并保存脱敏回执，不改变传输行为。

临时 Provider 为 notification 类型且 enabled=false，正常路由保持不变。运行器直接使用目标镜像／快更中的现有服务类，创建本轮命名空间的真实 `sending` 手动投递记录，通过现有 `deliver(..., 1)` 完成单次发送及健康记录。自动 dispatcher 不领取该执行中记录。成功、失败和中断按真实状态留存，不能增加虚构尝试或删除失败。

## 保护与清理

运行前核对精确容器／数据库／现有路由及源码身份。只新增本轮配置、投递和健康审计；清理只匹配本轮名称及 settings 中的验收标识、停用状态和凭据身份，不能删除其他配置或历史通知。不得启动额外应用、调度器、Docker 容器、模型或来源探针，不修改正常通知配置。

定向测试覆盖参数拒绝、重复／超限许可、失败与未知不重发、目标身份、凭证脱敏及所有权清理；通过后才执行真实维护入口。主仓分别拥有实际设备消费、收件确认和总任务收口。
