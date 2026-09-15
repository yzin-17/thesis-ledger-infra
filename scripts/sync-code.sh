#!/usr/bin/env bash
set -Eeuo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
thesis_ledger_dir="${THESIS_LEDGER_SOURCE_DIR:-$infra_dir/../thesis-ledger}"
dsa_dir="${DSA_SOURCE_DIR:-$infra_dir/../daily-stock-analysis}"

compose_args=()
selected_services=()
selected_container_ids=()
initial_image_ids=()
modified_services=()
sync_dsa=false
sync_thesis_ledger=false
health_timeout_seconds="${HEALTH_TIMEOUT_SECONDS:-120}"
work_dir=""
container_stage=""
deployment_started=false
rollback_attempted=false

print_usage() {
  cat <<'EOF'
用法: ./scripts/sync-code.sh [all|dsa|thesis-ledger]

只把当前源码构建产物同步到已运行容器的可写层，不构建、拉取或修改镜像。
默认目标为 all。可选环境参数：
  ENV_FILE                 Compose 环境文件
  HEALTH_TIMEOUT_SECONDS   健康检查超时秒数，默认 120
  CODE_SYNC_NPM_CACHE_DIR  DSA WebUI npm cache；默认使用当前用户的临时缓存目录

边界：
  - 依赖清单、Prisma 结构或 DSA requirements 与当前容器不一致时拒绝执行。
  - 更新会重启目标容器；容器重建后，本次同步会消失。
  - 需要更新依赖、数据库结构、系统包或镜像时，请使用 ./scripts/update.sh。
EOF
}

print_error() {
  printf '%s\n' "$1" >&2
}

container_id_for_service() {
  local expected_service="$1" index

  for ((index = 0; index < ${#selected_services[@]}; index += 1)); do
    if [[ "${selected_services[$index]}" == "$expected_service" ]]; then
      printf '%s' "${selected_container_ids[$index]}"
      return 0
    fi
  done

  return 1
}

cleanup_host_files() {
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    case "$work_dir" in
      "${TMPDIR:-/tmp}"/thesis-ledger-code-sync.*|/tmp/thesis-ledger-code-sync.*)
        rm -rf -- "$work_dir"
        ;;
      *)
        printf '跳过异常临时目录清理: %s\n' "$work_dir" >&2
        ;;
    esac
  fi
}

cleanup_container_staging() {
  local container_id

  if [[ -z "$container_stage" ]]; then
    return 0
  fi

  for container_id in "${selected_container_ids[@]}"; do
    docker exec -u 0 "$container_id" rm -rf -- "$container_stage" >/dev/null 2>&1 || true
  done
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + health_timeout_seconds))
  local container_id state health

  while ((SECONDS < deadline)); do
    container_id="$("${compose_args[@]}" ps -aq "$service" 2>/dev/null || true)"
    container_id="${container_id%%$'\n'*}"

    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"

      if [[ "$state" == running && ("$health" == healthy || "$health" == none) ]]; then
        printf '服务已就绪: %s (%s)\n' "$service" "$health"
        return 0
      fi

      if [[ "$state" == exited || "$state" == dead ]]; then
        printf '服务未能运行: %s (状态: %s)\n' "$service" "$state" >&2
        return 1
      fi
    fi

    sleep 2
  done

  printf '等待服务健康检查超时: %s (%ss)\n' "$service" "$health_timeout_seconds" >&2
  return 1
}

rollback_selected_services() {
  local service

  rollback_attempted=true
  if ((${#modified_services[@]} == 0)); then
    return 0
  fi
  printf '代码同步未完成，使用 Compose 当前指向的同一镜像重建目标容器...\n' >&2
  if ! "${compose_args[@]}" up -d --no-build --no-deps --force-recreate "${modified_services[@]}"; then
    print_error '同镜像容器回滚失败，请保留现场并执行完整 update.sh。'
    return 1
  fi

  for service in "${modified_services[@]}"; do
    if ! wait_for_service "$service"; then
      print_error "回滚后的服务未通过健康检查: $service"
      return 1
    fi
  done

  print_error '目标容器已恢复为镜像内代码；回滚未执行数据库结构或外部卷操作。'
}

handle_error() {
  local exit_code="$1"

  trap - ERR
  set +e
  if [[ "$deployment_started" == true && "$rollback_attempted" != true ]]; then
    rollback_selected_services || true
  fi
  cleanup_container_staging
  cleanup_host_files
  exit "$exit_code"
}

trap 'handle_error $?' ERR

parse_target() {
  local target="${1:-all}"

  if (($# > 1)); then
    print_usage >&2
    return 1
  fi

  case "$target" in
    all)
      sync_dsa=true
      sync_thesis_ledger=true
      selected_services=(dsa thesis-ledger backtest-worker)
      ;;
    dsa)
      sync_dsa=true
      selected_services=(dsa)
      ;;
    thesis-ledger)
      sync_thesis_ledger=true
      selected_services=(thesis-ledger backtest-worker)
      ;;
    -h|--help)
      print_usage
      return 2
      ;;
    *)
      printf '不支持的更新目标: %s\n' "$target" >&2
      print_usage >&2
      return 1
      ;;
  esac
}

