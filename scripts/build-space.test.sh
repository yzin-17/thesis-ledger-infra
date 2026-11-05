#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/build-space-test.XXXXXX")"
source "$script_dir/build-space.sh"
source "$script_dir/build-compose-service.sh"
source "$script_dir/reuse-dsa-image.sh"
source "$script_dir/empty-development-volumes.sh"
trap 'release_build_space_lock; rm -rf "$test_dir"' EXIT
export TMPDIR="$test_dir"
awk '
  /^(run_build_command|is_disk_space_failure|run_build_with_retry)\(\)/ { capture = 1 }
  capture { print }
  capture && /^}/ { capture = 0 }
' "$script_dir/update.sh" > "$test_dir/update-functions.sh"
source "$test_dir/update-functions.sh"; source "$script_dir/update-runtime.sh"
fail() { printf '失败：%s\n' "$*" >&2; exit 1; }
ps() { [[ "$test_ps_fail" == false ]] || return 1; printf '1\n'; }
has() { grep -Fq -- "$1" "$test_dir/trace" || fail "缺少调用 $1"; }
absent() { if grep -Fq -- "$1" "$test_dir/trace"; then fail "意外调用 $1"; fi; }
count_is() {
  local count
  count="$(grep -Fc -- "$1" "$test_dir/trace" || true)"
  [[ "$count" == "$2" ]] || fail "$1 次数为 ${count}，期望 $2"
}

docker() {
  printf '%s\n' "$*" >> "$test_dir/trace"
  local explicit_context=""
  if [[ "${1:-}" == --context ]]; then
    explicit_context="$2"
    shift 2
  fi
  case "$*" in
    'context show') printf 'desktop-linux\n' ;;
    'context inspect '*) printf '%s\n' "$test_endpoint" ;;
    'buildx inspect '*) printf 'Driver: %s\nEndpoint: desktop-linux\n' "$test_driver" ;;
    'image inspect '*) [[ "$test_no_image" == false ]] || return 1; printf 'sha256:%064d\n' 1 ;;
    'info --format {{.OperatingSystem}}') printf '%s\n' "$test_desktop_os" ;;
    'info --format '*) printf '%s\n' "${test_inventory:-0 0}" ;;
    'volume ls -q') printf '%s' "${test_volumes:-}" ;;
    'pull node:24-alpine') [[ "${test_pull_fail:-false}" == false ]] || return 1; test_no_image=false ;;
    *'history ls '*) [[ "$test_history_fail" == false ]] || return 1; printf '%s\n' "$test_build_status" ;;
    'buildx prune '*)
      [[ "$test_prune_fail" == false ]] || return 1
      if [[ "$*" != *--max-used-space* && "$*" != *--filter* ]]; then touch "$test_dir/full-pruned"; fi
      ;;
    'run '*)
      if [[ "$*" == *docker/desktop-reclaim-space@* ]]; then
        [[ "$test_reclaim_fail" == false ]] || return 1
        test_reclaim_calls=$((test_reclaim_calls + 1))
        touch "$test_dir/desktop-reclaimed"
        return 0
      fi
      [[ "$test_probe_fail" == false ]] || return 1
      local available="$test_docker_kib"
      if [[ -f "$test_dir/full-pruned" ]]; then available="$test_after_kib"; fi
      if [[ -f "$test_dir/second-low" ]]; then available=5000000; fi
      if [[ -f "$test_dir/images-cleaned" ]]; then available="$test_image_docker_kib"; fi
      if [[ -f "$test_dir/rollback-cleaned" ]]; then available="$test_rollback_docker_kib"; fi
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted\noverlay 33000000 10000000 %s 30%% /\n' "$available"
      ;;
    'compose build --print '*)
      [[ "$explicit_context" == "$build_space_builder" ]] || fail 'Compose 定义必须绑定已验证 context'
      [[ "$test_compose_failure" == false ]] || return 1
      printf '{"group":{"default":{"targets":["%s"]}}}\n' "${@: -1}"
      ;;
    'buildx bake '*)
      [[ "${DOCKER_CONTEXT:-}" == "$build_space_builder" ]] || fail '构建 context 必须与空间探针 builder 一致'
      [[ "$explicit_context" == "$build_space_builder" ]] || fail '构建必须显式绑定已验证 context'
      local bake_definition
      bake_definition="$(cat)"
      [[ "$bake_definition" == *'"targets"'* ]] || return 1
      if [[ "$test_second_low" == true && "$*" == *' dsa' ]]; then touch "$test_dir/second-low"; fi
      if [[ "$test_build_failure" != none ]]; then
        printf '%s\n' "$test_build_failure"
        return 1
      fi
      ;;
    'compose ps') ;;
    *) fail "未声明的 Docker 调用: $*" ;;
  esac
}

