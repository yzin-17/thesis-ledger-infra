#!/usr/bin/env bash
set -euo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_args=(
  --env-file "$infra_dir/.env.example"
  -f "$infra_dir/compose.yml"
  -f "$infra_dir/compose.dev.yml"
  config --format json
)

with_ai_config="$(
  AI_PROVIDER_ID=openrouter \
  AI_BASE_URL=https://openrouter.ai/api/v1 \
  AI_API_KEY=sentinel-not-a-real-key \
  AI_MODEL=nvidia/nemotron-3-super-120b-a12b:free \
  docker compose "${compose_args[@]}"
)"
WITH_AI_CONFIG="$with_ai_config" python3 -c '
import json
import os

services = json.loads(os.environ["WITH_AI_CONFIG"])["services"]
server_env = services["thesis-ledger"]["environment"]
worker_env = services["backtest-worker"]["environment"]
assert server_env["AI_PROVIDER_ID"] == "openrouter"
assert server_env["AI_BASE_URL"] == "https://openrouter.ai/api/v1"
assert server_env["AI_API_KEY"] == "sentinel-not-a-real-key"
assert server_env["AI_MODEL"] == "nvidia/nemotron-3-super-120b-a12b:free"
assert not any(key.startswith("AI_") for key in worker_env)
'

without_ai_config="$(
  env -u AI_PROVIDER_ID -u AI_BASE_URL -u AI_API_KEY -u AI_MODEL \
  docker compose "${compose_args[@]}"
)"
WITHOUT_AI_CONFIG="$without_ai_config" python3 -c '
import json
import os

services = json.loads(os.environ["WITHOUT_AI_CONFIG"])["services"]
server_env = services["thesis-ledger"]["environment"]
assert not server_env.get("AI_PROVIDER_ID")
assert not server_env.get("AI_BASE_URL")
assert not server_env.get("AI_API_KEY")
assert not server_env.get("AI_MODEL")
'

printf '%s\n' 'AI Provider Compose 契约通过：配置只透传到 Server，未配置场景保持可选。'