init_environment() {
  local env_file_input="${ENV_FILE:-}" env_file

  if ! [[ "$health_timeout_seconds" =~ ^[0-9]+$ ]] || ((health_timeout_seconds < 1)); then
    print_error 'HEALTH_TIMEOUT_SECONDS 必须是大于 0 的整数。'
    return 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    print_error '未找到 Docker CLI，请先安装并启动 Docker Desktop。'
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    print_error '无法连接 Docker daemon，请先启动 Docker Desktop。'
    return 1
  fi
  if [[ "$sync_thesis_ledger" == true ]] && ! command -v pnpm >/dev/null 2>&1; then
    print_error '未找到 pnpm，无法在宿主机构建 ThesisLedger。'
    return 1
  fi
  if [[ "$sync_dsa" == true ]] && ! command -v npm >/dev/null 2>&1; then
    print_error '未找到 npm，无法在宿主机构建 DSA WebUI。'
    return 1
  fi

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
    return 1
  fi
  if [[ "$sync_thesis_ledger" == true && ! -f "$thesis_ledger_dir/apps/server/package.json" ]]; then
    printf 'ThesisLedger 源码目录无效: %s\n' "$thesis_ledger_dir" >&2
    return 1
  fi
  if [[ "$sync_dsa" == true && ! -f "$dsa_dir/requirements.txt" ]]; then
    printf 'DSA 源码目录无效: %s\n' "$dsa_dir" >&2
    return 1
  fi

  compose_args=(
    docker compose
    --env-file "$env_file"
    -f "$infra_dir/compose.yml"
    -f "$infra_dir/compose.dev.yml"
  )

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/thesis-ledger-code-sync.XXXXXX")"
  container_stage="/tmp/$(basename "$work_dir")"
}

preflight_containers() {
  local service container_id state image_id image_ref referenced_image_id

  for service in "${selected_services[@]}"; do
    container_id="$("${compose_args[@]}" ps -q "$service")"
    container_id="${container_id%%$'\n'*}"
    if [[ -z "$container_id" ]]; then
      printf '目标服务没有运行中的容器: %s；请先使用完整 update.sh 初始化。\n' "$service" >&2
      return 1
    fi

    state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    if [[ "$state" != running ]]; then
      printf '目标服务容器未运行: %s (%s)\n' "$service" "$state" >&2
      return 1
    fi

    image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
    image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
    referenced_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null || true)"
    if [[ -z "$referenced_image_id" || "$referenced_image_id" != "$image_id" ]]; then
      printf 'Compose 镜像引用已漂移: %s 当前容器=%s，引用=%s。\n' \
        "$service" "$image_id" "${referenced_image_id:-missing}" >&2
      print_error '为保证失败时能回到同一镜像，本次仅代码更新已拒绝。'
      return 1
    fi

    selected_container_ids+=("$container_id")
    initial_image_ids+=("$image_id")
  done
}

require_matching_file() {
  local source_file="$1" container_id="$2" container_file="$3" label="$4"
  local copied_file="$work_dir/preflight-${label//\//-}"

  if ! docker cp "$container_id:$container_file" "$copied_file" >/dev/null 2>&1; then
    printf '无法读取容器内兼容性基线: %s (%s)\n' "$label" "$container_file" >&2
    return 1
  fi
  if ! cmp -s "$source_file" "$copied_file"; then
    printf '%s 与当前容器不一致，不能仅同步代码。\n' "$label" >&2
    print_error '请使用 ./scripts/update.sh 更新依赖或运行时。'
    return 1
  fi
}

