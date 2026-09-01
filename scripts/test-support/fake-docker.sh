#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_DOCKER_LOG:?FAKE_DOCKER_LOG is required}"
build_count_file="${FAKE_DOCKER_BUILD_COUNT:?FAKE_DOCKER_BUILD_COUNT is required}"
build_failures="${FAKE_DOCKER_BUILD_FAILURES:-0}"
up_count_file="${FAKE_DOCKER_UP_COUNT:?FAKE_DOCKER_UP_COUNT is required}"
up_failures="${FAKE_DOCKER_UP_FAILURES:-0}"

printf '%s\n' "$*" >> "$log_file"

if [[ "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "${1:-}" == "builder" && "${2:-}" == "prune" ]]; then
  exit 0
fi

if [[ "${1:-}" == "inspect" ]]; then
  if [[ "$*" == *".State.Status"* ]]; then
    printf 'running\n'
  else
    printf 'healthy\n'
  fi
  exit 0
fi

if [[ "${1:-}" != "compose" ]]; then
  exit 0
fi

if [[ " $* " == *" ps -aq "* ]]; then
  printf 'fake-container\n'
  exit 0
fi

if [[ " $* " == *" up -d --no-build "* ]]; then
  up_count=0
  if [[ -f "$up_count_file" ]]; then
    up_count="$(<"$up_count_file")"
  fi
  up_count=$((up_count + 1))
  printf '%s\n' "$up_count" > "$up_count_file"

  if ((up_count <= up_failures)); then
    exit 24
  fi

  exit 0
fi

if [[ " $* " != *" build "* ]]; then
  exit 0
fi

build_count=0
if [[ -f "$build_count_file" ]]; then
  build_count="$(<"$build_count_file")"
fi
build_count=$((build_count + 1))
printf '%s\n' "$build_count" > "$build_count_file"

if ((build_count <= build_failures)); then
  exit 23
fi
