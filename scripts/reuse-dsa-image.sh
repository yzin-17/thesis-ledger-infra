#!/usr/bin/env bash

# 仅由正式更新入口在持有更新锁时调用；操作者选择本轮已完成且源码未变的产物。
validate_reused_dsa_image() {
  local expected="$1" actual service contract runtime
  if [[ ! "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'REUSE_DSA_IMAGE_ID 必须是完整 SHA256 镜像 ID。\n' >&2
    return 1
  fi
  actual="$(docker --context "$build_space_builder" image inspect --format '{{.Id}}' daily-stock-analysis:thesisledger-dev)" || return 1
  service="$(docker --context "$build_space_builder" image inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$expected")" || return 1
  contract="$(docker --context "$build_space_builder" image inspect --format '{{index .Config.Labels "org.openai.thesis-ledger.contract"}}' "$expected")" || return 1
  runtime="$(docker --context "$build_space_builder" image inspect --format '{{index .Config.Labels "org.openai.thesis-ledger.data-runtime"}}' "$expected")" || return 1
  if [[ "$actual" != "$expected" || "$service" != dsa || "$contract" != 1 || "$runtime" != dsa-data-runtime-v1 ]]; then
    printf 'DSA 镜像 ID、服务或契约不匹配，停止复用。\n' >&2
    return 1
  fi
}
