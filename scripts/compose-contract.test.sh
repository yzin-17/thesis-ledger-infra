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

if ! rg -q '001-current-baseline\.sql' "$infra_dir/compose.yml"; then
  printf 'PostgreSQL 未挂载 current baseline init SQL。\n' >&2
  exit 1
fi
if ! rg -q '002-market-bar-upstream-source\.sql' "$infra_dir/compose.yml"; then
  printf 'PostgreSQL 未挂载 MarketBar 增量 SQL。\n' >&2
  exit 1
fi
if ! rg -q '003-backtest-bullmq-lifecycle\.sql' "$infra_dir/compose.yml"; then
  printf 'PostgreSQL 未挂载 Backtest BullMQ 生命周期 SQL。\n' >&2
  exit 1
fi
if ! rg -q '004-backtest-v2-runs\.sql' "$infra_dir/compose.yml"; then
  printf 'PostgreSQL 未挂载 Backtest V2 Run SQL。\n' >&2
  exit 1
fi
if ! rg -q '999-app-role\.sql' "$infra_dir/compose.yml"; then
  printf 'PostgreSQL 未挂载 app role init SQL。\n' >&2
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
