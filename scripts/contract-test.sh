#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$workspace_root/scripts/market-v3-contract-test.sh"
node "$workspace_root/../thesis-ledger/scripts/market-v3-business-smoke.mjs"
