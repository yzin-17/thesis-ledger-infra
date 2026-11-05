#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/build-space-lifecycle.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
fail() { printf '失败：%s\n' "$*" >&2; exit 1; }
reset_case() {
  : > "$test_dir/trace"
  repair_build_cache=true build_space_builder=desktop-linux build_space_rollback_keep_count=0
  rollback_protected_image_ids=(old)
  test_sufficient=false test_idle=true test_failure='' test_deleted=0
}
record() { printf '%s\n' "$*" >> "$test_dir/trace"; [[ "$test_failure" != "$*" ]]; }
require_idle_builder() { [[ "$test_idle" == true ]]; }
docker() { record "$*"; }
maintain_build_cache() { record cache; }
measure_build_space() { record measure; }
build_space_sufficient() { [[ "$test_sufficient" == true ]]; }
repair_docker_image_space() {
  [[ "${#rollback_protected_image_ids[@]}" == 0 ]] || fail '健康后旧基线未释放'
  [[ "$ROLLBACK_IMAGE_KEEP_COUNT" == 0 ]] || fail '紧张期保留目标未传入'
  record retire || return 1
  if ((test_deleted == 1)); then return 2; fi
  test_deleted=$((test_deleted+1))
}
reclaim_docker_desktop_space() { record reclaim; }

reset_case
UPDATE_SPACE_MODE=auto init_update_space_mode
[[ "$update_space_mode" == auto ]] || fail 'auto 模式配置错误'
UPDATE_SPACE_MODE=compact init_update_space_mode
[[ "$update_space_mode" == compact ]] || fail 'compact 模式配置错误'
if UPDATE_SPACE_MODE=bad init_update_space_mode 2>/dev/null; then fail '非法模式放行'; fi
repair_build_cache=false
if UPDATE_SPACE_MODE=compact init_update_space_mode 2>/dev/null; then fail '禁用清理仍允许 compact'; fi
reset_case
release_build_intermediates dsa >/dev/null
grep -Fq -- '--filter type!=exec.cachemount' "$test_dir/trace" || fail '依赖缓存未排除'
reset_case
repair_build_cache=false
release_build_intermediates dsa >/dev/null
finalize_update_space >/dev/null
[[ ! -s "$test_dir/trace" ]] || fail '关闭后仍清理'
reset_case
test_idle=false
if release_build_intermediates dsa >/dev/null; then fail '活动构建仍清理'; fi
reset_case
finalize_update_space >/dev/null || fail '健康后收敛失败'
[[ "$(grep -c '^retire$' "$test_dir/trace")" == 2 ]] || fail '无候选后未终止'
grep -q '^reclaim$' "$test_dir/trace" || fail '最终没有回收宿主空闲块'
reset_case
test_sufficient=true
finalize_update_space >/dev/null
if grep -q '^retire$' "$test_dir/trace"; then fail '空间充足仍退役'; fi
reset_case
test_failure=retire
if finalize_update_space >/dev/null; then fail '删除失败未返回'; fi
if grep -q '^reclaim$' "$test_dir/trace"; then fail '删除失败仍继续'; fi
printf '构建间中间层回收、依赖缓存保留、健康后释放旧基线、失败停止及禁用验证通过。\n'