node() {
  if [[ "$*" == *--validate-config* ]]; then
    if [[ "$*" == *--space-recovery* ]]; then
      [[ "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
      return 0
    fi
    [[ "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" =~ ^[1-9][0-9]*$ ]] || return 1
    return 0
  fi
  printf 'image-repair keep=%s %s\n' "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" "$*" >> "$test_dir/trace"
  if [[ "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" == 1 || "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" == 0 ]]; then
    [[ "$test_rollback_repair_fail" == false ]] || return 1
    if [[ "$test_rollback_global_only" == true && "$*" != *'rollback-image-policy.mjs all '* ]]; then
      return 0
    fi
    test_rollback_calls=$((test_rollback_calls + 1))
    if [[ "$*" == *--space-recovery* ]]; then
      if [[ "$test_rollback_release" != true || "$test_rollback_calls" -gt "$test_rollback_available" ]]; then return 2; fi
    fi
    if [[ "$test_rollback_release" == true && "$test_rollback_calls" -ge "$test_rollback_release_after" ]]; then
      touch "$test_dir/rollback-cleaned"
    fi
    return 0
  fi
  [[ "$test_image_repair_fail" == false ]] || return 1
  if [[ "$test_image_release" == true ]]; then touch "$test_dir/images-cleaned"; fi
}

df() {
  [[ "$test_df_fail" == false ]] || return 1
  local available="$test_host_kib"
  if [[ -f "$test_dir/images-cleaned" ]]; then available="$test_image_host_kib"; fi
  if [[ -f "$test_dir/desktop-reclaimed" ]]; then available="$test_reclaimed_host_kib"; fi
  if [[ -f "$test_dir/rollback-cleaned" ]]; then available="$test_rollback_host_kib"; fi
  if [[ "$test_reclaim_calls" -ge 2 ]]; then available="$test_second_reclaimed_host_kib"; fi
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\ndisk 100000000 10000000 %s 10%% /\n' "$available"
}

reset_case() {
  : > "$test_dir/trace"
  rm -f "$test_dir/full-pruned"
  rm -f "$test_dir/second-low"
  rm -f "$test_dir/images-cleaned"
  rm -f "$test_dir/desktop-reclaimed" "$test_dir/Docker.raw"
  rm -f "$test_dir/rollback-cleaned"
  test_endpoint=unix:///tmp/docker-space-test.sock
  test_ps_fail=false
  test_driver=docker
  test_no_image=false test_history_fail=false test_prune_fail=false
  test_probe_fail=false test_df_fail=false test_build_status=Completed
  test_host_kib=30000000 test_docker_kib=22000000 test_after_kib=22000000
  test_build_failure=none
  test_compose_failure=false
  test_second_low=false
  build_space_dsa_image_id="" build_space_ledger_image_id=""
  build_space_reinstalled=false test_reinstall_exit=0
  test_image_repair_fail=false test_image_release=false
  test_image_host_kib=30000000 test_image_docker_kib=22000000
  test_desktop_os='Docker Desktop' test_reclaim_fail=false test_reclaimed_host_kib=30000000
  test_reclaim_calls=0 test_second_reclaimed_host_kib=30000000
  test_rollback_repair_fail=false test_rollback_release=false test_rollback_global_only=false
  test_rollback_calls=0 test_rollback_available=2 test_rollback_release_after=1
  target=all
  update_space_mode=auto
  test_rollback_host_kib=1000000 test_rollback_docker_kib=6000000
  repair_build_cache=true
  build_cache_max_used_space=8gb build_cache_min_free_space=18gb build_cache_reserved_space=4gb
  infra_dir="$test_dir" base_image_aliases=(node:test)
  local_build_dir="$test_dir"
  BUILD_SPACE_HOST_PATH="$test_dir" BUILD_HOST_MIN_FREE_SPACE=20gb
  unset DOCKER_HOST BUILDX_BUILDER
  unset BOOTSTRAP_SPACE_PROBE
  unset BUILD_SPACE_ROLLBACK_KEEP_COUNT ROLLBACK_IMAGE_KEEP_COUNT
  # 既有场景显式保留旧可配置目标1；新默认0在下方独立覆盖。
  BUILD_SPACE_ROLLBACK_KEEP_COUNT=1
  test_inventory='0 0' test_volumes='' test_pull_fail=false
  build_log="$test_dir/build.log"
  compose_args=(docker compose) app_services=(dsa thesis-ledger)
  env_file="$test_dir/env" pull_service_images=false
  init_build_space
  : > "$test_dir/trace"
}

reset_case
ensure_build_space 测试 >/dev/null
count_is 'buildx prune' 1
has '--builder desktop-linux --all --force --max-used-space 8gb'
has 'run --rm --pull=never --network none --read-only --entrypoint df sha256:'

reset_case
test_docker_kib=5000000
ensure_build_space 测试 >/dev/null
count_is 'buildx prune' 1
count_is 'run --rm' 3
[[ ! -f "$test_dir/full-pruned" ]] || fail '未达参考值清空了热缓存'

reset_case
test_docker_kib=5000000 test_after_kib=6000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '低于参考目标不应阻断'
count_is 'buildx prune' 1

reset_case
test_host_kib=1000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '宿主低于参考目标不应阻断'
has 'image-repair'

reset_case
test_host_kib=1000000 test_image_release=true
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '镜像整备已释放空间却未放行'
count_is 'image-repair' 1
count_is 'run --rm' 2
has '--apply --lock-owner'

reset_case
protect_completed_build_image dsa >/dev/null
test_host_kib=1000000 test_image_release=true
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '已构建产物保护参数未传递'
has "--protect $build_space_dsa_image_id"

reset_case
test_host_kib=1000000 test_image_repair_fail=true
if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail '镜像库存/清理失败仍放行'; fi

reset_case
test_host_kib=1000000 test_rollback_release=true
test_rollback_host_kib=30000000 test_rollback_docker_kib=22000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '紧张期回滚镜像清理达到容量后未放行'
count_is 'image-repair keep=1' 1
count_is 'image-repair keep=2' 1
[[ "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" == 2 ]] || fail '紧张期清理改写了常规配置'

for single_target in dsa thesis-ledger; do
  reset_case
  target="$single_target"
  test_host_kib=1000000 test_rollback_release=true test_rollback_global_only=true
  test_rollback_host_kib=30000000 test_rollback_docker_kib=22000000
  ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '单目标遗漏另一应用的超额回滚空间'
  has "docker-space-images.mjs $single_target --apply"
  has 'rollback-image-policy.mjs all --apply --lock-owner'
  count_is 'image-repair keep=1' 1
  [[ "$target" == "$single_target" ]] || fail '空间整备修改了构建目标'
done

reset_case
protect_completed_build_image dsa >/dev/null
rollback_protected_image_ids=("sha256:$(printf '%064d' 7)")
test_host_kib=1000000 test_rollback_release=true
test_rollback_host_kib=30000000 test_rollback_docker_kib=22000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '紧张期保护参数场景未放行'
has "--protect $build_space_dsa_image_id"
has "--protect ${rollback_protected_image_ids[0]}"
unset rollback_protected_image_ids

reset_case
touch "$test_dir/Docker.raw"
test_host_kib=1000000 test_reclaimed_host_kib=1000000 test_rollback_release=true
test_rollback_docker_kib=22000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '回滚清理后Desktop回收达标仍未放行'
[[ "$test_reclaim_calls" == 2 ]] || fail '回滚清理后没有复测并回收宿主空闲块'

reset_case
test_host_kib=1000000 test_rollback_repair_fail=true
if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail '紧张期回滚清理失败仍放行'; fi

reset_case
BUILD_SPACE_ROLLBACK_KEEP_COUNT=2 init_build_space
test_host_kib=1000000 test_rollback_release=true
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '参考目标不应阻断'
absent 'image-repair keep=1'

reset_case
BUILD_SPACE_ROLLBACK_KEEP_COUNT=0
init_build_space >"$test_dir/output" 2>&1 || fail '紧张期目标0仍被拒绝'
[[ "$build_space_rollback_keep_count" == 0 ]] || fail '显式零目标未保存'

for needed in 1 2; do
  reset_case
  unset BUILD_SPACE_ROLLBACK_KEEP_COUNT
  init_build_space || fail '新默认零目标初始化失败'
  [[ "$build_space_rollback_keep_count" == 0 ]] || fail '紧张期仍默认保留1个历史版本'
  target=dsa test_host_kib=1000000 test_rollback_release=true test_rollback_release_after="$needed"
  test_rollback_host_kib=30000000 test_rollback_docker_kib=22000000
  ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '未按实际缺口逐个清到门槛'
  count_is 'image-repair keep=0' "$needed"
  has 'rollback-image-policy.mjs all --apply --lock-owner'
  has '--space-recovery'
  [[ "$target" == dsa && "${ROLLBACK_IMAGE_KEEP_COUNT:-2}" == 2 ]] || fail '紧张期改变了构建目标或常规保留数'
done

reset_case
BUILD_SPACE_ROLLBACK_KEEP_COUNT=0 init_build_space
test_host_kib=1000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '没有可清镜像但有正余量应尝试构建'
absent '--all-unused'
count_is 'image-repair keep=0' 1

reset_case
BUILD_SPACE_ROLLBACK_KEEP_COUNT=0 init_build_space
protect_completed_build_image dsa >/dev/null
rollback_protected_image_ids=("sha256:$(printf '%064d' 7)")
test_host_kib=1000000 test_rollback_release=true
test_rollback_host_kib=30000000 test_rollback_docker_kib=22000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '零目标保护参数场景未恢复容量'
has "--protect $build_space_dsa_image_id"
has "--protect ${rollback_protected_image_ids[0]}"
unset rollback_protected_image_ids

reset_case
BUILD_SPACE_ROLLBACK_KEEP_COUNT=0 init_build_space
repair_build_cache=false test_host_kib=1000000 test_rollback_release=true
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '关闭维护仍应允许已知正余量'
absent 'image-repair'

reset_case
touch "$test_dir/Docker.raw"
test_host_kib=1000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail 'Desktop回收已达到宿主目标却未放行'
has '--privileged --pid=host --platform linux/amd64 docker/desktop-reclaim-space@sha256:'
has '--rm --pull=never --network none --read-only'

reset_case
touch "$test_dir/Docker.raw"
test_host_kib=1000000 test_reclaim_fail=true
if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail 'Desktop回收失败仍放行'; fi

reset_case
touch "$test_dir/Docker.raw"
test_host_kib=1000000 test_desktop_os=Colima
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '非Desktop有实际余量不应阻断'
absent '--privileged'

reset_case
repair_build_cache=false test_docker_kib=5000000
ensure_build_space 测试 >"$test_dir/output" 2>&1 || fail '关闭清理且有实际余量不应阻断'
absent 'buildx prune'
absent 'image-repair'
test_docker_kib=22000000
ensure_build_space 测试 >/dev/null
absent 'buildx prune'

for fault in test_probe_fail test_df_fail test_history_fail test_prune_fail; do
  reset_case
  printf -v "$fault" true
  if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail "$fault 未阻止更新"; fi
done
reset_case
test_docker_kib=unknown
if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail '未知余量放行'; fi
reset_case
test_build_status=Running
if ensure_build_space 测试 >"$test_dir/output" 2>&1; then fail '并发构建放行'; fi
absent 'buildx prune'
absent 'run --rm'

for config in remote driver builder host no_image invalid_size zero_size; do
  reset_case
  case "$config" in
    remote) test_endpoint=tcp://remote:2375 ;;
    driver) test_driver=docker-container ;;
    builder) BUILDX_BUILDER=other ;;
    host) DOCKER_HOST=unix:///other.sock ;;
    no_image) test_no_image=true ;;
    invalid_size) build_cache_min_free_space=not-a-size ;;
    zero_size) build_cache_min_free_space=0 ;;
  esac
  if init_build_space >"$test_dir/output" 2>&1; then fail "$config 应初始化失败"; fi
  absent 'buildx prune'
