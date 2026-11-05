#!/usr/bin/env bash
# 由正式更新在空间整备、构建、容器变更之前调用。
record_dsa_runtime_checkpoint() {
  service_is_selected dsa || return 0
  local image_id output
  output="$(mktemp "${TMPDIR:-/tmp}/dsa-runtime-checkpoint.XXXXXX")" || return 1
  if ! node "$infra_dir/scripts/dsa-runtime-recovery.mjs" snapshot \
      "$infra_dir" "$env_file" "$build_space_lock" > "$output"; then
    rm -f "$output"
    return 1
  fi
  image_id="$(cat "$output")"
  rm -f "$output"
  if [[ -n "$image_id" ]]; then
    export ROLLBACK_PROTECTED_IMAGES="${ROLLBACK_PROTECTED_IMAGES:-} $image_id"
    local mounts="$infra_dir/.maintenance-backups/dsa-runtime/mounts.compose.json"
    case " ${compose_args[*]} " in
      *" $mounts "*) ;;
      *) compose_args+=(-f "$mounts") ;;
    esac
  fi
}
