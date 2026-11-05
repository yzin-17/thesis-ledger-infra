#!/usr/bin/env bash

init_update_space_mode() {
  update_space_mode="${UPDATE_SPACE_MODE:-auto}"
  case "$update_space_mode" in
    auto) ;;
    compact)
      if [[ "$repair_build_cache" != true ]]; then
        printf 'compact 保卷重建与关闭自动清理冲突。\n' >&2
        return 1
      fi
      ;;
    *) printf 'UPDATE_SPACE_MODE 必须为 auto 或 compact。\n' >&2; return 1 ;;
  esac
}

# 完成一个服务后先释放普通构建快照，避免将两个服务的中间层峰值相加。
release_build_intermediates() {
  [[ "$repair_build_cache" == true ]] || return 0
  require_idle_builder || return 1
  printf '%s 已构建：回收普通中间层，保留依赖缓存及镜像引用层。\n' "$1"
  docker buildx prune --builder "$build_space_builder" --all --force --filter 'type!=exec.cachemount'
}

# 只有新服务全部健康后才解除旧基线保护。显式保护由镜像执行器继续维护。
finalize_update_space() {
  [[ "$repair_build_cache" == true ]] || return 0
  local result
  rollback_protected_image_ids=()
  require_idle_builder || return 1
  maintain_build_cache '健康后占用收敛' || return 1
  measure_build_space || return 1
  if ! build_space_sufficient; then
    while true; do
      if ROLLBACK_IMAGE_KEEP_COUNT="$build_space_rollback_keep_count" repair_docker_image_space all-rollbacks; then
        measure_build_space || return 1
        if build_space_sufficient; then break; fi
      else
        result=$?
        if ((result == 2)); then break; fi
        return "$result"
      fi
    done
    reclaim_docker_desktop_space || return 1
    measure_build_space || return 1
  fi
  printf '本轮更新完成并回收历史资源；最终实际余量见上方读数，未达参考目标不会重建或阻断健康服务。\n'
}
