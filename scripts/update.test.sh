#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"
update_script="$script_dir/update.sh"
fake_docker="$script_dir/test-support/fake-docker.sh"
temp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

chmod +x "$fake_docker"
ln -s "$fake_docker" "$temp_dir/docker"

assert_equals() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf '断言失败：%s；期望 %s，实际 %s\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

count_calls() {
  local log_file="$1" pattern="$2"
  grep -Fc -- "$pattern" "$log_file" || true
}

run_case() {
  local name="$1" build_failures="$2" up_failures="$3" expected_status="$4"
  local case_dir="$temp_dir/$name"
  local status

  mkdir -p "$case_dir"
  : > "$case_dir/docker.log"
  : > "$case_dir/build-count"
  : > "$case_dir/up-count"

  set +e
  PATH="$temp_dir:$PATH" \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_DOCKER_BUILD_COUNT="$case_dir/build-count" \
    FAKE_DOCKER_BUILD_FAILURES="$build_failures" \
    FAKE_DOCKER_UP_COUNT="$case_dir/up-count" \
    FAKE_DOCKER_UP_FAILURES="$up_failures" \
    ENV_FILE=.env.example \
    HEALTH_TIMEOUT_SECONDS=1 \
    "$update_script" >"$case_dir/output.log" 2>&1
  status=$?
  set -e

  assert_equals "$expected_status" "$status" "$name 的退出状态"
  printf '%s\n' "$case_dir"
}

success_dir="$(run_case first-success 0 0 0)"
assert_equals 1 "$(<"$success_dir/build-count")" '首次成功时只构建一次'
assert_equals 0 "$(count_calls "$success_dir/docker.log" 'builder prune --all --force')" '首次成功时不清理缓存'

retry_dir="$(run_case retry-success 1 0 0)"
assert_equals 2 "$(<"$retry_dir/build-count")" '首次构建失败后重试一次'
assert_equals 1 "$(count_calls "$retry_dir/docker.log" 'builder prune --all --force')" '首次失败时只清理一次缓存'

failure_dir="$(run_case retry-failure 2 0 23)"
assert_equals 2 "$(<"$failure_dir/build-count")" '第二次失败后不进行第三次构建'
assert_equals 1 "$(count_calls "$failure_dir/docker.log" 'builder prune --all --force')" '两次失败时只清理一次缓存'

up_retry_dir="$(run_case up-retry-success 0 1 0)"
assert_equals 2 "$(<"$up_retry_dir/up-count")" '启动失败后从更新流程起点重试一次'
assert_equals 1 "$(count_calls "$up_retry_dir/docker.log" 'builder prune --all --force')" '启动失败时只清理一次缓存'

preflight_dir="$temp_dir/preflight-failure"
mkdir -p "$preflight_dir"
: > "$preflight_dir/docker.log"
: > "$preflight_dir/build-count"
: > "$preflight_dir/up-count"
set +e
PATH="$temp_dir:$PATH" \
  FAKE_DOCKER_LOG="$preflight_dir/docker.log" \
  FAKE_DOCKER_BUILD_COUNT="$preflight_dir/build-count" \
  FAKE_DOCKER_UP_COUNT="$preflight_dir/up-count" \
  ENV_FILE=.env.example \
  HEALTH_TIMEOUT_SECONDS=invalid \
  "$update_script" >"$preflight_dir/output.log" 2>&1
preflight_status=$?
set -e
assert_equals 1 "$preflight_status" '无效预检参数的退出状态'
assert_equals 0 "$(count_calls "$preflight_dir/docker.log" 'builder prune --all --force')" '预检失败时不清理缓存'

printf 'update.sh 重试行为测试通过。\n'
