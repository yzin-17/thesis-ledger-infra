#!/usr/bin/env bash

# 仅由 update.sh 在 context、builder、更新锁和空间门禁通过后调用。
# Compose 负责解析全部配置；通过 Docker CLI 启动 Bake 保留显式 context。
build_network_options=()

init_build_network() {
  local key variable value
  build_network_options=()
  for key in HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    variable="BUILD_$key"
    value="${!variable:-}"
    [[ -n "$value" ]] || continue
    if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
      printf '%s 不允许换行。\n' "$variable" >&2
      return 1
    fi
    if [[ "$key" != NO_PROXY && ! "$value" =~ ^https?://[^[:space:]]+$ ]]; then
      printf '%s 必须为 HTTP/HTTPS 代理 URL。\n' "$variable" >&2
      return 1
    fi
    build_network_options+=(--set "*.args.$key=$value")
  done
}

build_compose_service() {
  local service="$1"
  DOCKER_CONTEXT="$build_space_builder" docker --context "$build_space_builder" \
    "${compose_args[@]:1}" build --print "$service" |
    DOCKER_CONTEXT="$build_space_builder" docker --context "$build_space_builder" \
      buildx bake --builder "$build_space_builder" --file - --progress plain \
      --allow "fs.read=$(dirname "$infra_dir")" \
      --allow "fs.read=$local_build_dir" \
      ${build_network_options[@]+"${build_network_options[@]}"} "$service"
}
