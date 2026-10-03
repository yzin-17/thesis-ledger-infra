#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"
local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/server-dockerfile-contract.XXXXXX")"
trap 'rm -rf "$local_build_dir"' EXIT

# 仅提取纯 Dockerfile 变换函数，测试不调用 Docker 或部署入口。
awk '
  /^(require_exact_line|require_line_pattern|create_local_thesis_ledger_dockerfile)\(\)/ { capture = 1 }
  capture { print }
  capture && /^}/ { capture = 0 }
' "$script_dir/update.sh" > "$local_build_dir/functions.sh"
source "$local_build_dir/functions.sh"
create_local_thesis_ledger_dockerfile
output="$local_build_dir/thesis-ledger.Dockerfile"
grep -Fqx '    pnpm --filter thesis-ledger --filter @thesis-ledger/server... install --frozen-lockfile' "$output"
grep -Fqx '    pnpm_config_registry=https://registry.npmmirror.com \' "$output"
grep -Fqx 'RUN pnpm --filter @thesis-ledger/server... build' "$output"
grep -Fqx '    pnpm --filter @thesis-ledger/server deploy --prod /tmp/server-runtime --legacy' "$output"
if grep -Eq '^\s*(RUN )?pnpm install ' "$output"; then
  printf 'Server 临时 Dockerfile 仍存在未限定 workspace 的安装。\n' >&2
  exit 1
fi
printf 'Server Dockerfile 过滤安装、缓存、构建及运行时部署合同通过。\n'
