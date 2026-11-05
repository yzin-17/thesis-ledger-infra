#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/update-lock.sh"
trap release_build_space_lock EXIT

if (($# != 1)) || [[ "$1" == --help || "$1" == -h ]]; then
  printf '用法：bash ./scripts/restore-dsa.sh <更新前的 DSA 运行态快照.json>\n'
  printf '固定原镜像、API 命令及全部挂载；不构建、拉取、修改数据库或删除卷。\n'
  exit 1
fi
snapshot_path="$1"
env_file="${ENV_FILE:-$infra_dir/.env}"
if [[ "$env_file" != /* ]]; then env_file="$infra_dir/$env_file"; fi
if [[ ! -f "$env_file" && -z "${ENV_FILE:-}" ]]; then env_file="$infra_dir/.env.example"; fi
if [[ ! -f "$env_file" || ! -f "$snapshot_path" ]]; then
  printf '恢复环境文件或快照不存在。\n' >&2
  exit 1
fi
init_build_space_lock || exit 1
acquire_build_space_lock || exit 1
node "$infra_dir/scripts/dsa-runtime-recovery.mjs" restore "$infra_dir" "$env_file" \
  "$build_space_lock" "$snapshot_path" "${HEALTH_TIMEOUT_SECONDS:-120}"
