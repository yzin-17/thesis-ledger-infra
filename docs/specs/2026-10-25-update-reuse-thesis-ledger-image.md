# 正式更新复用已验 ThesisLedger 镜像

对应任务：[实施与验收](../tasks/2026-10-25-update-reuse-thesis-ledger-image.md)。

## 契约

为已完成构建、已核对运行模块的镜像执行配置恢复和容器重建时，允许在正式 `update.sh thesis-ledger` 中显式提供 `REUSE_THESIS_LEDGER_IMAGE_ID`。此模式保留所选不可变镜像，不将当前宿主源码重新构建或同步进去，不能当作更新宿主新源码的证据。默认路径继续构建。

- RI01：参数必须为完整SHA256；仅接受最小 `thesis-ledger` 目标。当前开发标签必须指向该ID，镜像的Compose项目／服务、工作目录、运行用户与Server命令必须匹配现有本开发服务。入口与跳过构建前各核验一次，漂移／不匹配停止。
- RI02：复用仅跳过Server重复构建，保留锁、空间、保卷、镜像保护、数据库结构默认check、启动与健康门禁。默认构建和既有DSA复用语义保持。
- RI03：复用模式用同一镜像、`--force-recreate --no-deps` 仅重建Server和Worker，不重建或停止Postgres／Redis／DSA，不删除卷或私有trace目录。当前配置由原Compose入口解析。
- RI04：局部替身验证默认／复用、非法ID、错配／漂移拒绝和门禁顺序；真实配置关闭与trace反读由主仓G3-D29验收，模型预算仍由该任务单独约束。
