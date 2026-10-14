#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
cat > "$fixture_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_START_TEST_LOG"
case "$*" in
  info) [[ -f "$DOCKER_START_TEST_READY" ]] ;;
  'desktop start --timeout 45')
    [[ "$DOCKER_START_TEST_FAILURE" != 1 ]] || exit 9
    touch "$DOCKER_START_TEST_READY"
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$fixture_dir/docker"
export PATH="$fixture_dir:$PATH"
export DOCKER_START_TEST_LOG="$fixture_dir/calls"
export DOCKER_START_TEST_READY="$fixture_dir/ready"
export DOCKER_START_TEST_FAILURE=0
bash "$script_dir/docker-desktop.sh" start >/dev/null
[[ "$(cat "$DOCKER_START_TEST_LOG")" == $'info\ndesktop start --timeout 45\ninfo' ]]
: > "$DOCKER_START_TEST_LOG"
bash "$script_dir/docker-desktop.sh" start >/dev/null
[[ "$(cat "$DOCKER_START_TEST_LOG")" == info ]]
rm "$DOCKER_START_TEST_READY"
export DOCKER_START_TEST_FAILURE=1
set +e
bash "$script_dir/docker-desktop.sh" start >/dev/null 2>&1
result=$?
set -e
[[ "$result" == 9 ]]
: > "$DOCKER_START_TEST_LOG"
if bash "$script_dir/docker-desktop.sh" restart >/dev/null 2>&1; then exit 1; fi
[[ ! -s "$DOCKER_START_TEST_LOG" ]]
if bash "$script_dir/docker-desktop.sh" status >/dev/null 2>&1; then exit 1; fi
printf 'Docker Desktop 启动入口测试通过。\n'
