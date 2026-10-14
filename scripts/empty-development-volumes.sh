#!/usr/bin/env bash

# 由 update.sh 在更新锁与空间门禁后调用；不删除或覆盖任何卷。
initialize_empty_development_volumes() {
  [[ "${INITIALIZE_EMPTY_DEV_VOLUMES:-false}" == true ]] || return 0
  if [[ "$database_project/$database_name" != 'thesis-ledger-dev/thesis_ledger' ||
        "${EMPTY_DEV_CONFIRM:-}" != "$database_project/$database_name" ]]; then
    printf '空开发卷初始化需要精确确认 thesis-ledger-dev/thesis_ledger。\n' >&2
    return 1
  fi
  local names=(thesis-ledger-postgres-data thesis-ledger-redis-data thesis-ledger-dsa-data thesis-ledger-backtest-data)
  local missing=0 name existing containers owned configured
  for name in "${names[@]}"; do
    docker volume inspect "$name" >/dev/null 2>&1 || missing=$((missing + 1))
  done
  ((missing > 0)) || return 0
  containers="$(docker ps -aq)" || return 1
  [[ -z "$containers" ]] || { printf '空开发卷初始化拒绝已有容器的环境。\n' >&2; return 1; }
  configured="$("${compose_args[@]}" config --format json | node --input-type=module -e '
let text = ""; process.stdin.on("data", value => text += value); process.stdin.on("end", () => {
  const volumes = JSON.parse(text).volumes; const expected = ["thesis-ledger-postgres-data", "thesis-ledger-redis-data", "thesis-ledger-dsa-data", "thesis-ledger-backtest-data"];
  if (!volumes || Object.keys(volumes).length !== 4 || expected.some(name => volumes[name]?.name !== name || volumes[name]?.external !== true)) process.exit(1);
  process.stdout.write("verified");
});')" || return 1
  [[ "$configured" == verified ]] || return 1
  existing="$(docker volume ls -q)" || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    case "$name" in
      thesis-ledger-postgres-data|thesis-ledger-redis-data|thesis-ledger-dsa-data|thesis-ledger-backtest-data) ;;
      *) printf '空开发卷初始化发现其他现有卷，停止。\n' >&2; return 1 ;;
    esac
    owned="$(docker volume inspect --format '{{index .Labels "thesis-ledger.empty-development"}}' "$name")" || return 1
    [[ "$owned" == true ]] || { printf '部分现有卷不属于本入口初始化，停止。\n' >&2; return 1; }
  done <<< "$existing"
  for name in "${names[@]}"; do
    if ! docker volume inspect "$name" >/dev/null 2>&1; then
      docker volume create --label thesis-ledger.empty-development=true "$name" || return 1
    fi
  done
  printf '已初始化空开发环境的四个配置卷；数据库仍需通过完整结构检查。\n'
}
