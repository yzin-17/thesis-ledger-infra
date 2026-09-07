#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_args=()
app_services=()
base_image_sources=()
base_image_aliases=()
local_build_dir=""
local_compose_override=""
build_log=""

print_status() {
  if ((${#compose_args[@]} > 0)); then
    "${compose_args[@]}" ps -a || true
  fi
}

print_usage() {
  cat <<'EOF'
用法: ./scripts/update.sh [all|dsa|thesis-ledger]

默认目标为 all。可选环境参数：
  ENV_FILE                         Compose 环境文件
  HEALTH_TIMEOUT_SECONDS            健康检查超时秒数，默认 120
  PULL_BASE_IMAGES                  是否刷新应用基础镜像，默认 false
  PULL_SERVICE_IMAGES               是否刷新 PostgreSQL/Redis 镜像，默认 false
  REPAIR_BUILD_CACHE_ON_NO_SPACE    磁盘不足时是否有界清理 BuildKit cache，默认 false
  BUILD_CACHE_MIN_FREE_SPACE        有界清理后的最小空闲空间，默认 8gb
EOF
}

cleanup() {
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
    base_image_sources=(node:20-slim python:3.11-slim-bookworm node:24-alpine)
    base_image_aliases=(
      thesis-ledger-local-node:20-slim
      thesis-ledger-local-python:3.11-slim-bookworm
      thesis-ledger-local-node:24-alpine
    )
    ;;
  dsa)
    app_services=(dsa)
    base_image_sources=(node:20-slim python:3.11-slim-bookworm)
    base_image_aliases=(thesis-ledger-local-node:20-slim thesis-ledger-local-python:3.11-slim-bookworm)
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

report_runtime_failure() {
  local phase="$1" exit_code="$2" service container_id

  printf '%s失败，退出码: %s\n' "$phase" "$exit_code" >&2
  print_status >&2
  for service in "${app_services[@]}"; do
    container_id="$("${compose_args[@]}" ps -aq "$service" 2>/dev/null || true)"
    container_id="${container_id%%$'\n'*}"
    if [[ -n "$container_id" ]]; then
      printf '\n%s 最近日志:\n' "$service" >&2
      docker logs --tail 80 "$container_id" >&2 || true
    fi
  done
  printf '未自动停止其他进程，也未删除任何 Docker 数据卷。\n' >&2
}

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

repair_build_cache="${REPAIR_BUILD_CACHE_ON_NO_SPACE:-false}"
case "$repair_build_cache" in
  true|1|yes) repair_build_cache=true ;;
  false|0|no) repair_build_cache=false ;;
  *) printf 'REPAIR_BUILD_CACHE_ON_NO_SPACE 必须是 true/false。\n' >&2; exit 1 ;;
esac

build_cache_min_free_space="${BUILD_CACHE_MIN_FREE_SPACE:-8gb}"
if [[ -z "$build_cache_min_free_space" ]]; then
  printf 'BUILD_CACHE_MIN_FREE_SPACE 不能为空。\n' >&2
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
    printf '请同步更新 scripts/update.sh 的本地基础镜像映射后再重试。\n' >&2
    return 1
  fi
}

