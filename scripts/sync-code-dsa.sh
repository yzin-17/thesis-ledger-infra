#!/usr/bin/env bash
# 只由 sync-code.sh 在统一前置检查后使用；此模块没有独立更新入口。

preflight_dsa_compatibility() {
  local container_id baseline="$work_dir/dsa-runtime-inputs.json" command mounts="$work_dir/dsa-mounts.json"
  container_id="$(container_id_for_service dsa)"
  node "$infra_dir/scripts/dsa-code-payload.mjs" contract "$dsa_dir"
  require_matching_file "$dsa_dir/requirements.txt" "$container_id" /app/requirements.txt dsa-requirements.txt
  require_matching_file "$dsa_dir/scripts/data-runtime-contract.json" "$container_id" \
    /app/scripts/data-runtime-contract.json dsa-runtime-contract.json
  if ! docker cp "$container_id:/app/scripts/data-runtime-inputs.json" "$baseline" >/dev/null 2>&1; then
    print_error 'DSA 镜像缺少构建兼容基线；请使用 ./scripts/update.sh dsa。'
    return 1
  fi
  node "$infra_dir/scripts/dsa-code-payload.mjs" verify "$dsa_dir" "$baseline"
  docker inspect --format '{{json .Mounts}}' "$container_id" > "$mounts"
  node "$infra_dir/scripts/dsa-code-payload.mjs" mounts "$mounts"
  command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
  if [[ "$command" != '["python","-m","uvicorn","server:app","--host","0.0.0.0","--port","8000"]' ]]; then
    print_error 'DSA 当前容器启动入口不兼容数据快更，请使用 ./scripts/update.sh dsa。'
    return 1
  fi
}

build_dsa_payload() {
  printf '装配 DSA 数据代码与资产载荷...\n'
  node "$infra_dir/scripts/dsa-code-payload.mjs" build "$dsa_dir" "$work_dir/dsa-payload"
}

sync_dsa_container() {
  local container_id payload_dir="$work_dir/dsa-payload"
  container_id="$(container_id_for_service dsa)"
  docker exec -u 0 "$container_id" mkdir -p "$container_stage"
  docker cp "$payload_dir/." "$container_id:$container_stage/"
  docker exec -i -u 0 "$container_id" sh -s "$container_stage" \
    < "$infra_dir/scripts/sync-dsa-files.sh"
}
