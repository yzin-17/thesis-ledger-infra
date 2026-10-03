#!/usr/bin/env bash
set -euo pipefail

infra_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$infra_root/../thesis-ledger/scripts/market-v3-contract-smoke.mjs"
node "$infra_root/scripts/check-compatibility.mjs"
if [[ ! -f "$probe" ]]; then
  printf '缺少 V3 契约检查入口\n' >&2
  exit 1
fi
node "$probe"
