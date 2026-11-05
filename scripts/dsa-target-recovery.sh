#!/usr/bin/env bash
set -Eeuo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/update-lock.sh"
trap release_build_space_lock EXIT
if (($# != 5)); then
  printf '用法：bash scripts/dsa-target-recovery.sh <正式备份目录> <原镜像快照> <DG2a 报告> <DG2b 报告> <新私有结果目录>\n' >&2
  exit 1
fi
init_build_space_lock || exit 1
acquire_build_space_lock || exit 1
node "$infra_dir/scripts/dsa-target-recovery.mjs" "$build_space_lock" "$@"
