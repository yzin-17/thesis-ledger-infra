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

assert_file_missing() {
  local path="$1" message="$2"
  if [[ -e "$path" ]]; then
    printf '断言失败：%s；文件仍存在 %s\n' "$message" "$path" >&2
    exit 1
  fi
}

assert_directory_empty() {
  local path="$1" message="$2"
  if find "$path" -mindepth 1 -print -quit | grep -q .; then
    printf '断言失败：%s；目录仍包含临时文件 %s\n' "$message" "$path" >&2
    exit 1
  fi
}

assert_source_line_count() {
  local expected="$1" file="$2" line="$3" message="$4" actual
  actual="$(grep -Fxc -- "$line" "$file" || true)"
  assert_equals "$expected" "$actual" "$message"
}

count_calls() {
  local log_file="$1" pattern="$2"
  grep -Fc -- "$pattern" "$log_file" || true
}

run_case() {
  local name="$1" build_failures="$2" up_failures="$3" expected_status="$4"
  local target="${5:-all}"
  local build_error="${6:-模拟构建失败}"
  local repair_cache="${7:-false}"
  local inspect_status="${8:-running}"
  local pull_base_images="${9:-false}"
  local base_image_state="${10:-aliases}"
  local pull_fail_at="${11:-0}"
  local case_dir="$temp_dir/$name"
  local status

  mkdir -p "$case_dir"
  : > "$case_dir/docker.log"
  : > "$case_dir/build-count"
  : > "$case_dir/up-count"
  printf '0\n' > "$case_dir/pull-count"
  : > "$case_dir/image-state"
  mkdir -p "$case_dir/runtime"

  case "$base_image_state" in
    aliases)
      printf '%s\n' \
        thesis-ledger-local-node:20-slim \
        thesis-ledger-local-python:3.11-slim-bookworm \
        thesis-ledger-local-node:24-alpine > "$case_dir/image-state"
      ;;
    sources)
      printf '%s\n' node:20-slim python:3.11-slim-bookworm node:24-alpine > "$case_dir/image-state"
      ;;
    none) ;;
    *)
      printf '未知基础镜像测试状态: %s\n' "$base_image_state" >&2
      exit 1
      ;;
  esac

  set +e
  PATH="$temp_dir:$PATH" \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_DOCKER_BUILD_COUNT="$case_dir/build-count" \
    FAKE_DOCKER_BUILD_FAILURES="$build_failures" \
    FAKE_DOCKER_BUILD_ERROR="$build_error" \
    FAKE_DOCKER_UP_COUNT="$case_dir/up-count" \
    FAKE_DOCKER_UP_FAILURES="$up_failures" \
    FAKE_DOCKER_INSPECT_STATUS="$inspect_status" \
    FAKE_DOCKER_IMAGE_STATE="$case_dir/image-state" \
    FAKE_DOCKER_PULL_COUNT="$case_dir/pull-count" \
    FAKE_DOCKER_PULL_FAIL_AT="$pull_fail_at" \
    TMPDIR="$case_dir/runtime" \
    ENV_FILE=.env.example \
    HEALTH_TIMEOUT_SECONDS=1 \
    PULL_BASE_IMAGES="$pull_base_images" \
    REPAIR_BUILD_CACHE_ON_NO_SPACE="$repair_cache" \
    "$update_script" "$target" >"$case_dir/output.log" 2>&1
  status=$?
  set -e

  assert_equals "$expected_status" "$status" "$name 的退出状态"
  printf '%s\n' "$case_dir"
}

success_dir="$(run_case first-success 0 0 0)"
assert_equals 1 "$(<"$success_dir/build-count")" '首次成功时只构建一次'
assert_equals 1 "$(count_calls "$success_dir/docker.log" ' build dsa thesis-ledger')" '默认目标同时构建两个应用镜像'
assert_equals 0 "$(count_calls "$success_dir/docker.log" 'builder prune')" '首次成功时不清理缓存'
assert_equals 0 "$(count_calls "$success_dir/docker.log" 'pull node:')" '本地别名齐全时不拉取 Node 基础镜像'
assert_equals 0 "$(count_calls "$success_dir/docker.log" 'pull python:')" '本地别名齐全时不拉取 Python 基础镜像'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'FROM thesis-ledger-local-node:20-slim AS web-builder')" \
  '默认构建的 DSA 临时 Dockerfile 使用本地 Node 别名'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'FROM thesis-ledger-local-python:3.11-slim-bookworm')" \
  '默认构建的 DSA 临时 Dockerfile 使用本地 Python 别名'
