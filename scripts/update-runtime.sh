#!/usr/bin/env bash
# 正式更新的阶段编排，仅由 update.sh 在统一配置检查后调用。

run_update() {
  local exit_code service

  init_build_network || return 1
  validate_rollback_image_policy || return 1

  if ! create_local_build_override; then
    printf '本地临时构建定义生成失败；未拉取镜像，也未开始构建或启动。\n' >&2
    return 1
  fi

  printf '使用环境文件: %s\n' "$env_file"
  printf '更新目标: %s\n' "${app_services[*]}"

  init_build_space || return 1
  acquire_build_space_lock || return 1
  record_dsa_runtime_checkpoint || return 1
  if [[ -n "${REUSE_DSA_IMAGE_ID:-}" ]]; then
    if [[ "$target" != all && "$target" != dsa ]]; then
      printf 'DSA 镜像复用仅适用于 all 或 dsa 目标。\n' >&2
      return 1
    fi
    validate_reused_dsa_image "$REUSE_DSA_IMAGE_ID" || return 1
  fi
  if [[ -n "${REUSE_THESIS_LEDGER_IMAGE_ID:-}" ]]; then
    validate_reused_thesis_ledger_image "$REUSE_THESIS_LEDGER_IMAGE_ID" || return 1
  fi
  prepare_build_space_probe || return 1
  if [[ "$update_space_mode" == compact ]]; then
    prepare_longbridge_build_source || return 1
    reinstall_preserving_volumes '显式 compact 维护' || return 1
  elif ensure_build_space '拉取前'; then
    :
  else
    exit_code=$?
    if ((exit_code == 76)) && [[ "$repair_build_cache" == true ]]; then
      reinstall_preserving_volumes '整备后零余量' || return 1
    else
      printf '构建空间预检失败；未开始应用构建。\n' >&2
      return "$exit_code"
    fi
  fi
  initialize_empty_development_volumes || return 1
  if [[ "$build_space_reinstalled" != true ]]; then prepare_longbridge_build_source || return 1; fi

  if ! retain_rollback_images "${app_services[@]}"; then
    printf '当前运行镜像未能安全固定；停止更新，尚未覆盖应用镜像。\n' >&2
    return 1
  fi

  if [[ "$pull_service_images" == true ]]; then
    printf '拉取 PostgreSQL 和 Redis 服务镜像...\n'
    if "${compose_args[@]}" pull postgres redis; then
      :
    else
      exit_code=$?
      printf '基础服务镜像拉取失败，退出码: %s\n' "$exit_code" >&2
      return "$exit_code"
    fi
  fi

  if ! prepare_base_images; then
    printf '应用基础镜像准备失败；未开始应用镜像构建，现有本地别名保持不变。\n' >&2
    return 1
  fi

  printf '构建应用镜像: %s\n' "${app_services[*]}"
  if run_build_with_retry; then
    :
  else
    exit_code=$?
    printf '应用镜像构建失败，退出码: %s。\n' "$exit_code" >&2
    print_status >&2
    printf '未自动停止其他进程，也未删除任何 Docker 数据卷。\n' >&2
    return "$exit_code"
  fi

  if ! require_idle_builder || ! maintain_build_cache '构建后'; then
    printf '警告：应用镜像已构建，但构建后 BuildKit cache 维护失败；继续启动目标服务。\n' >&2
  fi

  prepare_database_for_update || return 1

  start_updated_services || return 1
  rm -f "$infra_dir/.maintenance-backups/docker-space-recovery/incomplete"

  printf '\n源码栈更新完成，当前状态:\n'
  "${compose_args[@]}" ps || return 1
  if ! prune_rollback_images_after_update; then
    printf '警告：服务更新已完成，但历史回滚镜像维护失败；停止后续淘汰，不重新构建。\n' >&2
    return 0
  fi
  if ! finalize_update_space; then
    printf '警告：新服务健康，但最终空间维护未全部完成；保留错误，不重新构建。\n' >&2
  fi
}