done

reset_case
[[ "$(space_kib 1GB)" == 1048576 && "$(space_kib 1.5gb)" == 1572864 ]] || fail '容量换算错误'
build_space_lock_path="$test_dir/update.lock"
acquire_build_space_lock
if (build_space_lock=""; acquire_build_space_lock) >"$test_dir/output" 2>&1; then fail '重复更新获得锁'; fi
release_build_space_lock
[[ ! -e "$test_dir/update.lock" ]] || fail '锁未释放'
test_ps_fail=true
if acquire_build_space_lock >"$test_dir/output" 2>&1; then fail '无进程权限仍取得更新锁'; fi
[[ ! -e "$test_dir/update.lock" ]] || fail '无权限时创建了锁'

for bootstrap_case in success nonempty volume low_host running pull_failed; do
  reset_case
  test_no_image=true BOOTSTRAP_SPACE_PROBE=true
  init_build_space || fail '显式首次初始化未进入锁前准备'
  acquire_build_space_lock
  case "$bootstrap_case" in
    nonempty) test_inventory='0 1' ;;
    volume) test_volumes='old-volume' ;;
    low_host) test_host_kib=0 ;;
    running) test_build_status=Running ;;
    pull_failed) test_pull_fail=true ;;
  esac
  if [[ "$bootstrap_case" == success ]]; then
    prepare_build_space_probe >"$test_dir/output" 2>&1 || fail '首次探针准备失败'
    has 'pull node:24-alpine'
    [[ "$build_space_probe_image" == sha256:* ]] || fail '未固定探针 ID'
    ensure_build_space 初次 >/dev/null || fail '首次完整空间门禁失败'
  else
    if prepare_build_space_probe >"$test_dir/output" 2>&1; then fail "$bootstrap_case 首次探针错误放行"; fi
    if [[ "$bootstrap_case" != pull_failed ]]; then absent 'pull node:24-alpine'; fi
  fi
  release_build_space_lock
