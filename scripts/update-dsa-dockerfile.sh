#!/usr/bin/env bash

append_local_dsa_build_override() {
  local source_file="$1" target_file="$2" sdk_source_dir="$3" override_file="$4"
  create_local_dsa_dockerfile "$source_file" "$target_file" true || return 1
  printf '  dsa:\n    build:\n      dockerfile: %s\n      additional_contexts:\n        longbridge_upstream: %s\n' \
    "$target_file" "$sdk_source_dir" >> "$override_file"
}

dsa_require_exact_line() {
  local source_file="$1" expected_line="$2" expected_count="$3" actual_count

  actual_count="$(grep -Fxc -- "$expected_line" "$source_file" || true)"
  if [[ "$actual_count" != "$expected_count" ]]; then
    printf '共享 DSA Dockerfile 约定已变化：%s 中 `%s` 期望 %s 行，实际 %s 行。\n' \
      "$source_file" "$expected_line" "$expected_count" "$actual_count" >&2
    printf '请同步更新 scripts/update-dsa-dockerfile.sh 的本地 Dockerfile 变换映射后再重试。\n' >&2
    return 1
  fi
}

create_local_dsa_dockerfile() {
  local source_file="$1" target_file="$2" prefetched_source="${3:-false}"

  if [[ ! -f "$source_file" ]]; then
    printf 'DSA Dockerfile 不存在: %s\n' "$source_file" >&2
    return 1
  fi

  dsa_require_exact_line "$source_file" '# syntax=docker/dockerfile:1.7' 1 || return 1
  dsa_require_exact_line "$source_file" 'FROM node:20-slim AS web-builder' 1 || return 1
  dsa_require_exact_line "$source_file" 'FROM rust:1.94.1-slim-bookworm AS sdk-rust' 1 || return 1
  dsa_require_exact_line "$source_file" 'FROM python:3.11-slim-bookworm AS sdk-builder' 1 || return 1
  dsa_require_exact_line "$source_file" 'FROM python:3.11-slim-bookworm' 1 || return 1
  dsa_require_exact_line "$source_file" 'RUN --mount=type=cache,target=/root/.npm npm ci' 1 || return 1
  dsa_require_exact_line "$source_file" 'RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \' 2 || return 1
  dsa_require_exact_line "$source_file" '    rm -f /etc/apt/apt.conf.d/docker-clean && \' 1 || return 1
  dsa_require_exact_line "$source_file" "    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \\" 0 || return 1
  dsa_require_exact_line "$source_file" '    apt-get update && apt-get install -y --no-install-recommends \' 1 || return 1
  dsa_require_exact_line "$source_file" '    apt-get update && apt-get install -y --no-install-recommends git gcc g++ pkg-config libssl-dev \' 1 || return 1
  dsa_require_exact_line "$source_file" '    libxext6 \' 1 || return 1
  dsa_require_exact_line "$source_file" '    && rm -rf /var/lib/apt/lists/*' 2 || return 1
  dsa_require_exact_line "$source_file" 'RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt' 1 || return 1
  dsa_require_exact_line "$source_file" '    python scripts/build_thesis_ledger_longbridge_sdk.py --output /wheels' 1 || return 1

  awk -v sq="'" -v prefetched_source="$prefetched_source" '
    $0 == "WORKDIR /sdk-build" && prefetched_source == "true" {
      print
      print "COPY --from=longbridge_upstream /source/ /sdk-upstream/"
      next
    }
    $0 == "    python scripts/build_thesis_ledger_longbridge_sdk.py --output /wheels" && prefetched_source == "true" {
      print "    python scripts/build_thesis_ledger_longbridge_sdk.py --output /wheels --source-dir /sdk-upstream"
      next
    }
    $0 == "# syntax=docker/dockerfile:1.7" { next }
    $0 == "FROM node:20-slim AS web-builder" {
      stage = "web"
      print "FROM thesis-ledger-local-node:20-slim AS web-builder"
      next
    }
    $0 == "FROM rust:1.94.1-slim-bookworm AS sdk-rust" {
      stage = "sdk-rust"
      print "FROM thesis-ledger-local-rust:1.94.1-slim-bookworm AS sdk-rust"
      next
    }
    $0 == "FROM python:3.11-slim-bookworm AS sdk-builder" {
      stage = "sdk"
      print "FROM thesis-ledger-local-python:3.11-slim-bookworm AS sdk-builder"
      next
    }
    $0 == "FROM python:3.11-slim-bookworm" {
      stage = "runtime"
      print "FROM thesis-ledger-local-python:3.11-slim-bookworm"
      next
    }
    $0 == "RUN --mount=type=cache,target=/root/.npm npm ci" {
      print "RUN --mount=type=cache,id=dsa-web-npm,target=/root/.npm,sharing=locked npm ci"
      next
    }
    $0 == "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\" {
      if (stage == "sdk") {
        print "RUN --mount=type=cache,id=dsa-sdk-apt-archives,target=/var/cache/apt,sharing=locked \\"
        print "    --mount=type=cache,id=dsa-sdk-apt-lists,target=/var/lib/apt/lists,sharing=locked \\"
      } else if (stage == "runtime") {
        print "RUN --mount=type=cache,id=dsa-apt-archives,target=/var/cache/apt,sharing=locked \\"
        print "    --mount=type=cache,id=dsa-apt-lists,target=/var/lib/apt/lists,sharing=locked \\"
      } else {
        print
      }
      next
    }
    $0 == "    rm -f /etc/apt/apt.conf.d/docker-clean && \\" {
      print
      print "    sed -i " sq "s|http://deb.debian.org|https://mirrors.aliyun.com|g" sq " /etc/apt/sources.list.d/debian.sources && \\"
      next
    }
    $0 == "    apt-get update && apt-get install -y --no-install-recommends \\" {
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 update && \\"
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 install -y --no-install-recommends \\"
      next
    }
    $0 == "    apt-get update && apt-get install -y --no-install-recommends git gcc g++ pkg-config libssl-dev \\" {
      print "    rm -f /etc/apt/apt.conf.d/docker-clean && \\"
      print "    sed -i " sq "s|http://deb.debian.org|https://mirrors.aliyun.com|g" sq " /etc/apt/sources.list.d/debian.sources && \\"
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 update && \\"
      print "    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 install -y --no-install-recommends git gcc g++ pkg-config libssl-dev \\"
      next
    }
    $0 == "    libxext6 \\" {
      print "    libxext6"
      next
    }
    $0 == "    && rm -rf /var/lib/apt/lists/*" {
      if (stage == "sdk") {
        print
      }
      next
    }
    $0 == "RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt" {
      print "RUN --mount=type=cache,id=dsa-pip,target=/root/.cache/pip,sharing=locked pip install -r requirements.txt"
      next
    }
    { print }
  ' "$source_file" > "$target_file"
}
