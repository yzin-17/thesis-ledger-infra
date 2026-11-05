#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/reuse-thesis-ledger-image.sh"
source "$script_dir/dev-database.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/reuse-server-image-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
awk '/^run_build_command\(\)/ {capture=1} capture {print} capture && /^}/ {capture=0}' "$script_dir/update.sh" > "$test_dir/build.sh"
source "$test_dir/build.sh"
target=thesis-ledger
build_space_builder=desktop-linux
image="sha256:$(printf '%064d' 1)"
mock_actual="$image" mock_project=thesis-ledger-dev mock_service=thesis-ledger mock_directory=/app mock_user=thesis mock_command='["node","apps/server/dist/src/main.js"]'
docker() {
  case "$*" in
    *'--format {{.Id}}'*) printf '%s\n' "$mock_actual" ;;
    *com.docker.compose.project*) printf '%s\n' "$mock_project" ;;
    *com.docker.compose.service*) printf '%s\n' "$mock_service" ;;
    *Config.WorkingDir*) printf '%s\n' "$mock_directory" ;;
    *Config.User*) printf '%s\n' "$mock_user" ;;
    *Config.Cmd*) printf '%s\n' "$mock_command" ;;
    *) return 1 ;;
  esac
}
fail() { printf '失败：%s\n' "$*" >&2; exit 1; }
if validate_reused_thesis_ledger_image bad 2>/dev/null; then fail '非法ID应拒绝'; fi
validate_reused_thesis_ledger_image "$image"
target=all
if validate_reused_thesis_ledger_image "$image" 2>/dev/null; then fail '非最小目标应拒绝'; fi
target=thesis-ledger
for field in mock_actual mock_project mock_service mock_directory mock_user mock_command; do
  original="${!field}"
  printf -v "$field" '%s' mismatch
  if validate_reused_thesis_ledger_image "$image" 2>/dev/null; then fail "${field}错配应拒绝"; fi
  printf -v "$field" '%s' "$original"
done
app_services=(thesis-ledger)
build_log="$test_dir/log"
protect_completed_build_image() { printf 'protect %s\n' "$1" >> "$test_dir/trace"; }
release_build_intermediates() { printf 'intermediates %s\n' "$1" >> "$test_dir/trace"; }
build_compose_service() { printf 'build %s\n' "$1" >> "$test_dir/trace"; }
unset REUSE_DSA_IMAGE_ID REUSE_THESIS_LEDGER_IMAGE_ID
run_build_command >/dev/null
grep -Fq 'build thesis-ledger' "$test_dir/trace" || fail '默认应构建'
: > "$test_dir/trace"
REUSE_THESIS_LEDGER_IMAGE_ID="$image"
run_build_command >/dev/null
if grep -Fq 'build ' "$test_dir/trace"; then fail '复用不能构建'; fi
grep -Fq 'protect thesis-ledger' "$test_dir/trace" || fail '复用仍应保护镜像'
mock_actual="sha256:$(printf '%064d' 2)"
: > "$test_dir/trace"
if run_build_command >/dev/null 2>&1; then fail '构建阶段漂移应拒绝'; fi
[[ ! -s "$test_dir/trace" ]] || fail '漂移后不得进入保护或构建'
mock_actual="$image"
compose_mock() { printf '%s\n' "$*" >> "$test_dir/start"; }
compose_args=(compose_mock)
service_is_selected() { [[ "$1" == thesis-ledger ]]; }
wait_for_service() { :; }
start_updated_services >/dev/null
[[ "$(head -n 1 "$test_dir/start")" == 'up -d --no-build --pull never postgres redis dsa' ]] || fail '先恢复本地依赖且不得拉取镜像'
grep -Fqx 'up -d --no-build --force-recreate --no-deps thesis-ledger backtest-worker' "$test_dir/start" || fail '仅应强制重建两消费者'

for dependency_failure in postgres redis dsa start; do
  : > "$test_dir/start"
  compose_mock() {
    printf '%s\n' "$*" >> "$test_dir/start"
    [[ "$dependency_failure" != start ]]
  }
  wait_for_service() {
    printf 'healthy %s\n' "$1" >> "$test_dir/start"
    [[ "$1" != "$dependency_failure" ]]
  }
  if start_updated_services >/dev/null 2>&1; then fail "依赖${dependency_failure}失败应停止"; fi
  if grep -Fq 'backtest-worker' "$test_dir/start"; then fail '依赖失败不得重建消费者'; fi
done
: > "$test_dir/start"
compose_mock() { printf '%s\n' "$*" >> "$test_dir/start"; }
wait_for_service() { printf 'healthy %s\n' "$1" >> "$test_dir/start"; }
start_updated_services >/dev/null
[[ "$(cat "$test_dir/start")" == $'up -d --no-build --pull never postgres redis dsa\nhealthy postgres\nhealthy redis\nhealthy dsa\nup -d --no-build --force-recreate --no-deps thesis-ledger backtest-worker\nhealthy thesis-ledger\nhealthy backtest-worker' ]] || fail '依赖与消费者健康顺序必须固定'
: > "$test_dir/start"
target=all
if restore_reused_thesis_ledger_dependencies >/dev/null 2>&1; then fail '依赖恢复不能扩大目标'; fi
[[ ! -s "$test_dir/start" ]] || fail '目标不符不得启动依赖'
target=thesis-ledger
unset REUSE_THESIS_LEDGER_IMAGE_ID
: > "$test_dir/start"
start_updated_services >/dev/null
grep -Fqx 'up -d --no-build thesis-ledger backtest-worker' "$test_dir/start" || fail '默认启动参数改变'
(
  source "$script_dir/update-runtime.sh"
  phase() { printf '%s\n' "$1" >> "$test_dir/entry"; }
  init_build_network() { phase network; }
  validate_rollback_image_policy() { phase policy; }
  create_local_build_override() { phase override; }
  init_build_space() { phase space_init; }
  acquire_build_space_lock() { phase lock; }
  record_dsa_runtime_checkpoint() { phase checkpoint; }
  validate_reused_thesis_ledger_image() { phase reuse_validation; return 1; }
  prepare_build_space_probe() { fail '复用拒绝后不应进入空间探针'; }
  REUSE_THESIS_LEDGER_IMAGE_ID="$image"
  env_file=test.env
  if run_update > "$test_dir/entry-output" 2>&1; then fail '入口复用校验失败应停止'; fi
  [[ "$(tail -n 1 "$test_dir/entry")" == reuse_validation ]] || fail '入口复用校验缺失'
)
printf 'Server复用身份、双阶段校验、默认构建、依赖恢复顺序及失败收敛、两消费者同镜像重建测试通过。\n'