assert_equals 2 \
  "$(count_calls "$success_dir/docker.log" 'FROM thesis-ledger-local-node:24-alpine')" \
  '默认构建的 ThesisLedger 临时 Dockerfile 两个阶段都使用本地别名'
assert_equals 0 "$(count_calls "$success_dir/docker.log" '# syntax=')" '临时 Dockerfile 不解析外部 frontend'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'RUN --mount=type=cache,id=dsa-web-npm,target=/root/.npm,sharing=locked npm ci')" \
  'DSA 临时 Dockerfile 使用命名 npm cache'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'RUN --mount=type=cache,id=dsa-apt-archives,target=/var/cache/apt,sharing=locked \')" \
  'DSA 临时 Dockerfile 使用命名 APT archives cache'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" '    --mount=type=cache,id=dsa-apt-lists,target=/var/lib/apt/lists,sharing=locked \')" \
  'DSA 临时 Dockerfile 使用命名 APT lists cache'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'RUN --mount=type=cache,id=dsa-pip,target=/root/.cache/pip,sharing=locked pip install -r requirements.txt')" \
  'DSA 临时 Dockerfile 使用命名 pip cache'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'RUN --mount=type=cache,id=thesis-ledger-pnpm-store,target=/pnpm/store,sharing=locked \')" \
  'ThesisLedger 临时 Dockerfile 使用命名 pnpm store'
assert_equals 1 "$(count_calls "$success_dir/docker.log" 'COPY apps/desktop/package.json apps/desktop/package.json')" '临时 Dockerfile 在安装前复制 desktop manifest'
assert_equals 1 "$(count_calls "$success_dir/docker.log" 'COPY apps/mobile/package.json apps/mobile/package.json')" '临时 Dockerfile 在安装前复制 mobile manifest'
assert_equals 1 "$(count_calls "$success_dir/docker.log" 'COPY packages/api-client/package.json packages/api-client/package.json')" '临时 Dockerfile 在安装前复制 api-client manifest'
assert_equals 1 "$(count_calls "$success_dir/docker.log" 'COPY services/dsa-adapter/package.json services/dsa-adapter/package.json')" '临时 Dockerfile 在安装前复制 dsa-adapter manifest'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" "    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \\")" \
  'DSA 临时 Dockerfile 注入 Aliyun Debian mirror'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" 'ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \')" \
  'ThesisLedger 临时 Dockerfile 为 corepack 注入 npmmirror'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" '    npm_config_registry=https://registry.npmmirror.com \')" \
  'ThesisLedger 临时 Dockerfile 为 npm/pnpm 注入 npmmirror'
assert_equals 1 \
  "$(count_calls "$success_dir/docker.log" '    npm_config_disturl=https://npmmirror.com/mirrors/node')" \
  'ThesisLedger 临时 Dockerfile 为 node-gyp 注入 npmmirror'
success_override="$(sed -n 's/^local-compose-override //p' "$success_dir/docker.log" | head -n 1)"
assert_file_missing "$success_override" '成功退出后清理临时 Compose override'

retry_dir="$(run_case retry-success 1 0 0)"
assert_equals 2 "$(<"$retry_dir/build-count")" '首次构建失败后重试一次'
assert_equals 0 "$(count_calls "$retry_dir/docker.log" 'builder prune')" '普通构建失败重试时保留缓存'

failure_dir="$(run_case retry-failure 2 0 23)"
assert_equals 2 "$(<"$failure_dir/build-count")" '第二次失败后不进行第三次构建'
assert_equals 0 "$(count_calls "$failure_dir/docker.log" 'builder prune')" '两次普通构建失败都不清理缓存'
assert_directory_empty "$failure_dir/runtime" '构建失败退出后清理全部本地临时构建文件'

