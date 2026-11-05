#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"
source "$script_dir/update-dsa-dockerfile.sh"

output_file="$(mktemp "${TMPDIR:-/tmp}/dsa-dockerfile-contract.XXXXXX")"
invalid_source="$(mktemp "${TMPDIR:-/tmp}/dsa-dockerfile-invalid.XXXXXX")"
trap 'rm -f "$output_file" "$invalid_source"' EXIT

source_digest="$(shasum -a 256 "$infra_dir/../daily-stock-analysis/docker/Dockerfile")"

create_local_dsa_dockerfile \
  "$infra_dir/../daily-stock-analysis/docker/Dockerfile" \
  "$output_file"

grep -Fqx 'FROM thesis-ledger-local-rust:1.94.1-slim-bookworm AS sdk-rust' "$output_file"
grep -Fqx 'FROM thesis-ledger-local-python:3.11-slim-bookworm AS sdk-builder' "$output_file"
grep -Fqx 'FROM thesis-ledger-local-python:3.11-slim-bookworm' "$output_file"
grep -Fqx 'CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]' "$output_file"
grep -Fqx 'COPY scripts/data-runtime-contract.json ./scripts/data-runtime-contract.json' "$output_file"
if grep -Eq 'web-builder|npm ci|COPY (bot|strategies|apps)/' "$output_file"; then
  printf '数据 Dockerfile 转换不得恢复产品构建依赖。\n' >&2
  exit 1
fi
grep -Fqx '    --mount=type=cache,id=dsa-sdk-apt-lists,target=/var/lib/apt/lists,sharing=locked \' "$output_file"
grep -Fqx '    --mount=type=cache,id=dsa-apt-lists,target=/var/lib/apt/lists,sharing=locked \' "$output_file"
grep -Fqx '    && rm -rf /var/lib/apt/lists/*' "$output_file"
grep -Fqx '    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 install -y --no-install-recommends git gcc g++ pkg-config libssl-dev \' "$output_file"
if grep -Fq 'COPY --from=longbridge_upstream' "$output_file"; then
  printf '默认共享构建不应要求宿主预取源。\n' >&2
  exit 1
fi

if [[ "$(grep -Fxc '    rm -f /etc/apt/apt.conf.d/docker-clean && \' "$output_file")" != 2 ]]; then
  printf 'SDK和运行镜像均须保留APT下载缓存。\n' >&2
  exit 1
fi
if [[ "$(grep -Fxc "    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \\" "$output_file")" != 2 ]]; then
  printf 'SDK和运行镜像均须转换为现有HTTPS镜像源。\n' >&2
  exit 1
fi
if [[ "$(grep -Fxc '    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=45 update && \' "$output_file")" != 2 ]]; then
  printf 'SDK和运行镜像均须采用有界APT下载重试。\n' >&2
  exit 1
fi
[[ "$source_digest" == "$(shasum -a 256 "$infra_dir/../daily-stock-analysis/docker/Dockerfile")" ]]

sed 's/no-install-recommends git gcc/no-install-recommends git clang/' "$infra_dir/../daily-stock-analysis/docker/Dockerfile" > "$invalid_source"
if create_local_dsa_dockerfile "$invalid_source" "$output_file.invalid" >/dev/null 2>&1; then
  rm -f "$output_file.invalid"
  printf 'SDK安装命令结构变化时未拒绝转换。\n' >&2
  exit 1
fi

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

create_local_dsa_dockerfile "$infra_dir/../daily-stock-analysis/docker/Dockerfile" "$output_file" true
grep -Fqx 'COPY --from=longbridge_upstream /source/ /sdk-upstream/' "$output_file"
grep -Fqx '    python scripts/build_thesis_ledger_longbridge_sdk.py --output /wheels --source-dir /sdk-upstream' "$output_file"
[[ "$source_digest" == "$(shasum -a 256 "$infra_dir/../daily-stock-analysis/docker/Dockerfile")" ]]
printf '固定 SDK 宿主源码构建上下文契约通过。\n'
