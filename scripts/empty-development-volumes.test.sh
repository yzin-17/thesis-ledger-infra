#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/empty-development-volumes.sh"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
database_project=thesis-ledger-dev database_name=thesis_ledger
compose_args=(docker compose)
fail() { printf '%s\n' "$*" >&2; exit 1; }
docker() {
  printf '%s\n' "$*" >> "$root/trace"
  local name="${@: -1}"
  case "$*" in
    'volume inspect --format '*) [[ -f "$root/$name" ]] || return 1; cat "$root/$name" ;;
    'volume inspect '*) [[ -f "$root/$name" ]] ;;
    'volume create '*) printf true > "$root/$name" ;;
    'ps -aq') printf '%s' "${test_containers:-}" ;;
    'volume ls -q') printf '%s\n' "${test_existing:-}" ;;
    'compose config --format json') printf '%s' '{"volumes":{"thesis-ledger-postgres-data":{"name":"thesis-ledger-postgres-data","external":true},"thesis-ledger-redis-data":{"name":"thesis-ledger-redis-data","external":true},"thesis-ledger-dsa-data":{"name":"thesis-ledger-dsa-data","external":true},"thesis-ledger-backtest-data":{"name":"thesis-ledger-backtest-data","external":true}}}' ;;
    *) fail "未声明调用 $*" ;;
  esac
}
initialize_empty_development_volumes
[[ ! -e "$root/trace" ]] || fail '缺省执行了 Docker 操作'
INITIALIZE_EMPTY_DEV_VOLUMES=true EMPTY_DEV_CONFIRM=wrong
if initialize_empty_development_volumes >/dev/null 2>&1; then fail '错误确认值放行'; fi
EMPTY_DEV_CONFIRM=thesis-ledger-dev/thesis_ledger
test_containers=existing
if initialize_empty_development_volumes >/dev/null 2>&1; then fail '已有容器放行'; fi
test_containers='' test_existing=other-volume
if initialize_empty_development_volumes >/dev/null 2>&1; then fail '其他卷放行'; fi
test_existing=thesis-ledger-dsa-data
printf false > "$root/thesis-ledger-dsa-data"
if initialize_empty_development_volumes >/dev/null 2>&1; then fail '未标记现有卷放行'; fi
printf true > "$root/thesis-ledger-dsa-data"
initialize_empty_development_volumes >/dev/null
[[ "$(rg -c 'volume create' "$root/trace")" == 3 ]] || fail '部分重试未准确创建缺失卷'
before="$(wc -l < "$root/trace")"
initialize_empty_development_volumes >/dev/null
[[ "$(rg -c 'volume create' "$root/trace")" == 3 ]] || fail '已有完整集合重复创建'
printf '空开发卷确认、非空拒绝、部分重试及完整集合保留回归通过。\n'
