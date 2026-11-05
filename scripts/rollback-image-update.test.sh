#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/rollback-image-update-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

# 执行实际更新函数，所有外部阶段与 Docker 均以替身代替。
source "$script_dir/update-runtime.sh"
phase() {
  printf '%s\n' "$1" >> "$test_dir/events"
  [[ "$fail_at" != "$1" ]]
}
validate_rollback_image_policy() { phase config; }
init_build_network() { phase network; }
create_local_build_override() { phase override; }
init_build_space() { phase init; }
acquire_build_space_lock() { phase lock; }
record_dsa_runtime_checkpoint() { phase checkpoint; }
prepare_build_space_probe() { phase probe; }
initialize_empty_development_volumes() { phase volumes; }
prepare_longbridge_build_source() { phase sdk_source; }
ensure_build_space() { phase space; }
retain_rollback_images() { phase retain; }
prepare_base_images() { phase base; }
run_build_with_retry() { phase build; }
require_idle_builder() { phase idle; }
maintain_build_cache() { phase cache; }
prepare_database_for_update() { phase database; }
start_updated_services() { phase health; }
prune_rollback_images_after_update() { phase prune; }
finalize_update_space() { phase finalspace; }
print_status() { :; }
compose_mock() {
  if [[ "$1" == pull ]]; then phase pull; else phase status; fi
}
docker() { printf '测试意外触达 Docker\n' >&2; return 1; }
fail() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

env_file=test.env
infra_dir="$test_dir"
build_space_reinstalled=false
update_space_mode=auto
app_services=(thesis-ledger)
compose_args=(compose_mock)
pull_service_images=false
for fail_at in network config override init lock checkpoint probe space volumes sdk_source retain base build database health status; do
  : > "$test_dir/events"
  if run_update > "$test_dir/output" 2>&1; then fail "$fail_at accepted"; fi
  if grep -qx prune "$test_dir/events"; then fail "$fail_at triggered pruning"; fi
  if [[ "$fail_at" == network && "$(cat "$test_dir/events")" != network ]]; then
    fail '网络参数校验失败后仍进入后续阶段'
  fi
  if [[ "$fail_at" == sdk_source ]] && grep -Eq '^(build|database|health)$' "$test_dir/events"; then
    fail '源码预取失败不应进入构建、数据库或启动'
  fi
done

pull_service_images=true
fail_at=pull
: > "$test_dir/events"
if run_update > "$test_dir/output" 2>&1; then fail 'pull failure accepted'; fi
if grep -qx prune "$test_dir/events"; then fail 'pull failure triggered pruning'; fi
pull_service_images=false

fail_at=""
: > "$test_dir/events"
run_update > "$test_dir/output" 2>&1
[[ "$(tail -n 4 "$test_dir/events" | tr '\n' ' ')" == 'health status prune finalspace ' ]] || fail 'pruning preceded health/status success'

fail_at=prune
: > "$test_dir/events"
run_update > "$test_dir/output" 2>&1 || fail 'maintenance failure invalidated successful update'
grep -q '历史回滚镜像维护失败' "$test_dir/output" || fail 'maintenance failure not visible'
[[ "$(grep -c '^build$' "$test_dir/events")" == 1 ]] || fail 'maintenance failure rebuilt services'

# 核对真实接入函数传递目标、锁所有者与更新前镜像。
source "$script_dir/retain-rollback-images.sh"
infra_dir="$(cd "$script_dir/.." && pwd)"
build_space_builder=desktop-linux
rollback_protected_image_ids=("sha256:$(printf 'a%.0s' {1..64})")
node_args=()
node() {
  [[ "$DOCKER_CONTEXT" == desktop-linux ]] || fail 'maintenance context not bound'
  node_args=("$@")
}
app_services=(dsa thesis-ledger)
prune_rollback_images_after_update
[[ "${node_args[1]}" == all && "${node_args[2]}" == --apply ]] || fail 'all target not passed'
[[ "${node_args[3]}" == --lock-owner && "${node_args[4]}" == "$$" ]] || fail 'update lock owner not passed'
[[ "${node_args[5]}" == --protect && "${node_args[6]}" == "${rollback_protected_image_ids[0]}" ]] || fail 'pre-update identity not passed'
app_services=(thesis-ledger)
prune_rollback_images_after_update
[[ "${node_args[1]}" == thesis-ledger ]] || fail 'Server-only target broadened'

rollback_protected_image_ids=()
prune_rollback_images_after_update
[[ "${#node_args[@]}" == 5 ]] || fail 'empty pre-update baseline did not work under nounset'

printf 'rollback-image-update: 21 scenarios passed\n'