preflight_thesis_ledger_compatibility() {
  local container_id package package_path runtime_prisma_dir

  container_id="$(container_id_for_service thesis-ledger)"
  require_matching_file \
    "$thesis_ledger_dir/apps/server/package.json" \
    "$container_id" \
    /app/package.json \
    server-package.json

  for package in domain schemas shared; do
    package_path="$(docker exec "$container_id" readlink -f "/app/node_modules/@thesis-ledger/$package")"
    case "$package_path" in
      /app/node_modules/.pnpm/*/node_modules/@thesis-ledger/"$package") ;;
      *)
        printf '无法确认容器内 workspace 包路径: %s -> %s\n' "$package" "$package_path" >&2
        return 1
        ;;
    esac
    require_matching_file \
      "$thesis_ledger_dir/packages/$package/package.json" \
      "$container_id" \
      "$package_path/package.json" \
      "$package-package.json"
  done

  runtime_prisma_dir="$work_dir/runtime-prisma"
  mkdir -p "$runtime_prisma_dir"
  if ! docker cp "$container_id:/app/prisma/." "$runtime_prisma_dir/" >/dev/null 2>&1; then
    print_error '无法读取容器内 Prisma 结构基线。'
    return 1
  fi
  if ! diff -qr "$thesis_ledger_dir/apps/server/prisma" "$runtime_prisma_dir" >/dev/null; then
    print_error 'Prisma Schema、migration 或 raw-owned inventory 与当前容器不一致。'
    print_error '仅代码更新不会修改数据库；请使用 ./scripts/update.sh 执行结构门禁。'
    return 1
  fi
}

preflight_dsa_compatibility() {
  local container_id

  container_id="$(container_id_for_service dsa)"
  require_matching_file \
    "$dsa_dir/requirements.txt" \
    "$container_id" \
    /app/requirements.txt \
    dsa-requirements.txt
}

build_thesis_ledger_payload() {
  local package output_dir payload_dir="$work_dir/thesis-ledger-payload"

  printf '在宿主机构建 ThesisLedger Server 及其 workspace 依赖...\n'
  (
    cd "$thesis_ledger_dir"
    pnpm --filter @thesis-ledger/server... build
  )

  mkdir -p "$payload_dir"
  output_dir="$thesis_ledger_dir/apps/server/dist"
  if [[ ! -f "$output_dir/src/main.js" || ! -f "$output_dir/src/backtest/backtest-worker.main.js" ]]; then
    print_error 'ThesisLedger 构建未生成 Server/Worker 入口。'
    return 1
  fi
  mkdir -p "$payload_dir/server-dist"
  cp -R "$output_dir/." "$payload_dir/server-dist/"

  for package in domain schemas shared; do
    output_dir="$thesis_ledger_dir/packages/$package/dist"
    if [[ ! -f "$output_dir/index.js" ]]; then
      printf 'ThesisLedger 构建未生成 workspace 产物: %s\n' "$package" >&2
      return 1
    fi
    mkdir -p "$payload_dir/$package-dist"
    cp -R "$output_dir/." "$payload_dir/$package-dist/"
  done
}

hash_file() {
  local file="$1"

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    print_error '未找到 shasum 或 sha256sum，无法校验 DSA WebUI 锁文件。'
    return 1
  fi
}

build_dsa_payload() {
  local web_dir="$dsa_dir/apps/dsa-web"
  local lock_hash marker_file existing_hash revision payload_dir="$work_dir/dsa-payload"
  local source_dir source_file user_id npm_cache_dir

  if [[ ! -f "$web_dir/package-lock.json" ]]; then
    print_error 'DSA WebUI 缺少 package-lock.json。'
    return 1
  fi

  lock_hash="$(hash_file "$web_dir/package-lock.json")"
  marker_file="$web_dir/node_modules/.thesis-ledger-code-sync-lock.sha256"
  existing_hash=""
  if [[ -f "$marker_file" ]]; then
    existing_hash="$(<"$marker_file")"
  fi

  if [[ ! -x "$web_dir/node_modules/.bin/vite" || ! -x "$web_dir/node_modules/.bin/tsc" || "$existing_hash" != "$lock_hash" ]]; then
    printf 'DSA WebUI 依赖未就绪或锁文件已变化，执行 npm ci...\n'
    user_id="$(id -u)"
    npm_cache_dir="${CODE_SYNC_NPM_CACHE_DIR:-${TMPDIR:-/tmp}/thesis-ledger-code-sync-npm-cache-$user_id}"
    mkdir -p "$npm_cache_dir"
    (
      cd "$web_dir"
      npm_config_cache="$npm_cache_dir" npm ci
      printf '%s\n' "$lock_hash" > "$marker_file"
    )
  else
    printf '复用宿主机 DSA WebUI 依赖。\n'
  fi

  revision="$(git -C "$dsa_dir" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')"
  printf '在宿主机构建 DSA WebUI...\n'
  (
    cd "$web_dir"
    DSA_WEB_VERSION=thesisledger-dev \
      DSA_WEB_REVISION="code-sync-$revision" \
      npm run build -- --logLevel warn
  )

  if [[ ! -f "$dsa_dir/static/index.html" ]]; then
    print_error 'DSA WebUI 构建未生成 static/index.html。'
    return 1
  fi

  mkdir -p "$payload_dir/root"
  while IFS= read -r source_file; do
    cp "$source_file" "$payload_dir/root/"
  done < <(find "$dsa_dir" -maxdepth 1 -type f -name '*.py' -print | sort)
  if [[ ! -f "$payload_dir/root/main.py" ]]; then
    print_error 'DSA payload 缺少 main.py。'
    return 1
  fi

  for source_dir in api data_provider bot src strategies static; do
    if [[ ! -d "$dsa_dir/$source_dir" ]]; then
      printf 'DSA 源码目录缺失: %s\n' "$source_dir" >&2
      return 1
    fi
    mkdir -p "$payload_dir/$source_dir"
    cp -R "$dsa_dir/$source_dir/." "$payload_dir/$source_dir/"
  done
  find "$payload_dir" -type d -name __pycache__ -prune -exec rm -rf -- {} +
  find "$payload_dir" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
}

sync_thesis_ledger_container() {
  local service="$1" container_id package package_path
  local payload_dir="$work_dir/thesis-ledger-payload"
  local domain_path schemas_path shared_path

  container_id="$(container_id_for_service "$service")"
  for package in domain schemas shared; do
    package_path="$(docker exec "$container_id" readlink -f "/app/node_modules/@thesis-ledger/$package")"
    case "$package_path" in
      /app/node_modules/.pnpm/*/node_modules/@thesis-ledger/"$package") ;;
      *)
        printf '同步前 workspace 包路径校验失败: %s -> %s\n' "$package" "$package_path" >&2
        return 1
        ;;
    esac
    case "$package" in
      domain) domain_path="$package_path" ;;
      schemas) schemas_path="$package_path" ;;
      shared) shared_path="$package_path" ;;
    esac
  done

  docker exec -u 0 "$container_id" mkdir -p "$container_stage"
  docker cp "$payload_dir/." "$container_id:$container_stage/"
  docker exec -i -u 0 "$container_id" sh -s \
    "$container_stage" "$domain_path" "$schemas_path" "$shared_path" <<'CONTAINER_SCRIPT'
