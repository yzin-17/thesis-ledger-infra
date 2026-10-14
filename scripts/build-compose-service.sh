#!/usr/bin/env bash

# 仅由 update.sh 在 context、builder、更新锁和空间门禁通过后调用。
# Compose 负责解析全部配置；通过 Docker CLI 启动 Bake 保留显式 context。
build_compose_service() {
  local service="$1"
  DOCKER_CONTEXT="$build_space_builder" docker --context "$build_space_builder" \
    "${compose_args[@]:1}" build --print "$service" |
    DOCKER_CONTEXT="$build_space_builder" docker --context "$build_space_builder" \
      buildx bake --builder "$build_space_builder" --file - --progress plain \
      --allow "fs.read=$(dirname "$infra_dir")" \
      --allow "fs.read=$local_build_dir" "$service"
}
