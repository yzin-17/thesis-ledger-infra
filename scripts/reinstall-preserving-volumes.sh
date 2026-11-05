#!/usr/bin/env bash

# 只由 update.sh 在持有更新锁且真实 ENOSPC 时调用，不是独立更新入口。
reinstall_preserving_volumes() {
  local DOCKER_CONTEXT="$build_space_builder" recovery_file reason="${1:-实际 ENOSPC}"
  export DOCKER_CONTEXT
  [[ -n "$build_space_lock" && "$(cat "$build_space_lock/pid")" == "$$" ]] || return 1
  [[ "$build_space_reinstalled" != true ]] || return 1
  require_idle_builder || return 1
  build_space_reinstalled=true
  recovery_file="$infra_dir/.maintenance-backups/docker-space-recovery/compose.json"
  mkdir -p "$(dirname "$recovery_file")" || return 1
  if ! "${compose_args[@]}" config --format json | node "$infra_dir/scripts/docker-reinstall-plan.mjs" > "$recovery_file.pending"; then
    printf '未能生成完整保卷恢复计划；未停止容器。\n' >&2
    return 1
  fi
  mv "$recovery_file.pending" "$recovery_file" || return 1
  printf '保卷恢复尚未完成\n' > "$(dirname "$recovery_file")/incomplete" || return 1
  # 从此以后无论成功失败都保留恢复文件，供重接匿名卷及诊断。
  build_space_recovery_file="$recovery_file"
  printf '%s：执行本开发项目保卷重装，恢复配置保留于 %s\n' "$reason" "$recovery_file"
  require_idle_builder || return 1
  "${compose_args[@]}" stop || return 1
  require_idle_builder || return 1
  "${compose_args[@]}" down || return 1
  node -e 'const fs = require("fs"), cp = require("child_process");
    const names = JSON.parse(fs.readFileSync(process.argv[1]))["x-thesis-ledger-recovery"]?.volumeNames;
    if (!Array.isArray(names)) process.exit(1);
    for (const name of names) cp.execFileSync("docker", ["volume", "inspect", name], {stdio:"ignore"});' "$recovery_file" || return 1

  # 更新前容器已移除，旧回滚可重建；显式保护仍由镜像执行器保留。
  rollback_protected_image_ids=()
  require_idle_builder || return 1
  prune_unused_build_cache || return 1
  repair_docker_image_space all-unused || return 1
  reclaim_docker_desktop_space || return 1
  measure_build_space || return 1
  if ((build_host_available_kib <= 0 || build_docker_available_kib <= 0)); then
    printf '保卷清理后仍无实际可用空间；停止重装，保留 volumes 和恢复配置。\n' >&2
    return 1
  fi
  # 本项目容器全部重建，不能继续沿用原单目标。
  target=all
  app_services=(dsa thesis-ledger)
  base_image_sources=(rust:1.94.1-slim-bookworm python:3.11-slim-bookworm node:24-alpine)
  base_image_aliases=(thesis-ledger-local-rust:1.94.1-slim-bookworm
    thesis-ledger-local-python:3.11-slim-bookworm thesis-ledger-local-node:24-alpine)
  create_local_build_override || return 1
  compose_args+=(-f "$recovery_file")
  if [[ -z "$build_space_dsa_image_id" ]]; then prepare_longbridge_build_source || return 1; fi
  prepare_base_images || return 1
}
