#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/longbridge-build-source.sh"
local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/longbridge-source-test.XXXXXX")"
trap 'rm -rf "$local_build_dir"' EXIT
infra_dir="$local_build_dir/fixture/infra"
mkdir -p "$infra_dir/../daily-stock-analysis/scripts"
printf '# 固定源码构建脚本测试输入\n' > "$infra_dir/../daily-stock-analysis/scripts/build_thesis_ledger_longbridge_sdk.py"
LONG_BRIDGE_SOURCE_CACHE="$local_build_dir/cache"
selected=thesis-ledger
service_is_selected() { [[ "$selected" == "$1" ]]; }
LONG_BRIDGE_SOURCE_PYTHON=/no-installed-python
prepare_longbridge_build_source
[[ "$longbridge_source_owned" == false ]]
selected=dsa
REUSE_DSA_IMAGE_ID=sha256:existing
prepare_longbridge_build_source
[[ "$longbridge_source_owned" == false ]]
unset REUSE_DSA_IMAGE_ID
if prepare_longbridge_build_source >/dev/null 2>&1; then
  printf 'Python不存在时应拒绝，不自动安装。\n' >&2
  exit 1
fi
[[ "$longbridge_source_owned" == false ]]
LONG_BRIDGE_SOURCE_PYTHON="$local_build_dir/python"
cat > "$LONG_BRIDGE_SOURCE_PYTHON" <<'STUB'
#!/usr/bin/env bash
[[ "$2" == --fetch-only && "$3" == --work-dir && "$5" == --output ]]
mkdir -p "$4/source" "$6"
printf '固定源输入\n' > "$4/source/witness"
if (($# > 6)); then
  [[ "$7" == --source-dir && -f "$8/witness" ]]
  printf '已使用缓存源参数\n' > "$4/cache-reused"
fi
STUB
chmod +x "$LONG_BRIDGE_SOURCE_PYTHON"
prepare_longbridge_build_source
[[ "$longbridge_source_owned" == true && -f "$local_build_dir/sdk-source/source/witness" ]]
source_key="$(shasum -a 256 "$infra_dir/../daily-stock-analysis/scripts/build_thesis_ledger_longbridge_sdk.py" | awk '{print $1}')"
[[ -f "$LONG_BRIDGE_SOURCE_CACHE/$source_key/source/witness" ]]
mkdir -p "$local_build_dir/other-assets"
cleanup_longbridge_build_source
[[ ! -e "$local_build_dir/sdk-source" && ! -e "$local_build_dir/sdk-source-output" && -d "$local_build_dir/other-assets" ]]
prepare_longbridge_build_source
[[ -f "$local_build_dir/sdk-source/source/witness" ]]
[[ -f "$local_build_dir/sdk-source/cache-reused" ]]
printf '固定 SDK 源预取、复用/目标跳过和精确清理契约通过。\n'
