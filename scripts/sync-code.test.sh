#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_script="$script_dir/sync-code.sh"

bash -n "$target_script"

help_output="$(bash "$target_script" --help)"
grep -Fq 'sync-code.sh [all|dsa|thesis-ledger]' <<<"$help_output"
grep -Fq '不构建、拉取或修改镜像' <<<"$help_output"
grep -Fq '容器重建后，本次同步会消失' <<<"$help_output"

invalid_output_file="$(mktemp "${TMPDIR:-/tmp}/sync-code-invalid.XXXXXX")"
trap 'rm -f "$invalid_output_file"' EXIT
if bash "$target_script" unsupported >"$invalid_output_file" 2>&1; then
  printf '非法目标不应成功。\n' >&2
  exit 1
fi
grep -Fq '不支持的更新目标: unsupported' "$invalid_output_file"

if grep -En '(^|[[:space:]])docker[[:space:]]+(build|pull|tag|commit|push|rmi)([[:space:]]|$)' "$target_script"; then
  printf '仅代码更新脚本不得包含镜像变更命令。\n' >&2
  exit 1
fi
if grep -En 'docker[[:space:]]+(system|builder|buildx)[[:space:]]+prune|compose[^\n]*(down|build)' "$target_script"; then
  printf '仅代码更新脚本不得清理 Docker 资源或执行 Compose build/down。\n' >&2
  exit 1
fi

grep -Fq 'server-package.json' "$target_script"
grep -Fq 'Prisma Schema、migration 或 raw-owned inventory 与当前容器不一致' "$target_script"
grep -Fq 'dsa-requirements.txt' "$script_dir/sync-code-dsa.sh"
grep -Fq 'up -d --no-build --no-deps --pull never --force-recreate' "$target_script"
grep -Fq '镜像保持不变' "$target_script"
grep -Fq 'selected_services=(dsa thesis-ledger backtest-worker)' "$target_script"
grep -Fq 'selected_services=(thesis-ledger backtest-worker)' "$target_script"

printf 'Docker 仅代码更新契约测试通过。\n'
