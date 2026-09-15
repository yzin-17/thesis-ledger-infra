#!/usr/bin/env bash
set -euo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker compose --env-file "$infra_dir/.env.example" \
  -f "$infra_dir/compose.yml" -f "$infra_dir/compose.dev.yml" config --format json |
  python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
dsa = services["dsa"]
assert dsa["environment"]["THESIS_LEDGER_OAUTH_CALLBACK_HOST"] == "0.0.0.0"
callback = [p for p in dsa["ports"] if int(p["target"]) == 60355]
assert len(callback) == 1
assert callback[0]["host_ip"] == "127.0.0.1"
assert str(callback[0]["published"]) == "60355"
for name, service in services.items():
    if name != "dsa":
        assert all(int(p["target"]) != 60355 for p in service.get("ports", []))
assert any(v["target"] == "/app/data" for v in dsa["volumes"])
print("页面授权 Compose 契约通过：本机回调端口、DSA 监听与持久卷匹配。")
'
