#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_script="$workspace_root/../thesis-ledger/scripts/thesis-ledger-contract-smoke.mjs"

node "$workspace_root/scripts/check-compatibility.mjs"

if [[ ! -f "$test_script" ]]; then
  printf '缺少主仓契约测试: %s\n' "$test_script" >&2
  exit 1
fi

node "$test_script"
