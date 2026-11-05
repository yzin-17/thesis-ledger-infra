#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/reinstall-preserving-volumes.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
fail() { printf '失败：%s\n' "$*" >&2; exit 1; }
reset_case() {
  infra_dir="$test_dir" local_build_dir="$test_dir/build"
  build_space_lock="$test_dir/lock" build_space_builder=desktop-linux
  mkdir -p "$build_space_lock" "$local_build_dir"
  printf '%s\n' "$$" > "$build_space_lock/pid"
  : > "$test_dir/trace"
  compose_args=(docker compose) target=thesis-ledger app_services=(thesis-ledger)
  rollback_protected_image_ids=(old) build_space_dsa_image_id=''
  build_host_available_kib=2000000 build_docker_available_kib=5000000
  test_fault=''
  build_space_reinstalled=false
}
record() { printf '%s\n' "$*" >> "$test_dir/trace"; [[ "$*" != "$test_fault" ]]; }
docker() {
  record "$*" || return 1
  case "$*" in
    'compose config --format json') printf '{"name":"thesis-ledger-dev","services":{}}\n' ;;
    'compose stop'|'compose down') ;;
    *) fail "未声明命令：$*" ;;
  esac
}
node() {
  if [[ "$1" == *docker-reinstall-plan.mjs ]]; then
    cat >/dev/null
    record plan || return 1
    printf '{"services":{},"volumes":{},"x-thesis-ledger-recovery":{"volumeNames":["anonymous"]}}\n'
  else record verify-volumes; fi
}
require_idle_builder() { record idle; }
prune_unused_build_cache() { record prune-cache; }
repair_docker_image_space() { record "repair-images $*"; }
reclaim_docker_desktop_space() { record reclaim; }
measure_build_space() { record measure; }
create_local_build_override() { record override; }
prepare_longbridge_build_source() { record sdk; }
prepare_base_images() { record bases; }

reset_case
reinstall_preserving_volumes >/dev/null || fail '保卷恢复失败'
[[ "$target" == all && "${app_services[*]}" == 'dsa thesis-ledger' ]] || fail '未扩大恢复范围'
[[ "${#rollback_protected_image_ids[@]}" == 0 ]] || fail '旧镜像仍被隐式保留'
[[ -f "$build_space_recovery_file" ]] || fail '恢复挂载未持久保存'
[[ "${compose_args[*]}" == *"-f $build_space_recovery_file"* ]] || fail '恢复挂载未接入'
if grep -Eq 'down .*-[^-]*v|volume (rm|prune)|system prune' "$test_dir/trace"; then fail '出现卷删除'; fi
awk '/^plan$/ {p=1} /^docker/ {next} /^compose stop$/ {if (!p) exit 1; s=1}
 /^compose down$/ {if (!s) exit 1; d=1} /^verify-volumes$/ {if (!d) exit 1; v=1}
 /^repair-images/ {if (!v) exit 1; i=1} /^bases$/ {if (!i) exit 1}' "$test_dir/trace" || fail '副作用顺序错误'

for fault in plan 'compose stop' 'compose down' verify-volumes prune-cache 'repair-images all-unused' bases; do
  reset_case
  test_fault="$fault"
  if reinstall_preserving_volumes >/dev/null 2>&1; then fail "$fault 未阻止恢复"; fi
  if [[ "$fault" == plan ]]; then
    if grep -q 'compose stop' "$test_dir/trace"; then fail '计划失败仍停止容器'; fi
  else
    [[ -f "$infra_dir/.maintenance-backups/docker-space-recovery/compose.json" ]] || fail '失败遗失恢复文件'
  fi
done
reset_case
printf 'other\n' > "$build_space_lock/pid"
if reinstall_preserving_volumes >/dev/null 2>&1; then fail '借用其他更新锁'; fi
[[ ! -s "$test_dir/trace" ]] || fail '未持锁仍操作Docker'
printf '保卷恢复编排、挂载持久化、全部目标重建、失败停止与锁验证通过。\n'
