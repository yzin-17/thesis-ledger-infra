// 从已暂停的本机单轮比赛生成独立回放回执。凭证只在服务进程环境内使用。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const [action, packetPath] = process.argv.slice(2);
assert(
  ["--check", "--run"].includes(action) && packetPath,
  "用法：node scripts/model-arena-replay.mjs --check|--run <冻结材料 JSON>",
);
const packet = JSON.parse(readFileSync(packetPath, "utf8"));
assert.match(packet.arenaId, /^[0-9a-f-]{36}$/);
const dir = fileURLToPath(
  new URL(
    "../../thesis-ledger/.recovery-artifacts/arena-replays/",
    import.meta.url,
  ),
);
mkdirSync(dir, { recursive: true });
const program = [
  "./model-arena-replay-time.mjs",
  "./model-arena-replay-runtime.mjs",
]
  .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
  .join("\n");
function execute(mode, reservedPlan) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-w",
      "/app/apps/server",
      "thesis-ledger-dev-thesis-ledger-1",
      "node",
      "--input-type=module",
      "-",
      mode,
      JSON.stringify(packet),
      ...(reservedPlan ? [JSON.stringify(reservedPlan)] : []),
    ],
    {
      input: program,
      encoding: "utf8",
      timeout: 260000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(
      "回放进程未完成，检查回执，禁止自动重发：" +
        (result.stdout || "").slice(-240),
    );
  return JSON.parse(result.stdout.trim());
}
const plan = execute("--check");
if (action === "--check") console.log(JSON.stringify(plan));
else {
  const stem = join(dir, packet.arenaId);
  writeFileSync(
    stem + ".reserved.json",
    JSON.stringify({ plan, packet, reservedAt: new Date() }),
    { flag: "wx", mode: 0o600 },
  );
  const receipt = execute("--run", plan);
  writeFileSync(stem + ".receipt.json", JSON.stringify(receipt, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
}