set -eu
stage="$1"
domain_path="$2"
schemas_path="$3"
shared_path="$4"

replace_dir() {
  source_dir="$1"
  target_dir="$2"
  backup_dir="${target_dir}.code-sync-old"

  test -d "$source_dir"
  rm -rf -- "$backup_dir"
  if [ -e "$target_dir" ]; then
    mv "$target_dir" "$backup_dir"
  fi
  if ! mv "$source_dir" "$target_dir"; then
    if [ -e "$backup_dir" ]; then
      mv "$backup_dir" "$target_dir"
    fi
    return 1
  fi
  rm -rf -- "$backup_dir"
}

replace_dir "$stage/server-dist" /app/apps/server/dist
printf '容器内已替换 Server dist。\n'
replace_dir "$stage/domain-dist" "$domain_path/dist"
printf '容器内已替换 domain dist。\n'
replace_dir "$stage/schemas-dist" "$schemas_path/dist"
printf '容器内已替换 schemas dist。\n'
replace_dir "$stage/shared-dist" "$shared_path/dist"
printf '容器内已替换 shared dist。\n'
rm -rf -- "$stage"
CONTAINER_SCRIPT
}

sync_dsa_container() {
  local container_id payload_dir="$work_dir/dsa-payload"

  container_id="$(container_id_for_service dsa)"
  docker exec -u 0 "$container_id" mkdir -p "$container_stage"
  docker cp "$payload_dir/." "$container_id:$container_stage/"
  docker exec -i -u 0 "$container_id" sh -s "$container_stage" <<'CONTAINER_SCRIPT'
set -eu
stage="$1"
root_backup="$stage/root-backup"

replace_dir() {
  source_dir="$1"
  target_dir="$2"
  backup_dir="${target_dir}.code-sync-old"

  test -d "$source_dir"
  rm -rf -- "$backup_dir"
  if [ -e "$target_dir" ]; then
    mv "$target_dir" "$backup_dir"
  fi
  if ! mv "$source_dir" "$target_dir"; then
    if [ -e "$backup_dir" ]; then
      mv "$backup_dir" "$target_dir"
    fi
    return 1
  fi
  rm -rf -- "$backup_dir"
}

mkdir -p "$root_backup"
printf '容器内开始替换 DSA 根目录 Python 文件。\n'
for source_file in /app/*.py; do
  if [ -f "$source_file" ]; then
    if ! mv "$source_file" "$root_backup/"; then
      printf '移动现有 DSA Python 文件失败: %s\n' "$source_file" >&2
      exit 1
    fi
  fi
done
for source_file in "$stage"/root/*.py; do
  if [ ! -f "$source_file" ]; then
    printf 'DSA 同步暂存区没有 Python 文件: %s\n' "$stage/root" >&2
    find "$stage" -maxdepth 2 -type f -print >&2 || true
    exit 1
  fi
  if ! mv "$source_file" /app/; then
    printf '安装 DSA Python 文件失败: %s\n' "$source_file" >&2
    exit 1
  fi
done
printf '容器内已替换 DSA 根目录 Python 文件。\n'

for entry_name in api data_provider bot src strategies static; do
  replace_dir "$stage/$entry_name" "/app/$entry_name"
  printf '容器内已替换 DSA 目录: %s\n' "$entry_name"
done

chown -R dsa:dsa /app/*.py /app/api /app/data_provider /app/bot /app/src /app/strategies /app/static
rm -rf -- "$stage"
CONTAINER_SCRIPT
}

restart_and_wait() {
  local service

  printf '重启目标容器: %s\n' "${selected_services[*]}"
  "${compose_args[@]}" restart "${selected_services[@]}"
  for service in "${selected_services[@]}"; do
    wait_for_service "$service"
  done
}

verify_image_ids_unchanged() {
  local index service container_id image_id

  for ((index = 0; index < ${#selected_services[@]}; index += 1)); do
    service="${selected_services[$index]}"
    container_id="$("${compose_args[@]}" ps -q "$service")"
    container_id="${container_id%%$'\n'*}"
    if [[ -z "$container_id" ]]; then
      printf '镜像核对时找不到目标容器: %s\n' "$service" >&2
      return 1
    fi
    image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
    if [[ "$image_id" != "${initial_image_ids[$index]}" ]]; then
      printf '目标容器镜像 ID 发生变化: %s，更新前=%s，更新后=%s\n' \
        "$service" "${initial_image_ids[$index]}" "$image_id" >&2
      return 1
    fi
    printf '镜像保持不变: %s (%s)\n' "$service" "$image_id"
  done
}

main() {
  local parse_result=0

  parse_target "$@" || parse_result=$?
  if ((parse_result == 2)); then
    return 0
  fi
  if ((parse_result != 0)); then
    return "$parse_result"
  fi

  init_environment
  preflight_containers

  if [[ "$sync_thesis_ledger" == true ]]; then
    preflight_thesis_ledger_compatibility
  fi
  if [[ "$sync_dsa" == true ]]; then
    preflight_dsa_compatibility
  fi

  printf '仅代码更新目标: %s\n' "${selected_services[*]}"
  if [[ "$sync_thesis_ledger" == true ]]; then
    build_thesis_ledger_payload
  fi
  if [[ "$sync_dsa" == true ]]; then
    build_dsa_payload
  fi

  deployment_started=true
  if [[ "$sync_dsa" == true ]]; then
    printf '同步 DSA Python 与 WebUI 产物...\n'
    modified_services+=(dsa)
    sync_dsa_container
  fi
  if [[ "$sync_thesis_ledger" == true ]]; then
    printf '同步 ThesisLedger Server 产物...\n'
    modified_services+=(thesis-ledger)
    sync_thesis_ledger_container thesis-ledger
    printf '同步 ThesisLedger Backtest Worker 产物...\n'
    modified_services+=(backtest-worker)
    sync_thesis_ledger_container backtest-worker
  fi

  restart_and_wait
  verify_image_ids_unchanged
  deployment_started=false

  cleanup_container_staging
  cleanup_host_files
  printf '\n仅代码更新完成：目标容器已使用当前源码，镜像 ID 保持不变。\n'
  printf '脚本未执行数据库结构或外部卷变更操作。\n'
  printf '本次更新位于容器可写层；容器重建后将恢复为镜像内代码。\n'
}

main "$@"
