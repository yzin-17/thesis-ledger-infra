#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_args=()

print_status() {
  if ((${#compose_args[@]} > 0)); then
    "${compose_args[@]}" ps -a || true
  fi
}

on_error() {
  local exit_code=$?
  trap - ERR
  printf '镜像更新或服务启动失败，退出码: %s\n' "$exit_code" >&2
  print_status >&2
  printf '未自动停止其他进程，也未删除任何 Docker 数据卷。\n' >&2
  exit "$exit_code"
}

trap on_error ERR

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

printf '使用环境文件: %s\n' "$env_file"

if [[ "$pull_service_images" == true ]]; then
  printf '拉取 PostgreSQL 和 Redis 服务镜像...\n'
  "${compose_args[@]}" pull postgres redis
fi

printf '重建 dsa、thesis-ledger 镜像...\n'
if [[ "$pull_base_images" == true ]]; then
  "${compose_args[@]}" build --pull dsa thesis-ledger
else
  "${compose_args[@]}" build dsa thesis-ledger
fi

printf '启动源码栈...\n'
"${compose_args[@]}" up -d --no-build

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
        docker logs --tail 80 "$container_id" >&2 || true
        return 1
      fi
    fi

    sleep 2
  done

  printf '等待服务健康检查超时: %s (%ss)\n' "$service" "$health_timeout_seconds" >&2
  return 1
}

for service in postgres redis dsa thesis-ledger; do
  wait_for_service "$service"
done

printf '\n源码栈更新完成，当前状态:\n'
"${compose_args[@]}" ps