up_failure_dir="$(run_case up-failure 0 1 24)"
assert_equals 1 "$(<"$up_failure_dir/build-count")" '启动失败时不重新构建'
assert_equals 1 "$(<"$up_failure_dir/up-count")" '启动失败时不重试启动阶段'
assert_equals 0 "$(count_calls "$up_failure_dir/docker.log" 'builder prune')" '启动失败时不清理缓存'

health_failure_dir="$(run_case health-failure 0 0 1 dsa '模拟构建失败' false exited)"
assert_equals 1 "$(<"$health_failure_dir/build-count")" '健康检查失败时不重新构建'
assert_equals 0 "$(count_calls "$health_failure_dir/docker.log" 'builder prune')" '健康检查失败时不清理缓存'

dsa_dir="$(run_case dsa-target 0 0 0 dsa)"
assert_equals 1 "$(count_calls "$dsa_dir/docker.log" ' build dsa')" 'DSA 目标只构建 DSA'
assert_equals 0 "$(count_calls "$dsa_dir/docker.log" ' build dsa thesis-ledger')" 'DSA 目标不构建 ThesisLedger'
assert_equals 0 "$(count_calls "$dsa_dir/docker.log" 'thesis-ledger-local-node:24-alpine')" 'DSA 目标不准备 ThesisLedger 基础镜像'
assert_equals 1 "$(count_calls "$dsa_dir/docker.log" 'local-compose-service dsa')" 'DSA 临时 override 只声明 DSA'
assert_equals 0 "$(count_calls "$dsa_dir/docker.log" 'local-compose-service thesis-ledger')" 'DSA 临时 override 不声明 ThesisLedger'

thesis_dir="$(run_case thesis-target 0 0 0 thesis-ledger)"
assert_equals 1 "$(count_calls "$thesis_dir/docker.log" ' build thesis-ledger')" 'ThesisLedger 目标只构建 ThesisLedger'
assert_equals 0 "$(count_calls "$thesis_dir/docker.log" 'thesis-ledger-local-node:20-slim')" 'ThesisLedger 目标不准备 DSA Node 基础镜像'
assert_equals 0 "$(count_calls "$thesis_dir/docker.log" 'thesis-ledger-local-python:3.11-slim-bookworm')" 'ThesisLedger 目标不准备 DSA Python 基础镜像'
assert_equals 0 "$(count_calls "$thesis_dir/docker.log" 'local-compose-service dsa')" 'ThesisLedger 临时 override 不声明 DSA'
assert_equals 1 "$(count_calls "$thesis_dir/docker.log" 'local-compose-service thesis-ledger')" 'ThesisLedger 临时 override 只声明 ThesisLedger'

no_space_dir="$(run_case no-space-no-repair 1 0 23 all 'no space left on device')"
assert_equals 1 "$(<"$no_space_dir/build-count")" '磁盘不足且未授权清理时不盲目重试'
assert_equals 0 "$(count_calls "$no_space_dir/docker.log" 'builder prune')" '磁盘不足且未授权时保留缓存'

repair_dir="$(run_case no-space-repair 1 0 0 all 'no space left on device' true)"
assert_equals 2 "$(<"$repair_dir/build-count")" '磁盘不足且显式授权后重试一次'
assert_equals 1 "$(count_calls "$repair_dir/docker.log" 'builder prune --force --min-free-space 8gb')" '磁盘不足时只执行一次有界缓存清理'

pull_dir="$(run_case pull-base-images 0 0 0 all '模拟构建失败' false running true)"
assert_equals 3 "$(<"$pull_dir/pull-count")" '显式刷新会拉取三个官方基础镜像'
assert_equals 3 "$(count_calls "$pull_dir/docker.log" 'tag ')" '显式刷新后更新三个本地别名'
assert_equals 1 "$(count_calls "$pull_dir/docker.log" ' build dsa thesis-ledger')" '显式刷新后使用本地别名构建'
assert_equals 0 "$(count_calls "$pull_dir/docker.log" ' build --pull ')" 'Compose 不对本地别名执行远端 pull'

sources_dir="$(run_case local-sources 0 0 0 all '模拟构建失败' false running false sources)"
assert_equals 0 "$(<"$sources_dir/pull-count")" '官方 tag 已在本机时不访问远端'
assert_equals 3 "$(count_calls "$sources_dir/docker.log" 'tag ')" '从本机官方 tag 补齐三个别名'

