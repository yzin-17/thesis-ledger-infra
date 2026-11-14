# Vitest 测试验收

日期：2026-11-11。状态：已通过。[任务](../tasks/2026-11-11-vitest-testing.md)。

## 实际交付

项目已安装 Vitest `5.1.0`，作为唯一开发依赖，使用 pnpm `11.9.0` 与 Node.js `24.22.2`。`package.json`、`pnpm-lock.yaml`、`.npmrc` 和 `vitest.config.mjs` 定义安装与测试接口；依赖通过 `https://registry.npmmirror.com` 获取，`pnpm install --frozen-lockfile` 实际执行成功。

infra 的 26 个测试文件直接导入 Vitest，7 处测试及共享 fixture 清理注册改用 `onTestFinished`。保留原有 86 个测试场景，新增 1 个运行时边界场景；删除 14 个测试 Shell 文件。7 个生产 Shell 入口保持，生产依赖仍为空。

DSA 的 SDK 测试 Shell 文件一并删除，其 CI 将该文件纳入已有的直接 Node 测试命令；业务项目框架和测试实现保持。当前规则、指南、CI 及跨仓规格中的调用引用同步更新，历史验收命令保留原文。

## 检查记录

以下 infra 命令均在 `/Users/yzin/code/thesis-ledger-workspace/thesis-ledger-infra` 执行，使用上述实际 Node 与 pnpm 的安装路径。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest --version` | 实际输出 `vitest/5.1.0`、`node-v24.22.2` |
| `pnpm install --frozen-lockfile` | 退出 0，锁文件一致 |
| `pnpm test scripts/runtime.test.mjs scripts/check-runtime.test.mjs scripts/sync-code.test.mjs scripts/preserve-database.test.mjs` | 首轮定向 15 通过，覆盖进程、锁、失败、快更和数据库保护 |
| `pnpm test scripts/check-runtime.test.mjs` | 新增门禁后 2 通过 |
| `pnpm test` | 26 个文件通过，86 项通过、1 项默认跳过，共收集 87 项 |
| `pnpm test:docker-readonly` | 5 项通过，含默认跳过的真实 Docker 配置与挂载合并场景；没有 Docker 状态变更 |
| `pnpm check` | 运行时、所有权/依赖边界和兼容门禁全部通过 |
| `pnpm test:watch --help` | CLI 成功识别监听参数；未留下监听进程 |
| `pnpm test __missing_contract__.test.mjs` | 受控空筛选退出 1，确认无法通过空收集制造成功 |

从 DSA 仓库运行 `node --test scripts/prepare-local-sdk-source.test.mjs`，7 项通过；`node --test scripts/deployment/sync-code.entry.test.mjs scripts/deployment/runtime-recovery.entry.test.mjs`，15 项通过；应用的 `tests/test_ci_workflow_contract.py`，3 项通过。SDK 测试、参数、固定版本及维护锁调用保持有效。

两仓修改的 CI YAML 可解析；三仓 `git diff --check` 通过。检查确认 infra 的测试直接使用 Vitest、没有残留测试 Shell 文件；三仓没有同类 Node 测试薄包装。依赖、缓存与报告目录均由 `.gitignore` 排除。

## 验收边界与结论

AC1～AC4 通过。所有原测试场景保留，新增测试只约束当前测试入口；清理钩子、条件跳过、异步进程和错误断言经 Vitest 实际执行。CI 使用项目包管理器与锁文件安装，测试调用统一为 `pnpm test`。

本轮未更改应用镜像输入、数据库结构或部署编排，未重复构建镜像或执行部署；先前的[保留数据更新与快更证据](2026-11-11-node-orchestration.md)继续适用于原输入。未执行 Provider 实读、模型调用、清库、Git 提交或推送。远程 CI 未执行，已验证其配置与对应本地检查。
