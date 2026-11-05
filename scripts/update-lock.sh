#!/usr/bin/env bash
# 本地 daemon 的正式更新与恢复共用锁；不需要空间探针。
build_space_lock=""

init_build_space_lock() {
  local endpoint lock_key
  build_space_builder="$(docker context show)" || return 1
  endpoint="$(docker context inspect "$build_space_builder" --format '{{.Endpoints.docker.Host}}')" || return 1
  if [[ "$endpoint" != unix://* || -n "${DOCKER_HOST:-}" ]]; then
    printf '更新与恢复仅支持当前本地 Docker context。\n' >&2
    return 1
  fi
  lock_key="$(printf '%s' "$endpoint" | cksum | awk '{print $1}')"
  build_space_lock_path="${TMPDIR:-/tmp}/thesis-ledger-update-$(id -u)-$lock_key.lock"
}


acquire_build_space_lock() {
  if ! ps -p "$$" -o ppid= >/dev/null 2>&1; then
    printf '进程查询权限不足：请以允许 ps 的权限执行正式 update.sh；尚未取得更新锁或修改 Docker。\n' >&2
    return 1
  fi
  if ! mkdir "$build_space_lock_path" 2>/dev/null; then
    printf '已有更新锁: %s；等待当前更新结束。若为异常退出遗留，请先确认对应进程已停止再移除该锁。\n' "$build_space_lock_path" >&2
    return 1
  fi
  build_space_lock="$build_space_lock_path"
  printf '%s\n' "$$" > "$build_space_lock/pid"
}


release_build_space_lock() {
  if [[ -n "$build_space_lock" ]]; then
    rm -f "$build_space_lock/pid"
    rmdir "$build_space_lock" 2>/dev/null || true
    build_space_lock=""
  fi
}