first_pull_dir="$(run_case first-base-pull 0 0 0 all '模拟构建失败' false running false none)"
assert_equals 3 "$(<"$first_pull_dir/pull-count")" '首次没有基础镜像时只拉取三个必要镜像'
assert_equals 3 "$(count_calls "$first_pull_dir/docker.log" 'tag ')" '首次拉取后创建三个本地别名'

pull_failure_dir="$(run_case base-pull-failure 0 0 1 all '模拟构建失败' false running true aliases 2)"
assert_equals 2 "$(<"$pull_failure_dir/pull-count")" '基础镜像刷新中任一拉取失败后立即退出'
assert_equals 0 "$(count_calls "$pull_failure_dir/docker.log" 'tag ')" '第二个镜像拉取失败时仍不更新任何本地别名'
assert_equals 0 "$(count_calls "$pull_failure_dir/docker.log" ' build ')" '基础镜像准备失败时不开始应用构建'
assert_directory_empty "$pull_failure_dir/runtime" '基础镜像拉取失败后清理全部本地临时构建文件'

invalid_dir="$(run_case invalid-target 0 0 1 unsupported)"
assert_equals 0 "$(count_calls "$invalid_dir/docker.log" ' compose ')" '非法目标在 Compose 调用前失败'
assert_equals 0 "$(count_calls "$invalid_dir/docker.log" 'builder prune')" '非法目标不清理缓存'

preflight_dir="$temp_dir/preflight-failure"
mkdir -p "$preflight_dir"
: > "$preflight_dir/docker.log"
: > "$preflight_dir/build-count"
: > "$preflight_dir/up-count"
printf '0\n' > "$preflight_dir/pull-count"
: > "$preflight_dir/image-state"
set +e
PATH="$temp_dir:$PATH" \
  FAKE_DOCKER_LOG="$preflight_dir/docker.log" \
  FAKE_DOCKER_BUILD_COUNT="$preflight_dir/build-count" \
  FAKE_DOCKER_UP_COUNT="$preflight_dir/up-count" \
  FAKE_DOCKER_IMAGE_STATE="$preflight_dir/image-state" \
  FAKE_DOCKER_PULL_COUNT="$preflight_dir/pull-count" \
  ENV_FILE=.env.example \
  HEALTH_TIMEOUT_SECONDS=invalid \
  "$update_script" >"$preflight_dir/output.log" 2>&1
preflight_status=$?
set -e
assert_equals 1 "$preflight_status" '无效预检参数的退出状态'
assert_equals 0 "$(count_calls "$preflight_dir/docker.log" 'builder prune')" '预检失败时不清理缓存'

