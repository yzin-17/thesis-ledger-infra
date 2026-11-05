#!/usr/bin/env bash
set -Eeuo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/update-lock.sh"
trap release_build_space_lock EXIT
if (($# != 2)); then
  printf '用法：bash scripts/dsa-target-acceptance.sh <正式备份目录> <新的绝对报告路径>\n' >&2
  exit 1
fi
init_build_space_lock
acquire_build_space_lock
export NODE_USE_ENV_PROXY=0
node "$infra_dir/scripts/dsa-target-acceptance.mjs" "$build_space_lock" "$@"
