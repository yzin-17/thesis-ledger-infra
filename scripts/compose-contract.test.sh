#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"
compose_args=(
  docker compose
  --env-file "$infra_dir/.env.example"
  -f "$infra_dir/compose.yml"
  -f "$infra_dir/compose.dev.yml"
)

services="$("${compose_args[@]}" config --services)"
expected_services=$'backtest-worker\ndsa\npostgres\nredis\nthesis-ledger'
if [[ "$(printf '%s\n' "$services" | sort)" != "$(printf '%s\n' "$expected_services" | sort)" ]]; then
  printf 'Compose 服务集合异常：期望 postgres、redis、dsa、thesis-ledger、backtest-worker。\n' >&2
  printf '%s\n' "$services" >&2
  exit 1
fi
if ! rg -n -A35 '^  backtest-worker:' "$infra_dir/compose.yml" | rg -q 'backtest-worker-health\.js'; then
  printf 'Backtest Worker 未配置 Redis 心跳健康检查。\n' >&2
  exit 1
fi
if rg -n -A35 '^  backtest-worker:' "$infra_dir/compose.yml" | rg -q 'ports:'; then
  printf 'Backtest Worker 不得暴露业务端口。\n' >&2
  exit 1
fi
if ! rg -n -A40 '^  thesis-ledger:' "$infra_dir/compose.yml" | rg -q 'thesis-ledger-backtest-data:/app/var/backtest'; then
  printf 'ThesisLedger Server 未挂载共享回测 Snapshot 卷。\n' >&2
  exit 1
fi
if ! rg -n -A40 '^  backtest-worker:' "$infra_dir/compose.yml" | rg -q 'thesis-ledger-backtest-data:/app/var/backtest'; then
  printf 'Backtest Worker 未挂载共享回测 Snapshot 卷。\n' >&2
  exit 1
fi
if ! rg -n -A10 '^  thesis-ledger-backtest-data:' "$infra_dir/compose.yml" | rg -q 'external: true'; then
  printf '共享回测 Snapshot 卷必须声明为外部持久卷。\n' >&2
  exit 1
fi

if rg -n 'db-(role-validation|bootstrap|migrate|permission-hardening)' \
  "$infra_dir/compose.yml" "$infra_dir/compose.dev.yml"; then
  printf 'Compose 不得包含 db-* 初始化服务。\n' >&2
  exit 1
fi

if rg -n 'migration\.sql|bootstrap-app-role\.sql|POSTGRES_SCHEMA_VERSION' \
  "$infra_dir/compose.yml"; then
  printf 'PostgreSQL Compose 不得手工挂载 migration 或旧版 init marker。\n' >&2
  exit 1
fi
if ! rg -n -A16 '^  postgres:' "$infra_dir/compose.yml" | rg -q 'pg_isready'; then
  printf 'PostgreSQL healthcheck 必须只表达进程存活，业务结构由 update.sh 门禁负责。\n' >&2
  exit 1
fi
if ! rg -q 'dev-database-rebuild\.js' "$infra_dir/scripts/dev-database.sh"; then
  printf 'update.sh 未接入主仓数据库结构执行器。\n' >&2
  exit 1
fi
if ! rg -q 'DEV_DATABASE_MODE|DEV_DATABASE_ALLOW_DATA_LOSS|DEV_DATABASE_CONFIRM' "$infra_dir/scripts/dev-database.sh"; then
  printf 'update.sh 未声明数据库重建显式确认参数。\n' >&2
  exit 1
fi
if ! rg -q 'REVOKE UPDATE, DELETE ON TABLE %I FROM %I' "$infra_dir/scripts/bootstrap-app-role.sql"; then
  printf 'app role init SQL 未收紧 LedgerEvent UPDATE/DELETE。\n' >&2
  exit 1
fi
if ! rg -q 'REVOKE INSERT, UPDATE, DELETE ON TABLE %I FROM %I' "$infra_dir/scripts/bootstrap-app-role.sql"; then
  printf 'app role init SQL 未保护 SchemaVersion。\n' >&2
  exit 1
fi
if rg -n -A35 '^  thesis-ledger:' "$infra_dir/compose.yml" | rg -q 'POSTGRES_OWNER_USER'; then
  printf 'ThesisLedger 不得接收 owner 连接凭证。\n' >&2
  exit 1
fi
if ! rg -n -A35 '^  thesis-ledger:' "$infra_dir/compose.yml" | rg -q 'POSTGRES_APP_USER'; then
  printf 'ThesisLedger 必须接收 app role 连接串。\n' >&2
  exit 1
fi

run_stop_failure_case() {
  (
    set -euo pipefail
    source "$infra_dir/scripts/dev-database.sh"
    compose_args=(true)
    app_services=(thesis-ledger)
    database_mode=rebuild
    local_build_dir=/tmp
    stop_called=0
    gate_called=0
    service_is_selected() { return 0; }
    wait_for_service() { return 0; }
    stop_database_consumers() { stop_called=1; return 1; }
    run_database_structure_gate() { gate_called=1; return 0; }
    if prepare_database_for_update; then
      printf '停止消费者失败时不应继续数据库重建。\n' >&2
      exit 1
    fi
    if [[ "$stop_called" != 1 || "$gate_called" != 0 ]]; then
      printf '停止消费者失败后错误调用了破坏性 SQL。\n' >&2
      exit 1
    fi
  )
}