done

# 测试真实更新编排函数，基础镜像与数据库副作用以记录桩替代。
validate_rollback_image_policy() { :; }
record_dsa_runtime_checkpoint() { printf 'checkpoint\n' >> "$test_dir/trace"; }
create_local_build_override() { :; }
retain_rollback_images() { printf 'retain\n' >> "$test_dir/trace"; }
prune_rollback_images_after_update() { printf 'rollback-maintenance\n' >> "$test_dir/trace"; }
prepare_base_images() { printf 'prepare-base\n' >> "$test_dir/trace"; }
prepare_longbridge_build_source() { printf 'sdk-source\n' >> "$test_dir/trace"; }
prepare_database_for_update() { printf 'database\n' >> "$test_dir/trace"; }
start_updated_services() { printf 'start\n' >> "$test_dir/trace"; }
reinstall_preserving_volumes() {
  printf 'reinstall\n' >> "$test_dir/trace"
  if ((test_reinstall_exit == 0)); then build_space_reinstalled=true; fi
  return "$test_reinstall_exit"
}
print_status() { :; }
reset_case
run_update >"$test_dir/output" 2>&1 || fail '正常更新失败'
release_build_space_lock
count_is 'run --rm' 2
count_is 'compose build --print dsa' 1
count_is 'compose build --print thesis-ledger' 1
count_is 'buildx bake --builder desktop-linux' 2
has start
awk '/run --rm/ {probe++} /prepare-base/ {if (probe != 1) exit 1}
  /compose build/ {if (probe != 1) exit 1}' "$test_dir/trace" || fail '入口空间检查顺序错误'

