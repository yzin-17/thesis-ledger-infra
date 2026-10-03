#!/usr/bin/env bash

# 由官方 update.sh 调用；备份目录独立于构建临时目录，失败时也保留。
run_preserving_database_upgrade() {
  local run_dir postgres_id server_id worker_id consumers_json container_id
  local backup_root="${DATABASE_UPGRADE_BACKUP_ROOT:-$infra_dir/.database-upgrades}"
  if [[ "$backup_root" != /* ]]; then
    printf 'DATABASE_UPGRADE_BACKUP_ROOT 必须是绝对路径。\n' >&2
    return 1
  fi
  command -v pnpm >/dev/null || { printf '保留数据升级需要宿主机 pnpm 和主仓已安装依赖。\n' >&2; return 1; }
  mkdir -p "$backup_root" || return 1
  run_dir="$(mktemp -d "$backup_root/run.XXXXXX")" || return 1
  chmod 700 "$run_dir" || return 1
  printf '数据库升级备份与证据目录: %s\n' "$run_dir"
  postgres_id="$("${compose_args[@]}" ps -aq postgres)" || return 1
  server_id="$("${compose_args[@]}" ps -aq thesis-ledger)" || return 1
  worker_id="$("${compose_args[@]}" ps -aq backtest-worker)" || return 1
  # 每个服务必须精确对应一个现有容器，缺失或多副本不作猜测。
  for container_id in "$postgres_id" "$server_id" "$worker_id"; do
    if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
      printf '数据库升级需要 PostgreSQL、Server、Worker 的唯一完整容器 ID。\n' >&2
      return 1
    fi
  done
  consumers_json="[\"$server_id\",\"$worker_id\"]"
  if ! "${compose_args[@]}" run --rm --no-deps -T thesis-ledger \
    node apps/server/dist/src/platform/database-upgrade-export.js > "$run_dir/image-input.json"; then
    printf '读取待部署镜像的结构输入失败。\n' >&2
    return 1
  fi
  if ! DATABASE_UPGRADE_RUN_DIR="$run_dir" DATABASE_UPGRADE_CONTAINER="$postgres_id" \
    DATABASE_UPGRADE_CONSUMERS="$consumers_json" DEV_DATABASE_EXPECTED_DATABASE="$database_name" \
    DEV_DATABASE_EXPECTED_OWNER="$database_owner" DEV_DATABASE_PERMISSIONS_SQL="$infra_dir/scripts/bootstrap-app-role.sql" \
    pnpm --dir "$infra_dir/../thesis-ledger" --filter @thesis-ledger/server exec tsx src/platform/database-upgrade-prepare.ts; then
    return 1
  fi
  # 只执行本次受信准备过程生成的事务 SQL，不接受用户提供的演练成功标志。
  if ! "${compose_args[@]}" exec -T postgres sh -c \
    'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' \
    < "$run_dir/upgrade.sql" > /dev/null 2>&1; then
    printf '事务执行失败；原始 SQL 错误输出未保存。\n' > "$run_dir/execute.log"
    printf '数据库增量事务失败，消费者保持停止；证据位于 %s。\n' "$run_dir" >&2
    return 1
  fi
  printf '事务执行成功。\n' > "$run_dir/execute.log"
  run_database_structure_gate check
}
