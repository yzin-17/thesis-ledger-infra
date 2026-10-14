#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prune-failed-build-history.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/failed-build-records.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
build_space_builder=desktop-linux
record_state=failed
idle=true
require_idle_builder() { [[ "$idle" == true ]]; }
docker() {
  case "$*" in
    *'history inspect'*) printf '%s\n' "$record_state" ;;
    *'history rm'*) printf '%s\n' "$*" >> "$test_dir/removed" ;;
    *) return 1 ;;
  esac
}
reject() { if remove_failed_build_records "$@" >"$test_dir/output" 2>&1; then printf '不应允许删除\n' >&2; exit 1; fi; [[ ! -f "$test_dir/removed" ]]; }
reject
reject --all
reject 'bad/id'
record_state=completed
reject 43zfa8y7f3246xxp0asdetus6
record_state=running
reject 43zfa8y7f3246xxp0asdetus6
record_state=unknown
reject 43zfa8y7f3246xxp0asdetus6
record_state=failed
idle=false
reject 43zfa8y7f3246xxp0asdetus6
idle=true
remove_failed_build_records 43zfa8y7f3246xxp0asdetus6 wuoqlmt32hkiqe014h5nsllw3 >"$test_dir/output"
[[ "$(wc -l < "$test_dir/removed" | tr -d ' ')" == 2 ]]
! grep -Eq -- '--all|--force' "$test_dir/removed"
grep -q '43zfa8y7f3246xxp0asdetus6$' "$test_dir/removed"
grep -q 'wuoqlmt32hkiqe014h5nsllw3$' "$test_dir/removed"
printf '失败构建记录拒绝规则、空闲保护与精确删除通过。\n'
