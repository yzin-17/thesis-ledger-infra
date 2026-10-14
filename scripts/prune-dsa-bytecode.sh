#!/usr/bin/env bash
set -Eeuo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/build-space.sh"
if (($# > 1)) || [[ "${1:-}" != '' && "${1:-}" != --apply ]]; then
  printf '用法：bash scripts/prune-dsa-bytecode.sh [--apply]；默认预览。\n' >&2
  exit 1
fi
base_image_aliases=(thesis-ledger-local-node:24-alpine)
build_cache_min_free_space=18gb
build_cache_max_used_space=8gb
build_cache_reserved_space=4gb
init_build_space
acquire_build_space_lock
trap release_build_space_lock EXIT
require_idle_builder
container_id="$(docker --context "$build_space_builder" ps --filter label=com.docker.compose.project=thesis-ledger-dev --filter label=com.docker.compose.service=dsa --filter status=running --format '{{.ID}}')"
[[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { printf '无法唯一确认运行中的开发DSA容器。\n' >&2; exit 1; }
require_idle_builder
docker --context "$build_space_builder" exec -i "$container_id" python -B - "$@" < "$infra_dir/scripts/prune-dsa-bytecode.py"
