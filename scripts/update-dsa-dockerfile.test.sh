#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"
source "$script_dir/update-dsa-dockerfile.sh"

output_file="$(mktemp "${TMPDIR:-/tmp}/dsa-dockerfile-contract.XXXXXX")"
trap 'rm -f "$output_file"' EXIT

create_local_dsa_dockerfile \
  "$infra_dir/../daily-stock-analysis/docker/Dockerfile" \
  "$output_file"

grep -Fqx 'FROM thesis-ledger-local-rust:1.94.1-slim-bookworm AS sdk-rust' "$output_file"
grep -Fqx 'FROM thesis-ledger-local-python:3.11-slim-bookworm AS sdk-builder' "$output_file"
grep -Fqx 'FROM thesis-ledger-local-python:3.11-slim-bookworm' "$output_file"
grep -Fqx '    --mount=type=cache,id=dsa-sdk-apt-lists,target=/var/lib/apt/lists,sharing=locked \' "$output_file"
grep -Fqx '    --mount=type=cache,id=dsa-apt-lists,target=/var/lib/apt/lists,sharing=locked \' "$output_file"
grep -Fqx '    && rm -rf /var/lib/apt/lists/*' "$output_file"

if [[ "$(grep -Fxc '    && rm -rf /var/lib/apt/lists/*' "$output_file")" != 1 ]]; then
  printf 'SDK 与 runtime 的 apt lists 清理策略未按 stage 保留。\n' >&2
  exit 1
fi
if [[ "$(grep -Fxc 'RUN --mount=type=cache,id=dsa-apt-archives,target=/var/cache/apt,sharing=locked \' "$output_file")" != 1 ]]; then
  printf 'runtime apt cache mount 契约异常。\n' >&2
  exit 1
fi
if [[ "$(grep -Fxc 'RUN --mount=type=cache,id=dsa-sdk-apt-archives,target=/var/cache/apt,sharing=locked \' "$output_file")" != 1 ]]; then
  printf 'SDK apt cache mount 契约异常。\n' >&2
  exit 1
fi
if grep -Fq 'FROM rust:1.94.1-slim-bookworm' "$output_file"; then
  printf '生成 Dockerfile 仍引用远端 rust 基础镜像。\n' >&2
  exit 1
fi

printf 'DSA 临时 Dockerfile 转换契约通过。\n'