dsa_dockerfile="$infra_dir/../daily-stock-analysis/docker/Dockerfile"
thesis_dockerfile="$infra_dir/../thesis-ledger/infra/docker/server.Dockerfile"
assert_source_line_count 1 "$dsa_dockerfile" '# syntax=docker/dockerfile:1.7' '共享 DSA Dockerfile 保留原有 frontend'
assert_source_line_count 1 "$dsa_dockerfile" 'FROM node:20-slim AS web-builder' '共享 DSA Dockerfile 保留官方 Node 基础镜像'
assert_source_line_count 1 "$dsa_dockerfile" 'FROM python:3.11-slim-bookworm' '共享 DSA Dockerfile 保留官方 Python 基础镜像'
assert_source_line_count 0 "$dsa_dockerfile" 'ARG DSA_WEB_BASE_IMAGE=node:20-slim' '共享 DSA Dockerfile 不暴露本地别名参数'
assert_source_line_count 1 "$dsa_dockerfile" 'RUN --mount=type=cache,target=/root/.npm npm ci' '共享 DSA Dockerfile 保留原有 npm cache 写法'
assert_source_line_count 0 "$dsa_dockerfile" 'RUN --mount=type=cache,id=dsa-web-npm,target=/root/.npm,sharing=locked npm ci' '共享 DSA Dockerfile 不包含本地命名 npm cache'
assert_equals 0 "$(grep -Eic 'aliyun|npmmirror' "$dsa_dockerfile" || true)" '共享 DSA Dockerfile 不包含 Aliyun 或 npmmirror'
assert_source_line_count 1 "$thesis_dockerfile" 'FROM node:24-alpine AS build' '共享 ThesisLedger 构建阶段保留官方基础镜像'
assert_source_line_count 1 "$thesis_dockerfile" 'FROM node:24-alpine AS runtime' '共享 ThesisLedger 运行阶段保留官方基础镜像'
assert_source_line_count 0 "$thesis_dockerfile" 'ARG THESIS_LEDGER_BASE_IMAGE=node:24-alpine' '共享 ThesisLedger Dockerfile 不暴露本地别名参数'
assert_source_line_count 1 "$thesis_dockerfile" 'RUN pnpm install --frozen-lockfile' '共享 ThesisLedger Dockerfile 保留原有 pnpm 安装写法'
assert_source_line_count 0 "$thesis_dockerfile" 'RUN --mount=type=cache,id=thesis-ledger-pnpm-store,target=/pnpm/store,sharing=locked \' '共享 ThesisLedger Dockerfile 不包含本地命名 pnpm cache'
assert_equals 0 "$(grep -Eic 'aliyun|npmmirror' "$thesis_dockerfile" || true)" '共享 ThesisLedger Dockerfile 不包含 Aliyun 或 npmmirror'
assert_equals 0 "$(grep -Ec 'DSA_(WEB|RUNTIME)_BASE_IMAGE|THESIS_LEDGER_BASE_IMAGE' "$infra_dir/compose.dev.yml" || true)" '共享 Compose 不包含本地基础镜像参数'

drift_root="$temp_dir/drift-workspace"
drift_case="$temp_dir/source-drift"
mkdir -p \
  "$drift_root/thesis-ledger-infra/scripts" \
  "$drift_root/daily-stock-analysis/docker" \
  "$drift_case/runtime"
cp "$update_script" "$drift_root/thesis-ledger-infra/scripts/update.sh"
: > "$drift_root/thesis-ledger-infra/compose.yml"
: > "$drift_root/thesis-ledger-infra/compose.dev.yml"
: > "$drift_root/thesis-ledger-infra/.env.example"
sed 's/^FROM node:20-slim AS web-builder$/FROM node:22-slim AS web-builder/' \
  "$dsa_dockerfile" > "$drift_root/daily-stock-analysis/docker/Dockerfile"
: > "$drift_case/docker.log"
: > "$drift_case/build-count"
: > "$drift_case/up-count"
: > "$drift_case/image-state"
printf '0\n' > "$drift_case/pull-count"
set +e
PATH="$temp_dir:$PATH" \
  FAKE_DOCKER_LOG="$drift_case/docker.log" \
  FAKE_DOCKER_BUILD_COUNT="$drift_case/build-count" \
  FAKE_DOCKER_UP_COUNT="$drift_case/up-count" \
  FAKE_DOCKER_IMAGE_STATE="$drift_case/image-state" \
  FAKE_DOCKER_PULL_COUNT="$drift_case/pull-count" \
  TMPDIR="$drift_case/runtime" \
  ENV_FILE=.env.example \
  bash "$drift_root/thesis-ledger-infra/scripts/update.sh" dsa > "$drift_case/output.log" 2>&1
drift_status=$?
set -e
assert_equals 1 "$drift_status" '共享 Dockerfile 基础镜像约定漂移时失败'
assert_equals 1 "$(count_calls "$drift_case/output.log" '共享 Dockerfile 约定已变化')" '约定漂移时输出明确诊断'
assert_equals 0 "$(count_calls "$drift_case/docker.log" 'pull ')" '约定漂移时不拉取镜像'
assert_equals 0 "$(count_calls "$drift_case/docker.log" ' build ')" '约定漂移时不开始构建'
assert_equals 0 "$(count_calls "$drift_case/docker.log" ' up ')" '约定漂移时不启动服务'
assert_directory_empty "$drift_case/runtime" '约定漂移失败后清理临时目录'

printf 'update.sh 分阶段更新、临时本地构建、基础镜像别名与缓存修复测试通过。\n'
