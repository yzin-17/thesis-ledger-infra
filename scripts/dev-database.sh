#!/usr/bin/env bash

# 本文件由 update.sh 引入，负责开发数据库结构预检和重建生命周期。

database_sql_file=""
database_mode=""
database_name=""
database_project=""
database_owner=""

print_status() {
  if ((${#compose_args[@]} > 0)); then
    "${compose_args[@]}" ps -a || true
  fi
}

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

print_database_usage() {
  cat <<'EOF'
  DEV_DATABASE_MODE                 默认 check；upgrade 保留数据增量升级；rebuild 重建 public schema
  DEV_DATABASE_ALLOW_DATA_LOSS      重建必须显式设为 true
  DEV_DATABASE_CONFIRM              upgrade/rebuild 确认值：Compose 项目名/<数据库名>
  DATABASE_UPGRADE_BACKUP_ROOT       升级备份目录，默认 infra/.database-upgrades；必须为绝对路径
EOF
}

cleanup_database_sql() {
  if [[ -n "$database_sql_file" ]]; then
    rm -f "$database_sql_file"
  fi
}

init_database_update() {
  local config_json

  database_mode="${DEV_DATABASE_MODE:-check}"
  case "$database_mode" in
    check|rebuild|upgrade) ;;
    *) printf 'DEV_DATABASE_MODE 必须是 check、upgrade 或 rebuild。\n' >&2; return 1 ;;
  esac

  if ! config_json="$("${compose_args[@]}" config --format json)"; then
    printf '无法解析 Compose 配置。\n' >&2
    return 1
  fi
  if ! database_name="$(printf '%s' "$config_json" | node --input-type=module -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const value = JSON.parse(input).services?.postgres?.environment?.POSTGRES_DB;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
});
')"; then
    printf '无法从 Compose 解析 PostgreSQL 数据库名。\n' >&2
    return 1
  fi
  if ! database_project="$(printf '%s' "$config_json" | node --input-type=module -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const value = JSON.parse(input).name;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
});
')"; then
    printf '无法从 Compose 解析项目名。\n' >&2
    return 1
  fi
  if ! database_owner="$(printf '%s' "$config_json" | node --input-type=module -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const value = JSON.parse(input).services?.postgres?.environment?.POSTGRES_USER;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
});
')"; then
    printf '无法从 Compose 解析 PostgreSQL owner。\n' >&2
    return 1
  fi

  if [[ "$database_mode" == rebuild || "$database_mode" == upgrade ]]; then
    if [[ "$target" != all && "$target" != thesis-ledger ]]; then
      printf '数据库升级或重建需要选择 thesis-ledger 或 all 更新目标。\n' >&2
      return 1
    fi
    if [[ "$database_mode" == rebuild && "${DEV_DATABASE_ALLOW_DATA_LOSS:-}" != true ]]; then
      printf 'DEV_DATABASE_ALLOW_DATA_LOSS=true 是重建数据库的必需确认。\n' >&2
      return 1
    fi
    local expected_database_confirm="$database_project/$database_name"
    if [[ "${DEV_DATABASE_CONFIRM:-}" != "$expected_database_confirm" ]]; then
      printf 'DEV_DATABASE_CONFIRM 必须精确匹配 %s。\n' "$expected_database_confirm" >&2
      return 1
    fi
  fi
}

run_database_structure_gate() {
  local mode="$1" exit_code

  if [[ -z "$local_build_dir" ]]; then
    local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/thesis-ledger-update.XXXXXX")"
  fi
  database_sql_file="$local_build_dir/database-${mode}.sql"
  printf '生成数据库结构 SQL（模式: %s）...\n' "$mode"
  if "${compose_args[@]}" run --rm --no-deps -T \
    -e NODE_ENV=development \
    -e DEV_DATABASE_MODE="$mode" \
    -e DEV_DATABASE_ALLOW_DATA_LOSS="${DEV_DATABASE_ALLOW_DATA_LOSS:-}" \
    -e DEV_DATABASE_CONFIRM="${DEV_DATABASE_CONFIRM:-}" \
    -e DEV_DATABASE_PROJECT="$database_project" \
    -e DEV_DATABASE_EXPECTED_DATABASE="$database_name" \
    -e DEV_DATABASE_EXPECTED_OWNER="$database_owner" \
    -e DEV_DATABASE_PERMISSIONS_SQL=/tmp/bootstrap-app-role.sql \
    -v "$infra_dir/scripts/bootstrap-app-role.sql:/tmp/bootstrap-app-role.sql:ro" \
    thesis-ledger node apps/server/dist/src/platform/dev-database-rebuild.js > "$database_sql_file"; then
    :
  else
    exit_code=$?
    printf '数据库结构 SQL 生成失败，未连接或修改数据库。\n' >&2
    return "$exit_code"
  fi

  printf '校验 PostgreSQL 业务结构...\n'
  if "${compose_args[@]}" exec -T postgres sh -c \
    'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' < "$database_sql_file"; then
    return 0
  else
    exit_code=$?
    printf '数据库结构校验失败；新版应用不会启动。\n' >&2
    return "$exit_code"
  fi
}

prepare_database_for_update() {
  if ! service_is_selected thesis-ledger; then
    return 0
  fi
  if ! "${compose_args[@]}" up -d --no-build postgres; then
    printf 'PostgreSQL 启动失败；未停止数据库消费者。\n' >&2
    return 1
  fi
  if ! wait_for_service postgres; then
    printf 'PostgreSQL 存活检查失败；未停止数据库消费者。\n' >&2
    return 1
  fi
  if [[ "$database_mode" == upgrade ]]; then
    if ! stop_database_consumers || ! run_preserving_database_upgrade; then
      printf '保留数据升级未完成；应用消费者保持停止。\n' >&2
      return 1
    fi
  elif [[ "$database_mode" == rebuild ]]; then
    if ! stop_database_consumers; then
      printf '数据库消费者未能全部停止；跳过数据库重建。\n' >&2
      return 1
    fi
    if ! run_database_structure_gate rebuild; then
      printf '数据库重建失败；应用消费者保持停止。\n' >&2
      return 1
    fi
  elif ! run_database_structure_gate check; then
    printf '默认检查模式拒绝启动新版应用；可使用 DEV_DATABASE_MODE=upgrade 并完成目标确认及备份演练。\n' >&2
    return 1
  fi
}

stop_database_consumers() {
  printf '停止数据库消费者: thesis-ledger backtest-worker\n'
  "${compose_args[@]}" stop thesis-ledger backtest-worker
}

start_updated_services() {
  local exit_code service

  start_services=("${app_services[@]}")
  if service_is_selected thesis-ledger; then
    start_services+=(backtest-worker)
  fi
  printf '启动目标服务: %s\n' "${start_services[*]}"
  if "${compose_args[@]}" up -d --no-build "${start_services[@]}"; then
    :
  else
    exit_code=$?
    report_runtime_failure 'Compose 启动' "$exit_code"
    return "$exit_code"
  fi

  for service in "${start_services[@]}"; do
    if wait_for_service "$service"; then
      :
    else
      exit_code=$?
      report_runtime_failure "服务健康检查（${service}）" "$exit_code"
      return "$exit_code"
    fi
  done
}
