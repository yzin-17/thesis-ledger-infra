#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/build-space.sh"

remove_failed_build_records() {
  local ref status
  if (($# == 0)); then
    printf '请显式提供失败构建记录ID；不支持全量删除。\n' >&2
    return 1
  fi
  for ref in "$@"; do
    [[ "$ref" =~ ^[a-z0-9]{20,32}$ ]] || { printf '非法构建记录ID: %s\n' "$ref" >&2; return 1; }
    status="$(docker --context "$build_space_builder" buildx history inspect --builder "$build_space_builder" "$ref" --format '{{.Status}}')" || return 1
    [[ "$status" == failed ]] || { printf '记录不是失败状态，保留: %s\n' "$ref" >&2; return 1; }
  done
  for ref in "$@"; do
    require_idle_builder || return 1
    status="$(docker --context "$build_space_builder" buildx history inspect --builder "$build_space_builder" "$ref" --format '{{.Status}}')" || return 1
    [[ "$status" == failed ]] || return 1
    docker --context "$build_space_builder" buildx history rm --builder "$build_space_builder" "$ref" || return 1
    printf '已移除失败构建记录: %s\n' "$ref"
  done
}

main() {
  base_image_aliases=(thesis-ledger-local-node:24-alpine)
  build_cache_min_free_space=18gb
  build_cache_max_used_space=8gb
  build_cache_reserved_space=4gb
  init_build_space || return 1
  acquire_build_space_lock || return 1
  trap release_build_space_lock EXIT
  require_idle_builder || return 1
  remove_failed_build_records "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
