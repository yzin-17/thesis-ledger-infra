#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/reuse-dsa-image.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/reuse-dsa-image-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
awk '/^run_build_command\(\)/ {capture=1} capture {print} capture && /^}/ {capture=0}' "$script_dir/update.sh" > "$test_dir/build.sh"
source "$test_dir/build.sh"
build_space_builder=desktop-linux
image="sha256:$(printf '%064d' 1)"
inspected_image="$image" service_label=dsa contract_label=1
docker() {
  case "$*" in
    *'--format {{.Id}}'*) printf '%s\n' "$inspected_image" ;;
    *com.docker.compose.service*) printf '%s\n' "$service_label" ;;
    *org.openai.thesis-ledger.contract*) printf '%s\n' "$contract_label" ;;
    *) return 1 ;;
  esac
}
fail() { printf '失败：%s\n' "$*" >&2; exit 1; }
if validate_reused_dsa_image bad 2>/dev/null; then fail '非法ID应拒绝'; fi
validate_reused_dsa_image "$image"
inspected_image="sha256:$(printf '%064d' 2)"
if validate_reused_dsa_image "$image" 2>/dev/null; then fail '标签变化应拒绝'; fi
inspected_image="$image" service_label=other
if validate_reused_dsa_image "$image" 2>/dev/null; then fail '服务错配应拒绝'; fi
service_label=dsa contract_label=0
if validate_reused_dsa_image "$image" 2>/dev/null; then fail '契约错配应拒绝'; fi
contract_label=1
app_services=(dsa thesis-ledger)
build_log="$test_dir/log"
ensure_build_space() { fail '构建阶段不应重复空间预检'; }
protect_completed_build_image() { printf 'protect %s\n' "$1" >> "$test_dir/trace"; }
build_compose_service() { printf 'build %s\n' "$1" >> "$test_dir/trace"; }
unset REUSE_DSA_IMAGE_ID
run_build_command >/dev/null
grep -Fq 'build dsa' "$test_dir/trace" || fail '默认应构建DSA'
grep -Fq 'build thesis-ledger' "$test_dir/trace" || fail '默认应构建Server'
: > "$test_dir/trace"
REUSE_DSA_IMAGE_ID="$image"
run_build_command >/dev/null
if grep -Fq 'build dsa' "$test_dir/trace"; then fail '复用不应重建DSA'; fi
grep -Fq 'protect dsa' "$test_dir/trace" || fail '复用仍保护镜像'
grep -Fq 'build thesis-ledger' "$test_dir/trace" || fail '复用仍构建Server'
printf 'DSA精确产物复用、非法ID与错配拒绝、默认构建和入口空间检查回归通过。\n'
