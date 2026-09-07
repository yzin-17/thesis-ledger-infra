#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_DOCKER_LOG:?FAKE_DOCKER_LOG is required}"
build_count_file="${FAKE_DOCKER_BUILD_COUNT:?FAKE_DOCKER_BUILD_COUNT is required}"
build_failures="${FAKE_DOCKER_BUILD_FAILURES:-0}"
build_error="${FAKE_DOCKER_BUILD_ERROR:-模拟构建失败}"
up_count_file="${FAKE_DOCKER_UP_COUNT:?FAKE_DOCKER_UP_COUNT is required}"
up_failures="${FAKE_DOCKER_UP_FAILURES:-0}"
inspect_status="${FAKE_DOCKER_INSPECT_STATUS:-running}"
inspect_health="${FAKE_DOCKER_INSPECT_HEALTH:-healthy}"
image_state_file="${FAKE_DOCKER_IMAGE_STATE:?FAKE_DOCKER_IMAGE_STATE is required}"
pull_count_file="${FAKE_DOCKER_PULL_COUNT:?FAKE_DOCKER_PULL_COUNT is required}"
pull_fail_at="${FAKE_DOCKER_PULL_FAIL_AT:-0}"

printf '%s\n' "$*" >> "$log_file"

if [[ "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "${1:-}" == "builder" && "${2:-}" == "prune" ]]; then
  exit 0
fi

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  grep -Fxq -- "${3:-}" "$image_state_file"
  exit $?
fi

if [[ "${1:-}" == "pull" ]]; then
  pull_count=0
  if [[ -f "$pull_count_file" ]]; then
    pull_count="$(<"$pull_count_file")"
  fi
  pull_count=$((pull_count + 1))
  printf '%s\n' "$pull_count" > "$pull_count_file"

  if ((pull_fail_at > 0 && pull_count == pull_fail_at)); then
    exit 25
  fi

  if ! grep -Fxq -- "${2:-}" "$image_state_file"; then
    printf '%s\n' "${2:-}" >> "$image_state_file"
  fi
  exit 0
fi

if [[ "${1:-}" == "tag" ]]; then
  if ! grep -Fxq -- "${2:-}" "$image_state_file"; then
    exit 26
  fi
  if ! grep -Fxq -- "${3:-}" "$image_state_file"; then
    printf '%s\n' "${3:-}" >> "$image_state_file"
  fi
  exit 0
fi

if [[ "${1:-}" == "inspect" ]]; then
  if [[ "$*" == *".State.Status"* ]]; then
    printf '%s\n' "$inspect_status"
  else
    printf '%s\n' "$inspect_health"
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

compose_file=""
expect_compose_file=false
for argument in "$@"; do
  if [[ "$expect_compose_file" == true ]]; then
    compose_file="$argument"
    expect_compose_file=false
  elif [[ "$argument" == "-f" ]]; then
    expect_compose_file=true
  fi
done

if [[ -z "$compose_file" || ! -f "$compose_file" ]]; then
  printf '未找到本地 Compose override: %s\n' "$compose_file" >&2
  exit 27
fi

printf 'local-compose-override %s\n' "$compose_file" >> "$log_file"
if grep -Fq '  dsa:' "$compose_file"; then
  printf 'local-compose-service dsa\n' >> "$log_file"
fi
if grep -Fq '  thesis-ledger:' "$compose_file"; then
  printf 'local-compose-service thesis-ledger\n' >> "$log_file"
fi

while IFS= read -r dockerfile_path; do
  if [[ ! -f "$dockerfile_path" ]]; then
    printf '本地 Dockerfile 不存在: %s\n' "$dockerfile_path" >&2
    exit 28
  fi
  printf 'local-dockerfile %s\n' "$dockerfile_path" >> "$log_file"
  grep -E '^(# syntax=|FROM |ENV COREPACK_NPM_REGISTRY=|RUN --mount=|    --mount=|    sed -i|    apt-get|    npm_config_(registry|disturl)=|COPY (apps/(desktop|mobile)|packages/api-client|services/dsa-adapter))' \
    "$dockerfile_path" >> "$log_file" || true
done < <(sed -n 's/^[[:space:]]*dockerfile:[[:space:]]*//p' "$compose_file")

build_count=0
if [[ -f "$build_count_file" ]]; then
  build_count="$(<"$build_count_file")"
fi
build_count=$((build_count + 1))
printf '%s\n' "$build_count" > "$build_count_file"

if ((build_count <= build_failures)); then
  printf '%s\n' "$build_error" >&2
  exit 23
fi
