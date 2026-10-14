#!/usr/bin/env bash

longbridge_source_owned=false

prepare_longbridge_build_source() {
  service_is_selected dsa || return 0
  [[ -z "${REUSE_DSA_IMAGE_ID:-}" ]] || return 0
  local interpreter="${LONG_BRIDGE_SOURCE_PYTHON:-$infra_dir/../daily-stock-analysis/.venv/bin/python}"
  if [[ ! -x "$interpreter" ]]; then
    printf '固定 SDK 源预取缺少现有 Python：%s；不自动安装。\n' "$interpreter" >&2
    return 1
  fi
  longbridge_source_owned=true
  "$interpreter" "$infra_dir/../daily-stock-analysis/scripts/build_thesis_ledger_longbridge_sdk.py" \
    --fetch-only --work-dir "$local_build_dir/sdk-source" --output "$local_build_dir/sdk-source-output"
}

cleanup_longbridge_build_source() {
  if [[ "$longbridge_source_owned" == true && -n "$local_build_dir" && -d "$local_build_dir" ]]; then
    rm -rf "$local_build_dir/sdk-source" "$local_build_dir/sdk-source-output"
  fi
}
