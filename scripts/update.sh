#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/dev-database.sh"
source "$infra_dir/scripts/preserve-database.sh"
source "$infra_dir/scripts/update-dsa-dockerfile.sh"
source "$infra_dir/scripts/retain-rollback-images.sh"
source "$infra_dir/scripts/build-space.sh"
source "$infra_dir/scripts/empty-development-volumes.sh"
source "$infra_dir/scripts/build-compose-service.sh"
source "$infra_dir/scripts/reuse-dsa-image.sh"
source "$infra_dir/scripts/longbridge-build-source.sh"
compose_args=()
app_services=()
base_image_sources=()
base_image_aliases=()
local_build_dir=""
local_compose_override=""
build_log=""

print_usage() {
  cat <<'EOF'
用法: ./scripts/update.sh [all|dsa|thesis-ledger]

默认目标为 all。可选环境参数：
  ENV_FILE                         Compose 环境文件
  HEALTH_TIMEOUT_SECONDS            健康检查超时秒数，默认 120
  REUSE_DSA_IMAGE_ID                 本轮已完成且源码未变的 DSA 镜像完整 ID；默认重新构建
  PULL_BASE_IMAGES                  是否刷新应用基础镜像，默认 false
  BOOTSTRAP_SPACE_PROBE              显式允许全空开发环境下载首次空间探针，默认 false
  INITIALIZE_EMPTY_DEV_VOLUMES       显式初始化空开发环境的四个配置卷，默认 false
  EMPTY_DEV_CONFIRM                 初始化卷确认值：thesis-ledger-dev/thesis_ledger
  PULL_SERVICE_IMAGES               是否刷新 PostgreSQL/Redis 镜像，默认 false
  REPAIR_BUILD_CACHE_ON_NO_SPACE    是否自动整备可回收 BuildKit/镜像空间，默认 true
  BUILD_CACHE_MAX_USED_SPACE        BuildKit cache 最大占用目标，默认 8gb
  BUILD_CACHE_MIN_FREE_SPACE        Docker 构建空间最小空闲目标，默认 18gb
  BUILD_CACHE_RESERVED_SPACE        BuildKit cache 保留底线，默认 4gb
  BUILD_HOST_MIN_FREE_SPACE         Docker 整备后的宿主空闲目标，默认 20gb
  BUILD_SPACE_HOST_PATH             宿主机 Docker 数据所在路径，默认标准 Desktop 数据目录
  ROLLBACK_IMAGE_KEEP_COUNT          每个服务保留的历史回滚镜像数量，默认 2
  BUILD_SPACE_ROLLBACK_KEEP_COUNT    共享磁盘不足时未保护历史回滚目标，默认 0；逐个退役/复测，受保护基线始终保留
  ROLLBACK_PROTECTED_IMAGES          额外保护的完整镜像 ID 或回滚标签，以空白分隔
EOF
  print_database_usage
}

cleanup() {
  release_build_space_lock
  cleanup_database_sql
  cleanup_longbridge_build_source
  if [[ -n "$local_build_dir" && -d "$local_build_dir" ]]; then
    rm -f \
      "$local_build_dir/build.log" \
      "$local_build_dir/dsa.Dockerfile" \
      "$local_build_dir/thesis-ledger.Dockerfile" \
      "$local_build_dir/compose.override.yml"
    rmdir "$local_build_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

target="${1:-all}"
if (($# > 1)); then
  print_usage >&2
  exit 1
fi

case "$target" in
  all)
    app_services=(dsa thesis-ledger)
    base_image_sources=(node:20-slim rust:1.94.1-slim-bookworm python:3.11-slim-bookworm node:24-alpine)
    base_image_aliases=(
      thesis-ledger-local-node:20-slim
      thesis-ledger-local-rust:1.94.1-slim-bookworm
      thesis-ledger-local-python:3.11-slim-bookworm
      thesis-ledger-local-node:24-alpine
    )
    ;;
  dsa)
    app_services=(dsa)
    base_image_sources=(node:20-slim rust:1.94.1-slim-bookworm python:3.11-slim-bookworm)
    base_image_aliases=(
      thesis-ledger-local-node:20-slim
      thesis-ledger-local-rust:1.94.1-slim-bookworm
      thesis-ledger-local-python:3.11-slim-bookworm
    )
    ;;
  thesis-ledger)
    app_services=(thesis-ledger)
    base_image_sources=(node:24-alpine)
    base_image_aliases=(thesis-ledger-local-node:24-alpine)
    ;;
  -h|--help) print_usage; exit 0 ;;
  *)
    printf '不支持的更新目标: %s\n' "$target" >&2
    print_usage >&2
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  printf '未找到 Docker CLI，请先安装并启动 Docker Desktop。\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf '无法连接 Docker daemon，请先启动 Docker Desktop。\n' >&2
  exit 1
