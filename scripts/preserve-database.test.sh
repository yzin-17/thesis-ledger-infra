#!/usr/bin/env bash
set -euo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$infra_dir/scripts/dev-database.sh"
compose_mock() {
  printf '%s\n' '{"name":"fixture","services":{"postgres":{"environment":{"POSTGRES_DB":"ledger","POSTGRES_USER":"owner"}}}}'
}
compose_args=(compose_mock)
target=thesis-ledger
export DEV_DATABASE_MODE=upgrade DEV_DATABASE_CONFIRM=fixture/ledger
unset DEV_DATABASE_ALLOW_DATA_LOSS
init_database_update
DEV_DATABASE_CONFIRM=wrong
if init_database_update 2>/dev/null; then exit 1; fi
DEV_DATABASE_CONFIRM=fixture/ledger
target=dsa
if init_database_update 2>/dev/null; then exit 1; fi
target=thesis-ledger
DEV_DATABASE_MODE=rebuild
if init_database_update 2>/dev/null; then exit 1; fi
DEV_DATABASE_MODE=check
init_database_update
database_mode=upgrade
service_is_selected() { return 0; }
wait_for_service() { return 0; }
calls=()
stop_database_consumers() { calls+=(stop); return 1; }
run_preserving_database_upgrade() { calls+=(upgrade); }
if prepare_database_for_update >/dev/null 2>&1; then exit 1; fi
[[ "${calls[*]}" == stop ]]
calls=()
stop_database_consumers() { calls+=(stop); }
run_preserving_database_upgrade() { calls+=(upgrade); return 1; }
if prepare_database_for_update >/dev/null 2>&1; then exit 1; fi
[[ "${calls[*]}" == 'stop upgrade' ]]
calls=()
run_preserving_database_upgrade() { calls+=(upgrade); }
prepare_database_for_update >/dev/null
[[ "${calls[*]}" == 'stop upgrade' ]]
printf '数据库升级模式、目标确认及停止失败边界通过。\n'
