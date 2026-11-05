#!/usr/bin/env bash

longbridge_source_owned=false

prepare_longbridge_build_source() {
  service_is_selected dsa || return 0
  [[ -z "${REUSE_DSA_IMAGE_ID:-}" ]] || return 0
  if [[ "$longbridge_source_owned" == true && -d "$local_build_dir/sdk-source" ]]; then return 0; fi
  local interpreter="${LONG_BRIDGE_SOURCE_PYTHON:-$infra_dir/../daily-stock-analysis/.venv/bin/python}"
  if [[ ! -x "$interpreter" ]]; then
    printf '固定 SDK 源预取缺少现有 Python：%s；不自动安装。\n' "$interpreter" >&2
    return 1
  fi
  local source_script="$infra_dir/../daily-stock-analysis/scripts/build_thesis_ledger_longbridge_sdk.py"
  local source_key source_cache temporary_cache
  source_key="$(shasum -a 256 "$source_script" | awk '{print $1}')" || return 1
  source_cache="${LONG_BRIDGE_SOURCE_CACHE:-$infra_dir/.maintenance-backups/longbridge-source}/$source_key"
  local source_args=(--fetch-only --work-dir "$local_build_dir/sdk-source" --output "$local_build_dir/sdk-source-output")
  if [[ -d "$source_cache/source" ]]; then
    source_args+=(--source-dir "$source_cache/source")
    printf '复用固定 SDK 源码缓存；仍执行 revision、Git对象及干净工作树校验。\n'
  fi
  longbridge_source_owned=true
  local source_proxy="${HTTPS_PROXY:-${https_proxy:-}}"
  if [[ -z "$source_proxy" && -z "${ALL_PROXY:-}${all_proxy:-}" && "${OSTYPE:-}" == darwin* ]]; then
    source_proxy="$(/usr/sbin/scutil --proxy | awk '
      $1 == "HTTPSEnable" { enabled = $3 }
      $1 == "HTTPSProxy" { host = $3 }
      $1 == "HTTPSPort" { port = $3 }
      END { if (enabled == 1 && (host == "127.0.0.1" || host == "localhost") &&
        port ~ /^[0-9]+$/ && port > 0 && port < 65536) printf "http://%s:%s", host, port }')" || return 1
  fi
  local fetch_command=(env)
  if [[ -n "$source_proxy" ]]; then fetch_command+=("HTTPS_PROXY=$source_proxy"); fi
  "${fetch_command[@]}" "$interpreter" "$source_script" "${source_args[@]}" || return 1
  if [[ ! -d "$source_cache/source" ]]; then
    mkdir -p "$(dirname "$source_cache")" || return 1
    temporary_cache="$(mktemp -d "$(dirname "$source_cache")/.source.XXXXXX")" || return 1
    cp -R "$local_build_dir/sdk-source/source" "$temporary_cache/source" || return 1
    mv "$temporary_cache" "$source_cache" || return 1
  fi
}

cleanup_longbridge_build_source() {
  if [[ "$longbridge_source_owned" == true && -n "$local_build_dir" && -d "$local_build_dir" ]]; then
    rm -rf "$local_build_dir/sdk-source" "$local_build_dir/sdk-source-output"
  fi
}