reset_case
test_docker_kib=0 test_after_kib=0 test_reinstall_exit=1
if run_update >"$test_dir/output" 2>&1; then fail '低空间更新成功'; fi
release_build_space_lock
absent prepare-base
absent 'compose build'
absent database

reset_case
test_second_low=true
run_update >"$test_dir/output" 2>&1 || fail '构建过程中不应重复空间预检'
release_build_space_lock
count_is 'compose build --print dsa' 1
count_is 'compose build --print thesis-ledger' 1
count_is 'run --rm' 3
has database

reset_case
test_build_failure='no space left on device'
if run_build_with_retry >"$test_dir/output" 2>&1; then fail '连续 ENOSPC 应失败'; fi
count_is 'compose build --print dsa' 2
absent 'compose build --print thesis-ledger'
count_is reinstall 1

reset_case
test_build_failure='ordinary build error'
if run_build_with_retry >"$test_dir/output" 2>&1; then fail '连续普通错误应失败'; fi
count_is 'compose build --print dsa' 2
[[ ! -f "$test_dir/full-pruned" ]] || fail '普通错误触发全清'
absent reinstall

reset_case
repair_build_cache=false test_build_failure='no space left on device'
if run_build_with_retry >"$test_dir/output" 2>&1; then fail '关闭清理后的 ENOSPC 应失败'; fi
count_is 'compose build --print dsa' 1
absent 'buildx prune'
absent reinstall

