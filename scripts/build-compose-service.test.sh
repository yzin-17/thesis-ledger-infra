#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/build-compose-service.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/build-compose-network.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
trace="$test_dir/trace"
infra_dir="$test_dir/infra"
local_build_dir="$test_dir/local build"
build_space_builder=desktop-linux
compose_args=(docker compose --env-file example.env)
docker() {
  printf '<%s>' "$@" >> "$trace"
  printf '\n' >> "$trace"
  if [[ "$*" == *'build --print'* ]]; then printf '{}\n'; else cat >/dev/null; fi
}

unset BUILD_HTTP_PROXY BUILD_HTTPS_PROXY BUILD_NO_PROXY BUILD_ALPINE_MIRROR
init_build_network
build_compose_service dsa
if grep -Fq '<--set>' "$trace"; then echo '缺省行为意外加入代理' >&2; exit 1; fi
grep -Fq '<--builder><desktop-linux>' "$trace"
grep -Fq '<--allow><fs.read='"$local_build_dir"'>' "$trace"

: > "$trace"
BUILD_HTTP_PROXY=http://host.docker.internal:7890
BUILD_HTTPS_PROXY=http://host.docker.internal:7890
BUILD_NO_PROXY=localhost,127.0.0.1,::1
init_build_network
build_compose_service thesis-ledger
grep -Fq '<--set><*.args.HTTP_PROXY=http://host.docker.internal:7890>' "$trace"
grep -Fq '<--set><*.args.HTTPS_PROXY=http://host.docker.internal:7890>' "$trace"
grep -Fq '<--set><*.args.NO_PROXY=localhost,127.0.0.1,::1>' "$trace"
grep -Fq '<thesis-ledger>' "$trace"

for invalid in 'socks5://proxy:7890' 'proxy:7890' 'https://proxy invalid' $'http://proxy\ninvalid'; do
  BUILD_HTTP_PROXY="$invalid"
  if init_build_network >/dev/null 2>&1; then echo '非法代理未被拒绝' >&2; exit 1; fi
done
unset BUILD_HTTP_PROXY BUILD_HTTPS_PROXY
BUILD_NO_PROXY=$'localhost\ninvalid'
if init_build_network >/dev/null 2>&1; then echo '排除项换行未被拒绝' >&2; exit 1; fi
unset BUILD_NO_PROXY
init_build_network
[[ ${#build_network_options[@]} == 0 ]]
printf '构建网络参数的缺省、透传、引用、非法输入及重置检查通过。\n'

original='FROM base AS build
RUN apk add --no-cache g++ make python3
FROM base AS runtime'
[[ "$(printf '%s\n' "$original" | rewrite_build_apk_mirror)" == "$original" ]]
BUILD_ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
init_build_network
rendered="$(printf '%s\n' "$original" | rewrite_build_apk_mirror)"
[[ "$rendered" == *"s|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.tuna.tsinghua.edu.cn/alpine|g"* ]]
[[ "$rendered" == *'RUN apk add --no-cache g++ make python3'* ]]
[[ "$rendered" != *'allow-untrusted'* ]]
for invalid in 'http://mirror/alpine' 'https://user:secret@mirror/alpine' 'https://mirror/alpine?x=1' 'https://mirror/alpine;echo' $'https://mirror/alpine\n'; do
  BUILD_ALPINE_MIRROR="$invalid"
  if init_build_network >/dev/null 2>&1; then echo '非法Alpine镜像未被拒绝' >&2; exit 1; fi
done
unset BUILD_ALPINE_MIRROR
init_build_network
[[ -z "$build_alpine_mirror" ]]
printf '构建镜像缺省保真、受控改写、签名保持及非法地址检查通过。\n'
