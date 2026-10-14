#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 1)); then
  printf '用法: bash scripts/docker-desktop.sh [start|status]\n' >&2
  exit 2
fi
case "$1" in
  status) docker info >/dev/null ;;
  start)
    if docker info >/dev/null 2>&1; then
      printf 'Docker daemon 已可用，无需启动。\n'
      exit 0
    fi
    docker desktop start --timeout 45
    docker info >/dev/null
    printf 'Docker daemon 启动后检查通过。\n'
    ;;
  *) printf '仅支持 start 或 status。\n' >&2; exit 2 ;;
esac
