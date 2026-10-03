#!/usr/bin/env bash

# 由 update.sh 在覆盖可变开发镜像标签前调用；只固定现有运行容器所用镜像。
retain_rollback_images() {
  local service container_service container_id image_id repository reference retained_id
  local container_services

  for service in "$@"; do
    case "$service" in
      dsa) repository=daily-stock-analysis; container_services="dsa" ;;
      thesis-ledger) repository=thesis-ledger; container_services="thesis-ledger backtest-worker" ;;
      *) printf '不支持固定回退镜像的服务: %s\n' "$service" >&2; return 1 ;;
    esac

    for container_service in $container_services; do
      if ! container_id="$("${compose_args[@]}" ps -q "$container_service")"; then
        printf '无法查询运行容器，停止镜像更新: %s\n' "$container_service" >&2
        return 1
      fi
      container_id="${container_id%%$'\n'*}"
      if [[ -z "$container_id" ]]; then
        printf '服务没有运行容器，跳过旧镜像固定: %s\n' "$container_service"
        continue
      fi

      image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
      if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf '运行容器镜像 ID 非法: %s\n' "$container_service" >&2
        return 1
      fi

      reference="$repository:rollback-${image_id#sha256:}"
      if retained_id="$(docker image inspect --format '{{.Id}}' "$reference" 2>&1)"; then
        :
      elif [[ "$retained_id" == *"No such image: $reference"* ]]; then
        retained_id=""
      else
        printf '无法核对回退镜像标签: %s\n' "$reference" >&2
        return 1
      fi
      if [[ -n "$retained_id" && "$retained_id" != "$image_id" ]]; then
        printf '回退镜像标签身份冲突: %s\n' "$reference" >&2
        return 1
      fi
      if [[ -z "$retained_id" ]]; then
        docker tag "$image_id" "$reference" || return 1
      fi
      retained_id="$(docker image inspect --format '{{.Id}}' "$reference")" || return 1
      if [[ "$retained_id" != "$image_id" ]]; then
        printf '回退镜像固定后身份不一致: %s\n' "$reference" >&2
        return 1
      fi
      printf '已固定当前运行镜像: %s -> %s\n' "$container_service" "$reference"
    done
  done
}