run_stop_failure_case

run_database_gate_failure_cases() {
  (
    set -euo pipefail
    source "$infra_dir/scripts/dev-database.sh"
    local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/thesis-ledger-gate-test.XXXXXX")"
    trap 'rm -rf "$local_build_dir"' EXIT
    compose_args=(fake_compose)
    database_name=thesis_ledger_test
    database_project=thesis-ledger-dev
    database_owner=thesis_owner_test
    psql_called=0
    fake_compose() {
      if [[ "$1" == run ]]; then return 1; fi
      if [[ "$1" == exec ]]; then psql_called=1; return 1; fi
    }
    if run_database_structure_gate check; then
      printf 'SQL 生成失败时不应通过结构 gate。\n' >&2
      exit 1
    fi
    if [[ "$psql_called" != 0 ]]; then
      printf 'SQL 生成失败后错误连接 PostgreSQL。\n' >&2
      exit 1
    fi

    fake_compose() {
      if [[ "$1" == run ]]; then printf 'SELECT 1;\n'; return 0; fi
      if [[ "$1" == exec ]]; then psql_called=1; return 1; fi
    }
    if run_database_structure_gate check; then
      printf 'psql 失败时不应通过结构 gate。\n' >&2
      exit 1
    fi
    if [[ "$psql_called" != 1 ]]; then
      printf 'psql 失败场景未执行 PostgreSQL gate。\n' >&2
      exit 1
    fi

    events=()
    app_services=(thesis-ledger)
    database_mode=check
    service_is_selected() { return 0; }
    fake_compose() { if [[ "$1" == up ]]; then events+=(up); fi; }
    wait_for_service() { events+=(wait); }
    run_database_structure_gate() { events+=(gate); return 1; }
    if prepare_database_for_update; then
      printf 'check gate 失败时不应继续。\n' >&2
      exit 1
    fi
    if [[ "${events[*]}" != 'up wait gate' ]]; then
      printf 'check gate 顺序异常: %s\n' "${events[*]}" >&2
      exit 1
    fi

    events=()
    up_calls=0
    database_mode=rebuild
    fake_compose() {
      if [[ "$1" == up ]]; then
        up_calls=$((up_calls + 1))
        if [[ "$up_calls" == 1 ]]; then events+=(postgres); else events+=(start); fi
      fi
    }
    wait_for_service() { events+=(wait); }
    stop_database_consumers() { events+=(stop); }
    run_database_structure_gate() { events+=(gate); return 0; }
    if ! prepare_database_for_update; then exit 1; fi
    if ! start_updated_services; then exit 1; fi
    if [[ "${events[*]}" != 'postgres wait stop gate start wait wait' ]]; then
      printf '成功启动顺序异常: %s\n' "${events[*]}" >&2
      exit 1
    fi
  )
}

run_database_gate_failure_cases

baseline_sql="$infra_dir/../thesis-ledger/apps/server/prisma/migrations/20260905000000_fresh_database_baseline/migration.sql"
role_sql="$infra_dir/scripts/bootstrap-app-role.sql"
run_init_failure_case() {
  local container_name="$1"
  local owner_user="$2"
  local app_user="$3"
  local state exit_code

  docker rm -fv "$container_name" >/dev/null 2>&1 || true
  if ! docker run -d \
    --name "$container_name" \
    -e POSTGRES_USER=thesis_owner_test \
    -e POSTGRES_PASSWORD=owner-secret-test \
    -e POSTGRES_DB=thesis_ledger_test \
    -e POSTGRES_OWNER_USER="$owner_user" \
    -e POSTGRES_APP_USER="$app_user" \
    -e POSTGRES_APP_PASSWORD=app-secret-test \
    -v "$baseline_sql:/docker-entrypoint-initdb.d/001-current-baseline.sql:ro" \
    -v "$role_sql:/docker-entrypoint-initdb.d/002-app-role.sql:ro" \
    postgres:17-alpine >/dev/null; then
    printf '无法启动角色校验临时容器: %s\n' "$container_name" >&2
    return 1
  fi

  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"
    if [[ "$state" == exited || "$state" == dead ]]; then
      exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_name")"
      if [[ "$exit_code" == 0 ]]; then
        docker logs "$container_name" >&2 || true
        docker rm -fv "$container_name" >/dev/null 2>&1 || true
        printf '角色校验本应失败但临时 init 成功: %s\n' "$container_name" >&2
        return 1
      fi
      docker rm -fv "$container_name" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
  done

  docker logs --tail 120 "$container_name" >&2 || true
  docker rm -fv "$container_name" >/dev/null 2>&1 || true
  printf '角色校验临时 init 超时: %s\n' "$container_name" >&2
  return 1
}

run_init_failure_case thesis-ledger-role-empty-20260902 '' thesis_app_test
run_init_failure_case thesis-ledger-role-same-20260902 thesis_owner_test thesis_owner_test

printf 'Compose fresh-only contract tests passed.\n'
