#!/usr/bin/env bash

# 本地 docker driver 的空间门禁；由 update.sh 持有更新锁并调用。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-space-lifecycle.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/update-lock.sh"
build_space_dsa_image_id=""
build_space_ledger_image_id=""
build_space_reinstalled=false

space_kib() {
  local value="$1"
  if ! [[ "$value" =~ ^[0-9]+([.][0-9]+)?([bBkKmMgGtT]|[kKmMgGtT][bB])?$ ]]; then
    printf '非法容量参数: %s（例如 18gb）\n' "$value" >&2
    return 1
  fi
  awk -v value="$value" 'BEGIN {
    value = tolower(value); unit = value; sub(/^[0-9.]+/, "", unit)
    factor = 1
    if (unit ~ /^k/) factor = 1024
    if (unit ~ /^m/) factor = 1024^2
    if (unit ~ /^g/) factor = 1024^3
    if (unit ~ /^t/) factor = 1024^4
    printf "%.0f\n", (value + 0) * factor / 1024
  }'
}

init_build_space() {
  local endpoint builder_info candidate candidate_id docker_data lock_key
  build_space_min_kib="$(space_kib "$build_cache_min_free_space")" || return 1
  build_host_min_kib="$(space_kib "${BUILD_HOST_MIN_FREE_SPACE:-20gb}")" || return 1
  space_kib "$build_cache_max_used_space" >/dev/null || return 1
  space_kib "$build_cache_reserved_space" >/dev/null || return 1
  build_space_rollback_keep_count="${BUILD_SPACE_ROLLBACK_KEEP_COUNT:-0}"
  if ! [[ "$build_space_rollback_keep_count" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf 'BUILD_SPACE_ROLLBACK_KEEP_COUNT 必须为非负安全整数。\n' >&2
    return 1
  fi
  ROLLBACK_IMAGE_KEEP_COUNT="$build_space_rollback_keep_count" \
    node "$infra_dir/scripts/rollback-image-policy.mjs" --validate-config --space-recovery >/dev/null || return 1
  if ((build_space_min_kib < 1 || build_host_min_kib < 1)); then
    printf '宿主机和 Docker 清理参考目标必须大于零。\n' >&2
    return 1
  fi

  build_space_builder="$(docker context show)" || return 1
  endpoint="$(docker context inspect "$build_space_builder" --format '{{.Endpoints.docker.Host}}')" || return 1
  if [[ "$endpoint" != unix://* || -n "${DOCKER_HOST:-}" ||
        ( -n "${BUILDX_BUILDER:-}" && "$BUILDX_BUILDER" != "$build_space_builder" ) ]]; then
    printf '空间门禁仅支持当前本地 context 的 docker driver；请移除 DOCKER_HOST/自定义 BUILDX_BUILDER 或切换本地 context。\n' >&2
    return 1
  fi
  builder_info="$(docker buildx inspect "$build_space_builder")" || return 1
  if [[ "$(awk '$1 == "Driver:" {print $2}' <<< "$builder_info")" != docker ||
        "$(awk '$1 == "Endpoint:" {print $2}' <<< "$builder_info")" != "$build_space_builder" ]]; then
    printf '空间门禁不支持当前 builder 的驱动或节点布局: %s\n' "$build_space_builder" >&2
    return 1
  fi

  docker_data="$HOME/Library/Containers/com.docker.docker/Data/vms/0/data"
  build_space_host_path="${BUILD_SPACE_HOST_PATH:-$infra_dir}"
  if [[ -z "${BUILD_SPACE_HOST_PATH:-}" && -d "$docker_data" ]]; then
    build_space_host_path="$docker_data"
  fi
  if [[ ! -e "$build_space_host_path" ]]; then
    printf '宿主机空间检查路径不存在: %s\n' "$build_space_host_path" >&2
    return 1
  fi

  # 固定已有镜像 ID；探测不能为释放空间而先下载镜像。
  build_space_probe_image=""
  for candidate in "${base_image_aliases[@]}" node:24-alpine postgres:17-alpine; do
    if candidate_id="$(docker image inspect --format '{{.Id}}' "$candidate" 2>/dev/null)" &&
       [[ "$candidate_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      build_space_probe_image="$candidate_id"
      break
    fi
  done
  if [[ -z "$build_space_probe_image" && "${BOOTSTRAP_SPACE_PROBE:-false}" != true ]]; then
    printf '空间探针没有可用本地基础镜像；请先准备 node:24-alpine 或当前目标的本地基础镜像别名。\n' >&2
    return 1
  fi

  init_build_space_lock || return 1
}

# 恢复入口只需同一把本地 daemon 锁，不依赖空间探针或镜像下载。
prepare_build_space_probe() {
  [[ -z "$build_space_probe_image" ]] || return 0
  [[ "${BOOTSTRAP_SPACE_PROBE:-false}" == true ]] || return 1
  local inventory volumes host_df available candidate_id
  require_idle_builder || return 1
  inventory="$(docker info --format '{{.Containers}} {{.Images}}')" || return 1
  volumes="$(docker volume ls -q)" || return 1
  if [[ "$inventory" != '0 0' || -n "$volumes" ]]; then
    printf '首次探针初始化只允许没有容器、镜像和 volume 的空环境。\n' >&2
    return 1
  fi
  host_df="$(LC_ALL=C df -Pk "$infra_dir" "$build_space_host_path")" || return 1
  available="$(df_available_kib <<< "$host_df")" || return 1
  if ((available <= 0)); then
    printf '首次探针下载前宿主机无可用空间；未拉取镜像。\n' >&2
    return 1
  fi
  printf '空开发环境：下载首次空间探针基础镜像，随后仍执行完整空间门禁。\n'
  docker pull node:24-alpine || return 1
  candidate_id="$(docker image inspect --format '{{.Id}}' node:24-alpine)" || return 1
  [[ "$candidate_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  build_space_probe_image="$candidate_id"
}

require_idle_builder() {
  local statuses
  statuses="$(docker buildx --builder "$build_space_builder" history ls --format '{{.Status}}')" || return 1
  if grep -Eiq 'running|pending' <<< "$statuses"; then
    printf 'builder %s 有其他构建正在执行；本次不清理、不启动重复构建。\n' "$build_space_builder" >&2
    return 1
  fi
}

df_available_kib() {
  awk 'NR > 1 && NF {
    if ($4 !~ /^[0-9]+$/) { bad = 1; next }
    if (!count || $4 + 0 < available) available = $4 + 0
    count++
  } END {
    if (!count || bad) exit 1
    printf "%.0f\n", available
  }'
}

measure_build_space() {
  local host_df docker_df
  host_df="$(LC_ALL=C df -Pk "$infra_dir" "$build_space_host_path")" || return 1
  docker_df="$(docker run --rm --pull=never --network none --read-only \
    --entrypoint df "$build_space_probe_image" -Pk /)" || return 1
  build_host_available_kib="$(df_available_kib <<< "$host_df")" || return 1
  build_docker_available_kib="$(df_available_kib <<< "$docker_df")" || return 1
  printf '空间实测：宿主机 %s MiB（清理参考 %s），Docker %s MiB（清理参考 %s）；宿主路径 %s\n' \
    "$((build_host_available_kib / 1024))" "$((build_host_min_kib / 1024))" \
    "$((build_docker_available_kib / 1024))" "$((build_space_min_kib / 1024))" "$build_space_host_path"
}

build_space_sufficient() {
  ((build_host_available_kib >= build_host_min_kib && build_docker_available_kib >= build_space_min_kib))
}

prune_unused_build_cache() {
  docker buildx prune --builder "$build_space_builder" --all --force
}

maintain_build_cache() {
  local phase="$1"
  if [[ "$repair_build_cache" != true ]]; then
    return 0
  fi
  printf '%s：维护 BuildKit cache（最大 %s，最小空闲 %s，保留底线 %s）...\n' \
    "$phase" "$build_cache_max_used_space" "$build_cache_min_free_space" "$build_cache_reserved_space"
  docker buildx prune --builder "$build_space_builder" --all --force \
    --max-used-space "$build_cache_max_used_space" \
    --min-free-space "$build_cache_min_free_space" \
    --reserved-space "$build_cache_reserved_space"
}

repair_docker_image_space() {
  local image_id repair_target="${target:-all}" repair_script=docker-space-images.mjs
  local arguments=(--apply --lock-owner "$$" --protect "$build_space_probe_image")
  if [[ -n "${REUSE_DSA_IMAGE_ID:-}" ]]; then arguments+=(--protect "$REUSE_DSA_IMAGE_ID"); fi
  if [[ "${rollback_protected_image_ids+present}" == present ]]; then
    for image_id in "${rollback_protected_image_ids[@]}"; do arguments+=(--protect "$image_id"); done
  fi
  for image_id in "$build_space_dsa_image_id" "$build_space_ledger_image_id"; do
    if [[ -n "$image_id" ]]; then arguments+=(--protect "$image_id"); fi
  done
  if [[ "${1:-}" == all-unused ]]; then
    repair_target=all
    arguments+=(--all-unused)
    printf '自动清理全部未引用镜像（包括可重新下载的基础镜像）；保留容器引用、显式保护和本轮产物。\n'
  elif [[ "${1:-}" == all-rollbacks ]]; then
    repair_target=all
    repair_script=rollback-image-policy.mjs
    arguments+=(--space-recovery)
    printf '共享磁盘容量仍不足：检查两个应用的超额历史回滚；保留容器引用、指定基线和本次构建产物。\n'
  else
    printf '整备未引用的 Docker 镜像；保留容器、数据卷、基础镜像和必要回滚基线。\n'
  fi
  DOCKER_CONTEXT="$build_space_builder" node "$infra_dir/scripts/$repair_script" \
    "$repair_target" "${arguments[@]}"
}

protect_completed_build_image() {
  local service="$1" reference image_id
  case "$service" in
    dsa) reference=daily-stock-analysis:thesisledger-dev ;;
    thesis-ledger) reference=thesis-ledger:dev ;;
    *) printf '无法保护未知构建目标: %s\n' "$service" >&2; return 1 ;;
  esac
  image_id="$(docker --context "$build_space_builder" image inspect --format '{{.Id}}' "$reference")" || return 1
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  if [[ "$service" == dsa ]]; then build_space_dsa_image_id="$image_id";
  else build_space_ledger_image_id="$image_id"; fi
  printf '本次已完成构建产物受保护: %s -> %s\n' "$service" "$image_id"
}

reclaim_docker_desktop_space() {
  [[ "${OSTYPE:-}" == darwin* && -f "$build_space_host_path/Docker.raw" ]] || return 0
  local docker_os reclaim_image
  docker_os="$(docker --context "$build_space_builder" info --format '{{.OperatingSystem}}')" || return 1
  [[ "$docker_os" == 'Docker Desktop'* ]] || return 0
  require_idle_builder || return 1
  # Docker官方回收工具的已核验不可变manifest；只回收VM已空闲块，不缩小磁盘或删除业务文件。
  reclaim_image='docker/desktop-reclaim-space@sha256:8b26e45c51632fd78131f3bddca76122bebc1dd8376f16dd26f769c7f33121fd'
  if ! docker --context "$build_space_builder" image inspect "$reclaim_image" >/dev/null 2>&1; then
    docker --context "$build_space_builder" pull "$reclaim_image" || return 1
  fi
  require_idle_builder || return 1
  printf '触发 Docker Desktop 已空闲磁盘块回收，随后核对宿主实际余量。\n'
  docker --context "$build_space_builder" run --rm --pull=never --network none --read-only \
    --privileged --pid=host --platform linux/amd64 "$reclaim_image" || return 1
}

ensure_build_space() {
  local phase="$1" rollback_result
  require_idle_builder || return 1
  maintain_build_cache "$phase" || return 1
  if ! measure_build_space; then
    printf '无法读取实际空闲空间；停止更新，不能把未知值当作充足。\n' >&2
    return 1
  fi
  if build_space_sufficient; then
    return 0
  fi
  if [[ "$repair_build_cache" == true ]]; then
    printf '%s：低于参考目标，先整备历史镜像，保留可复用依赖缓存。\n' "$phase"
    repair_docker_image_space || return 1
    measure_build_space || return 1
    if build_space_sufficient; then
      return 0
    fi
    reclaim_docker_desktop_space || return 1
    measure_build_space || return 1
    if build_space_sufficient; then
      return 0
    fi
    if ((build_space_rollback_keep_count < ${ROLLBACK_IMAGE_KEEP_COUNT:-2})); then
      printf '容量仍不足：紧张期历史回滚目标为每服务 %s 个；运行镜像、指定基线和本次构建产物继续保护。\n' \
        "$build_space_rollback_keep_count"
      while true; do
        if ROLLBACK_IMAGE_KEEP_COUNT="$build_space_rollback_keep_count" repair_docker_image_space all-rollbacks; then
          measure_build_space || return 1
          if build_space_sufficient; then return 0; fi
          reclaim_docker_desktop_space || return 1
          measure_build_space || return 1
          if build_space_sufficient; then return 0; fi
        else
          rollback_result=$?
          if ((rollback_result == 2)); then break; fi
          return "$rollback_result"
        fi
      done
    fi
  fi
  # 清理目标不是构建所必需容量；未知值已由测量拒绝，真实 ENOSPC 由更新入口恢复。
  if ((build_host_available_kib > 0 && build_docker_available_kib > 0)); then
    printf '未达到参考清理目标，实测仍有可用空间；继续构建，实际 ENOSPC 将自动进入保卷恢复。\n'
    return 0
  fi
  printf '实际可用空间为零，需要保卷恢复后再构建。\n' >&2
  return 76
}