reset_case
test_docker_kib=0 test_after_kib=0 test_reinstall_exit=1
if run_update >"$test_dir/output" 2>&1; then fail '入口门禁失败应停止'; fi
release_build_space_lock
absent 'compose build'
count_is 'buildx prune' 1

reset_case
test_compose_failure=true
if run_update >"$test_dir/output" 2>&1; then fail 'Compose 定义导出失败应停止'; fi
release_build_space_lock
absent database
absent start

# 普通重试的下一次才发生 ENOSPC，也必须有一次独立恢复机会。
reset_case
update_space_mode=compact
run_update >"$test_dir/output" 2>&1 || fail 'compact 模式失败'
release_build_space_lock
count_is reinstall 1
count_is sdk-source 1
has start

reset_case
test_host_kib=1000000 test_docker_kib=5000000 test_after_kib=6000000
run_update >"$test_dir/output" 2>&1 || fail '完整更新仍被参考目标阻断'
release_build_space_lock
absent '--all-unused'
has start
absent reinstall

reset_case
test_docker_kib=0 test_after_kib=0
run_update >"$test_dir/output" 2>&1 || fail '零空间未尝试保卷恢复'
release_build_space_lock
count_is reinstall 1
has start

(
  reset_case
  calls=0
  run_build_command() {
    calls=$((calls + 1))
    if ((calls == 1)); then printf 'ordinary error\n' > "$build_log"; return 1; fi
    if ((calls == 2)); then printf 'ERR_PNPM_ENOSPC\n' > "$build_log"; return 1; fi
  }
  run_build_with_retry >"$test_dir/output" 2>&1 || fail '普通错误之后的 ENOSPC 未恢复'
  [[ "$calls" == 3 ]] || fail '恢复后构建次数不正确'
  count_is reinstall 1
)
(
  reset_case
  test_build_failure=ENOSPC
  reinstall_preserving_volumes() { printf 'reinstall\n' >> "$test_dir/trace"; return 1; }
  if run_build_with_retry >"$test_dir/output" 2>&1; then fail '恢复失败仍继续构建'; fi
  count_is reinstall 1
  count_is 'compose build --print dsa' 1
)
(
  reset_case
  build_space_reinstalled=true test_build_failure=ENOSPC
  if run_build_with_retry >"$test_dir/output" 2>&1; then fail '预检已恢复后 ENOSPC 应停止'; fi
  absent reinstall
  count_is 'compose build --print dsa' 1
)
printf '入口单次空间测量、参考目标放行、未知/零余量、清理关闭、并发保护、context一致性与有界恢复回归通过。\n'
