#!/usr/bin/env bash

# 仅在正式更新锁内用于已验镜像的配置恢复／容器重建，不同步宿主新源码。
validate_reused_thesis_ledger_image() {
  local expected="$1" actual project service directory user command
  if [[ "${target:-}" != thesis-ledger ]]; then
    printf 'Server镜像复用只接受 thesis-ledger 目标。\n' >&2
    return 1
  fi
  if [[ ! "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'REUSE_THESIS_LEDGER_IMAGE_ID 必须是完整SHA256镜像ID。\n' >&2
    return 1
  fi
  actual="$(docker --context "$build_space_builder" image inspect --format '{{.Id}}' thesis-ledger:dev)" || return 1
  project="$(docker --context "$build_space_builder" image inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$expected")" || return 1
  service="$(docker --context "$build_space_builder" image inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$expected")" || return 1
  directory="$(docker --context "$build_space_builder" image inspect --format '{{.Config.WorkingDir}}' "$expected")" || return 1
  user="$(docker --context "$build_space_builder" image inspect --format '{{.Config.User}}' "$expected")" || return 1
  command="$(docker --context "$build_space_builder" image inspect --format '{{json .Config.Cmd}}' "$expected")" || return 1
  if [[ "$actual" != "$expected" || "$project" != thesis-ledger-dev || "$service" != thesis-ledger ||
        "$directory" != /app || "$user" != thesis || "$command" != '["node","apps/server/dist/src/main.js"]' ]]; then
    printf 'Server镜像ID、开发项目／服务或运行形态不匹配，停止复用。\n' >&2
    return 1
  fi
}

restore_reused_thesis_ledger_dependencies() {
  if [[ "${target:-}" != thesis-ledger || -z "${REUSE_THESIS_LEDGER_IMAGE_ID:-}" ]]; then
    printf '依赖恢复仅用于正式 Server 镜像复用分支。\n' >&2
    return 1
  fi
  printf '恢复已验 Server 的本地依赖: postgres redis dsa\n'
  if ! "${compose_args[@]}" up -d --no-build --pull never postgres redis dsa; then
    printf '依赖启动失败，尚未重建 Server 或 Worker。\n' >&2
    return 1
  fi
  local dependency
  for dependency in postgres redis dsa; do
    if ! wait_for_service "$dependency"; then
      printf '依赖未就绪: %s；尚未重建 Server 或 Worker。\n' "$dependency" >&2
      return 1
    fi
  done
}