create_local_dsa_dockerfile() {
  local source_file="$infra_dir/../daily-stock-analysis/docker/Dockerfile"
  local target_file="$local_build_dir/dsa.Dockerfile"

  if [[ ! -f "$source_file" ]]; then
    printf 'DSA Dockerfile 不存在: %s\n' "$source_file" >&2
    return 1
  fi

  require_exact_line "$source_file" '# syntax=docker/dockerfile:1.7' 1 || return 1
  require_exact_line "$source_file" 'FROM node:20-slim AS web-builder' 1 || return 1
  require_exact_line "$source_file" 'FROM python:3.11-slim-bookworm' 1 || return 1
  require_exact_line "$source_file" 'RUN --mount=type=cache,target=/root/.npm npm ci' 1 || return 1
  require_exact_line "$source_file" 'RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \' 1 || return 1
  require_exact_line "$source_file" '    rm -f /etc/apt/apt.conf.d/docker-clean && \' 1 || return 1
  require_exact_line "$source_file" "    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \\" 0 || return 1
  require_exact_line "$source_file" '    apt-get update && apt-get install -y --no-install-recommends \' 1 || return 1
  require_exact_line "$source_file" '    libxext6 \' 1 || return 1
  require_exact_line "$source_file" '    && rm -rf /var/lib/apt/lists/*' 1 || return 1
  require_exact_line "$source_file" 'RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt' 1 || return 1

  awk -v sq="'" '
    $0 == "# syntax=docker/dockerfile:1.7" { next }
    $0 == "FROM node:20-slim AS web-builder" {
      print "FROM thesis-ledger-local-node:20-slim AS web-builder"
      next
    }
    $0 == "FROM python:3.11-slim-bookworm" {
      print "FROM thesis-ledger-local-python:3.11-slim-bookworm"
      next
    }
    $0 == "RUN --mount=type=cache,target=/root/.npm npm ci" {
      print "RUN --mount=type=cache,id=dsa-web-npm,target=/root/.npm,sharing=locked npm ci"
      next
    }
    $0 == "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\" {
      print "RUN --mount=type=cache,id=dsa-apt-archives,target=/var/cache/apt,sharing=locked \\"
      print "    --mount=type=cache,id=dsa-apt-lists,target=/var/lib/apt/lists,sharing=locked \\"
      next
    }
    $0 == "    rm -f /etc/apt/apt.conf.d/docker-clean && \\" {
      print
      print "    sed -i " sq "s|http://deb.debian.org|https://mirrors.aliyun.com|g" sq " /etc/apt/sources.list.d/debian.sources && \\"
      next
    }
    $0 == "    apt-get update && apt-get install -y --no-install-recommends \\" {
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 update && \\"
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 install -y --no-install-recommends \\"
      next
    }
    $0 == "    libxext6 \\" {
      print "    libxext6"
      next
    }
    $0 == "    && rm -rf /var/lib/apt/lists/*" { next }
    $0 == "RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt" {
      print "RUN --mount=type=cache,id=dsa-pip,target=/root/.cache/pip,sharing=locked pip install -r requirements.txt"
      next
    }
    { print }
  ' "$source_file" > "$target_file"
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
  require_exact_line "$source_file" 'COPY apps/server/package.json apps/server/package.json' 1 || return 1
  require_exact_line "$source_file" 'COPY patches ./patches' 1 || return 1
  require_exact_line "$source_file" 'RUN pnpm install --frozen-lockfile' 1 || return 1

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
    $0 == "RUN pnpm install --frozen-lockfile" {
      print "RUN --mount=type=cache,id=thesis-ledger-pnpm-store,target=/pnpm/store,sharing=locked \\"
      print "    pnpm config set store-dir /pnpm/store && \\"
      print "    pnpm install --frozen-lockfile"
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
    create_local_dsa_dockerfile || return 1
    printf '  dsa:\n    build:\n      dockerfile: %s\n' \
      "$local_build_dir/dsa.Dockerfile" >> "$local_compose_override"
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
  local -a build_args=(build)

  build_args+=("${app_services[@]}")

  "${compose_args[@]}" "${build_args[@]}" 2>&1 | tee "$build_log"
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

      printf '检测到 Docker 构建空间不足，按最小空闲空间 %s 清理未使用的 BuildKit cache...\n' \
        "$build_cache_min_free_space" >&2
      if ! docker builder prune --force --min-free-space "$build_cache_min_free_space"; then
        printf 'BuildKit cache 有界清理失败，无法进行重试。\n' >&2
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

  if ! create_local_build_override; then
    printf '本地临时构建定义生成失败；未拉取镜像，也未开始构建或启动。\n' >&2
    return 1
  fi

  printf '使用环境文件: %s\n' "$env_file"
  printf '更新目标: %s\n' "${app_services[*]}"

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
    printf '应用镜像构建失败，退出码: %s；现有 BuildKit cache 已保留。\n' "$exit_code" >&2
    print_status >&2
    printf '未自动停止其他进程，也未删除任何 Docker 数据卷。\n' >&2
    return "$exit_code"
  fi

  printf '启动目标服务: %s\n' "${app_services[*]}"
  if "${compose_args[@]}" up -d --no-build "${app_services[@]}"; then
    :
  else
    exit_code=$?
    report_runtime_failure 'Compose 启动' "$exit_code"
    return "$exit_code"
  fi

  for service in "${app_services[@]}"; do
    if wait_for_service "$service"; then
      :
    else
      exit_code=$?
      report_runtime_failure "服务健康检查（${service}）" "$exit_code"
      return "$exit_code"
    fi
  done

  printf '\n源码栈更新完成，当前状态:\n'
  "${compose_args[@]}" ps
}

run_update
