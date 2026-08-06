#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ensure_repo() {
  local url="$1"
  local path="$2"
  if [[ -d "$path/.git" ]]; then
    printf '已存在，保留当前工作树: %s\n' "$path"
    return
  fi
  if [[ -e "$path" ]]; then
    printf '目标路径已存在但不是 Git 仓库: %s\n' "$path" >&2
    exit 1
  fi
  git clone "$url" "$path"
}

ensure_repo "${THESIS_LEDGER_REPO_URL:-https://github.com/yzin-17/thesis-ledger.git}" \
  "$workspace_root/thesis-ledger"
ensure_repo "${DSA_REPO_URL:-https://github.com/yzin-17/daily_stock_analysis.git}" \
  "$workspace_root/daily-stock-analysis"

printf '工作区准备完成: %s\n' "$workspace_root"