fi

cd "$infra_dir"

env_file_input="${ENV_FILE:-}"
if [[ -n "$env_file_input" ]]; then
  if [[ "$env_file_input" = /* ]]; then
    env_file="$env_file_input"
  else
    env_file="$infra_dir/$env_file_input"
  fi
elif [[ -f "$infra_dir/.env" ]]; then
  env_file="$infra_dir/.env"
else
  env_file="$infra_dir/.env.example"
  printf '未找到 .env，使用本地示例配置: %s\n' "$env_file"
fi

if [[ ! -f "$env_file" ]]; then
  printf '环境文件不存在: %s\n' "$env_file" >&2
  exit 1
fi

compose_args=(
  docker compose
  --env-file "$env_file"
  -f "$infra_dir/compose.yml"
  -f "$infra_dir/compose.dev.yml"
)

health_timeout_seconds="${HEALTH_TIMEOUT_SECONDS:-120}"
if ! [[ "$health_timeout_seconds" =~ ^[0-9]+$ ]] || ((health_timeout_seconds < 1)); then
  printf 'HEALTH_TIMEOUT_SECONDS 必须是大于 0 的整数。\n' >&2
  exit 1
fi

init_database_update || exit 1

pull_service_images="${PULL_SERVICE_IMAGES:-false}"
case "$pull_service_images" in
  true|1|yes) pull_service_images=true ;;
  false|0|no) pull_service_images=false ;;
  *) printf 'PULL_SERVICE_IMAGES 必须是 true/false。\n' >&2; exit 1 ;;
esac

pull_base_images="${PULL_BASE_IMAGES:-false}"
case "$pull_base_images" in
  true|1|yes) pull_base_images=true ;;
  false|0|no) pull_base_images=false ;;
  *) printf 'PULL_BASE_IMAGES 必须是 true/false。\n' >&2; exit 1 ;;
esac

repair_build_cache="${REPAIR_BUILD_CACHE_ON_NO_SPACE:-true}"
case "$repair_build_cache" in
  true|1|yes) repair_build_cache=true ;;
  false|0|no) repair_build_cache=false ;;
  *) printf 'REPAIR_BUILD_CACHE_ON_NO_SPACE 必须是 true/false。\n' >&2; exit 1 ;;
esac

build_cache_max_used_space="${BUILD_CACHE_MAX_USED_SPACE:-8gb}"
if [[ -z "$build_cache_max_used_space" ]]; then
  printf 'BUILD_CACHE_MAX_USED_SPACE 不能为空。\n' >&2
  exit 1
fi

build_cache_min_free_space="${BUILD_CACHE_MIN_FREE_SPACE:-18gb}"
if [[ -z "$build_cache_min_free_space" ]]; then
  printf 'BUILD_CACHE_MIN_FREE_SPACE 不能为空。\n' >&2
  exit 1
fi

build_cache_reserved_space="${BUILD_CACHE_RESERVED_SPACE:-4gb}"
if [[ -z "$build_cache_reserved_space" ]]; then
  printf 'BUILD_CACHE_RESERVED_SPACE 不能为空。\n' >&2
  exit 1
fi

service_is_selected() {
  local expected="$1" service

  for service in "${app_services[@]}"; do
    if [[ "$service" == "$expected" ]]; then
      return 0
    fi
  done
  return 1
}

require_exact_line() {
  local source_file="$1" expected_line="$2" expected_count="$3" actual_count

  actual_count="$(grep -Fxc -- "$expected_line" "$source_file" || true)"
  if [[ "$actual_count" != "$expected_count" ]]; then
    printf '共享 Dockerfile 约定已变化：%s 中 `%s` 期望 %s 行，实际 %s 行。\n' \
      "$source_file" "$expected_line" "$expected_count" "$actual_count" >&2
    printf '请同步更新 scripts/update.sh 的本地 Dockerfile 变换映射后再重试。\n' >&2
    return 1
  fi
}

require_line_pattern() {
  local source_file="$1" expected_pattern="$2" expected_count="$3" actual_count

  actual_count="$(grep -Ecx -- "$expected_pattern" "$source_file" || true)"
  if [[ "$actual_count" != "$expected_count" ]]; then
    printf '共享 Dockerfile 变换约定已变化：%s 中匹配 `%s` 的行期望 %s 行，实际 %s 行。\n' \
      "$source_file" "$expected_pattern" "$expected_count" "$actual_count" >&2
    printf '请同步更新 scripts/update.sh 的本地 Dockerfile 变换映射后再重试。\n' >&2
    return 1
  fi
}

create_local_thesis_ledger_dockerfile() {
  local source_file="$infra_dir/../thesis-ledger/infra/docker/server.Dockerfile"
  local target_file="$local_build_dir/thesis-ledger.Dockerfile"

  if [[ ! -f "$source_file" ]]; then
    printf 'ThesisLedger Dockerfile 不存在: %s\n' "$source_file" >&2
    return 1
  fi

  require_exact_line "$source_file" 'FROM node:24-alpine AS build' 1 || return 1
  require_exact_line "$source_file" 'FROM node:24-alpine AS runtime' 1 || return 1
  require_exact_line "$source_file" 'ENV CI=true' 1 || return 1
  require_exact_line "$source_file" 'ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \' 0 || return 1
  require_exact_line "$source_file" '    pnpm_config_registry=https://registry.npmmirror.com \' 0 || return 1
  require_exact_line "$source_file" 'COPY apps/server/package.json apps/server/package.json' 1 || return 1
  require_exact_line "$source_file" 'COPY patches ./patches' 1 || return 1
  require_exact_line "$source_file" 'RUN pnpm --filter thesis-ledger --filter @thesis-ledger/server... install --frozen-lockfile' 1 || return 1
  require_line_pattern "$source_file" '^RUN pnpm --filter @thesis-ledger/server (exec )?prisma generate$' 1 || return 1
  require_exact_line "$source_file" 'RUN pnpm --filter @thesis-ledger/server deploy --prod /tmp/server-runtime --legacy' 1 || return 1
  require_exact_line "$source_file" 'RUN ./node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma' 1 || return 1
  require_exact_line "$source_file" 'RUN --mount=type=cache,id=thesis-ledger-prisma-engines,target=/root/.cache/prisma,sharing=locked \' 0 || return 1

  awk '
    $0 == "FROM node:24-alpine AS build" {
      print "FROM thesis-ledger-local-node:24-alpine AS build"
      next
    }
    $0 == "FROM node:24-alpine AS runtime" {
      print "FROM thesis-ledger-local-node:24-alpine AS runtime"
      next
    }
    $0 == "ENV CI=true" {
      print
      print "ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \\"
      print "    pnpm_config_registry=https://registry.npmmirror.com \\"
      print "    npm_config_registry=https://registry.npmmirror.com \\"
      print "    npm_config_disturl=https://npmmirror.com/mirrors/node"
      next
    }
    $0 == "COPY apps/server/package.json apps/server/package.json" {
      print "COPY apps/desktop/package.json apps/desktop/package.json"
      print "COPY apps/mobile/package.json apps/mobile/package.json"
      print "COPY apps/server/package.json apps/server/package.json"
      print "COPY packages/api-client/package.json packages/api-client/package.json"
      next
    }
    $0 == "COPY patches ./patches" {
      print "COPY services/dsa-adapter/package.json services/dsa-adapter/package.json"
      print "COPY patches ./patches"
      next
    }
    $0 == "RUN pnpm --filter thesis-ledger --filter @thesis-ledger/server... install --frozen-lockfile" {
      print "RUN --mount=type=cache,id=thesis-ledger-pnpm-store,target=/pnpm/store,sharing=locked \\"
      print "    pnpm config set store-dir /pnpm/store && \\"
      print "    pnpm --filter thesis-ledger --filter @thesis-ledger/server... install --frozen-lockfile"
      next
    }
    $0 ~ /^RUN pnpm --filter @thesis-ledger\/server (exec )?prisma generate$/ {
      print "RUN --mount=type=cache,id=thesis-ledger-prisma-engines,target=/root/.cache/prisma,sharing=locked \\"
      print "    " substr($0, 5)
      next
    }
    $0 == "RUN pnpm --filter @thesis-ledger/server deploy --prod /tmp/server-runtime --legacy" {
      print "RUN --mount=type=cache,id=thesis-ledger-pnpm-store,target=/pnpm/store,sharing=locked \\"
      print "    pnpm --filter @thesis-ledger/server deploy --prod /tmp/server-runtime --legacy"
      next
    }
    $0 == "RUN ./node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma" {
      print "RUN --mount=type=cache,id=thesis-ledger-prisma-engines,target=/root/.cache/prisma,sharing=locked \\"
      print "    ./node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma"
      next
    }
    { print }
  ' "$source_file" > "$target_file"
}

create_local_build_override() {
  local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/thesis-ledger-local-build.XXXXXX")"
  local_compose_override="$local_build_dir/compose.override.yml"
  build_log="$local_build_dir/build.log"
  : > "$build_log"

  printf 'services:\n' > "$local_compose_override"

  if service_is_selected dsa; then
    append_local_dsa_build_override "$infra_dir/../daily-stock-analysis/docker/Dockerfile" "$local_build_dir/dsa.Dockerfile" "$local_build_dir/sdk-source" "$local_compose_override" || return 1
  fi

  if service_is_selected thesis-ledger; then
    create_local_thesis_ledger_dockerfile || return 1
    printf '  thesis-ledger:\n    build:\n      dockerfile: %s\n' \
      "$local_build_dir/thesis-ledger.Dockerfile" >> "$local_compose_override"
  fi

  compose_args+=(-f "$local_compose_override")
}

prepare_base_image() {
  local source_image="$1" local_alias="$2"

  if [[ "$pull_base_images" == true ]]; then
    printf '刷新本地基础镜像别名: %s -> %s\n' "$source_image" "$local_alias"
  elif docker image inspect "$local_alias" >/dev/null 2>&1; then
    printf '复用本地基础镜像: %s\n' "$local_alias"
    return 0
  elif docker image inspect "$source_image" >/dev/null 2>&1; then
    printf '从本机基础镜像创建别名: %s -> %s\n' "$source_image" "$local_alias"
  else
    printf '本机首次缺少基础镜像，执行必要拉取: %s\n' "$source_image"
    if ! docker pull "$source_image"; then
      printf '应用基础镜像首次拉取失败: %s\n' "$source_image" >&2
      return 1
    fi
  fi

  if ! docker tag "$source_image" "$local_alias"; then
    printf '应用基础镜像别名创建失败: %s -> %s\n' "$source_image" "$local_alias" >&2
    return 1
  fi
  if ! docker image inspect "$local_alias" >/dev/null 2>&1; then
    printf '应用基础镜像别名校验失败: %s\n' "$local_alias" >&2
    return 1
  fi

}

prepare_base_images() {
  local index source_image

  if [[ "$pull_base_images" == true ]]; then
    for source_image in "${base_image_sources[@]}"; do
      printf '刷新应用基础镜像: %s\n' "$source_image"
      if ! docker pull "$source_image"; then
        printf '应用基础镜像拉取失败，所有本地别名保持不变: %s\n' "$source_image" >&2
        return 1
      fi
    done
  fi

  for ((index = 0; index < ${#base_image_sources[@]}; index += 1)); do
    prepare_base_image \
      "${base_image_sources[$index]}" \
      "${base_image_aliases[$index]}" || return 1
  done
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + health_timeout_seconds))
  local container_id state health

  while ((SECONDS < deadline)); do
    # `ps -q` 默认只返回运行中的容器；服务启动后立即退出时会导致无休止等待。
    # 使用 `-aq` 让失败容器也能被识别并立即输出日志。
    container_id="$("${compose_args[@]}" ps -aq "$service" 2>/dev/null || true)"
    container_id="${container_id%%$'\n'*}"

    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"

      if [[ "$state" == "running" ]] && [[ "$health" == "healthy" || "$health" == "none" ]]; then
        printf '服务已就绪: %s (%s)\n' "$service" "$health"
        return 0
      fi

      if [[ "$state" == "exited" || "$state" == "dead" ]]; then
        printf '服务未能运行: %s (状态: %s)\n' "$service" "$state" >&2
        return 1
      fi
    fi

    sleep 2
  done

  printf '等待服务健康检查超时: %s (%ss)\n' "$service" "$health_timeout_seconds" >&2
  return 1
}

run_build_command() {
  local service exit_code

  for service in "${app_services[@]}"; do
    if [[ "$service" == dsa && -n "${REUSE_DSA_IMAGE_ID:-}" ]]; then
      validate_reused_dsa_image "$REUSE_DSA_IMAGE_ID" || return 75
      protect_completed_build_image "$service" || return 75
      printf '复用本轮已完成的 DSA 镜像: %s\n' "$REUSE_DSA_IMAGE_ID"
      continue
    fi
    printf '构建服务: %s\n' "$service" | tee -a "$build_log"
    if build_compose_service "$service" 2>&1 | tee -a "$build_log"; then
      protect_completed_build_image "$service" || return 75
    else
      exit_code=$?
      return "$exit_code"
    fi
  done
}

is_disk_space_failure() {
  grep -Eiq 'no space left on device|not enough disk space|insufficient disk space' "$build_log"
}

run_build_with_retry() {
  local attempt=1 exit_code

  while ((attempt <= 2)); do
    : > "$build_log"
    if run_build_command; then
      return 0
    else
      exit_code=$?
    fi

    # 镜像身份校验失败不能进入构建重试或 ENOSPC 恢复。
    if ((exit_code == 75)); then
      return "$exit_code"
    fi

    if ((attempt == 2)); then
      printf '第 2 次镜像构建仍失败，不再重试。\n' >&2
      return "$exit_code"
    fi

    if is_disk_space_failure; then
      if [[ "$repair_build_cache" != true ]]; then
        printf '检测到 Docker 构建空间不足；缓存保持不变。\n' >&2
        printf '确认可以清理未使用的 BuildKit cache 后，请使用 REPAIR_BUILD_CACHE_ON_NO_SPACE=true 重试。\n' >&2
        return "$exit_code"
      fi

      printf '检测到 Docker 构建空间不足，清理当前 builder 的全部未使用 BuildKit cache...\n' >&2
      if ! require_idle_builder || ! prune_unused_build_cache; then
        printf 'BuildKit cache 清理失败，无法进行重试。\n' >&2
        return "$exit_code"
      fi
    else
      printf '首次镜像构建失败，保留现有 BuildKit cache 后重试一次...\n' >&2
    fi

    attempt=2
  done
}

run_update() {
  local exit_code service

  validate_rollback_image_policy || return 1

  if ! create_local_build_override; then
    printf '本地临时构建定义生成失败；未拉取镜像，也未开始构建或启动。\n' >&2
    return 1
  fi

  printf '使用环境文件: %s\n' "$env_file"
  printf '更新目标: %s\n' "${app_services[*]}"

  init_build_space || return 1
  acquire_build_space_lock || return 1
  if [[ -n "${REUSE_DSA_IMAGE_ID:-}" ]]; then
    if [[ "$target" != all && "$target" != dsa ]]; then
      printf 'DSA 镜像复用仅适用于 all 或 dsa 目标。\n' >&2
      return 1
    fi
    validate_reused_dsa_image "$REUSE_DSA_IMAGE_ID" || return 1
  fi
  prepare_build_space_probe || return 1
  if ! ensure_build_space '拉取前'; then
    printf '构建空间预检失败；未拉取镜像，也未开始应用构建。\n' >&2
    return 1
  fi
  initialize_empty_development_volumes || return 1
  prepare_longbridge_build_source || return 1

  if ! retain_rollback_images "${app_services[@]}"; then
    printf '当前运行镜像未能安全固定；停止更新，尚未覆盖应用镜像。\n' >&2
    return 1
  fi

  if [[ "$pull_service_images" == true ]]; then
    printf '拉取 PostgreSQL 和 Redis 服务镜像...\n'
    if "${compose_args[@]}" pull postgres redis; then
      :
    else
      exit_code=$?
      printf '基础服务镜像拉取失败，退出码: %s\n' "$exit_code" >&2
      return "$exit_code"
    fi
  fi

  if ! prepare_base_images; then
    printf '应用基础镜像准备失败；未开始应用镜像构建，现有本地别名保持不变。\n' >&2
    return 1
  fi

  printf '构建应用镜像: %s\n' "${app_services[*]}"
  if run_build_with_retry; then
    :
  else
    exit_code=$?
    printf '应用镜像构建失败，退出码: %s。\n' "$exit_code" >&2
    print_status >&2
    printf '未自动停止其他进程，也未删除任何 Docker 数据卷。\n' >&2
    return "$exit_code"
  fi

  if ! require_idle_builder || ! maintain_build_cache '构建后'; then
    printf '警告：应用镜像已构建，但构建后 BuildKit cache 维护失败；继续启动目标服务。\n' >&2
  fi

  prepare_database_for_update || return 1

  start_updated_services || return 1

  printf '\n源码栈更新完成，当前状态:\n'
  "${compose_args[@]}" ps || return 1
  if ! prune_rollback_images_after_update; then
    printf '警告：服务更新已完成，但历史回滚镜像维护失败；停止后续淘汰，不重新构建。\n' >&2
  fi
}

run_update
