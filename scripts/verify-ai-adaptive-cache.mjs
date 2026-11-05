import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { inspect, target } from "./research-state-backup.mjs";

const exec = promisify(execFile);
const ownershipLabel = "thesis-ledger.ai-adaptive-fixture";
export function adaptiveCacheFixturePlan(image, id = randomUUID()) {
  assert(/^sha256:[a-f0-9]{64}$/u.test(image), "仅复用本地完整镜像ID");
  assert(/^[a-f0-9-]{36}$/u.test(id), "隔离资源必须使用UUID");
  const name = `thesis-ledger-ai-adaptive-${id}`;
  return {
    image,
    id,
    name,
    args: [
      "run",
      "--detach",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/data",
      "--tmpfs",
      "/tmp",
      "--label",
      `${ownershipLabel}=${id}`,
      "--name",
      name,
      image,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--bind",
      "127.0.0.1",
    ],
  };
}

const docker = async (args) =>
  (await exec("docker", args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const digest = (text) => createHash("sha256").update(text).digest("hex");
const resp = (args) =>
  Buffer.concat([
    Buffer.from(`*${args.length}\r\n`),
    ...args.flatMap((arg) => {
      const bytes = Buffer.from(String(arg));
      return [Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")];
    }),
  ]);

async function pipeline(name, commands) {
  await new Promise((done, reject) => {
    const child = spawn("docker", ["exec", "-i", name, "redis-cli", "--pipe"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (value) => {
      output += value;
    });
    child.stderr.on("data", (value) => {
      output += value;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && /errors: 0/u.test(output)) done();
      else reject(new Error(`隔离Redis pipeline失败：${output.slice(-500)}`));
    });
    child.stdin.end(Buffer.concat(commands.map(resp)));
  });
}

export async function verifyAdaptiveCache() {
  const serverRoot = resolve(
    fileURLToPath(
      new URL("../../thesis-ledger/apps/server/dist/src", import.meta.url),
    ),
  );
  const { RedisAdaptiveObservationStore, ADAPTIVE_HISTORY_MUTATION } =
    await import(
      pathToFileURL(
        resolve(serverRoot, "ai/adaptive/ai-adaptive-history.store.js"),
      ).href
    );
  const { ADAPTIVE_RULE } = await import(
    pathToFileURL(resolve(serverRoot, "ai/adaptive/ai-adaptive-policy.js")).href
  );
  const plan = adaptiveCacheFixturePlan(inspect(target + "-redis-1").Image);
  const cli = async (args) =>
    JSON.parse(
      await docker([
        "exec",
        plan.name,
        "redis-cli",
        "--json",
        ...args.map(String),
      ]),
    );
  const client = () => ({
    get: (key) => cli(["GET", key]),
    eval: (...args) => cli(["EVAL", ...args]),
  });
  const key = (profile) => `thesis-ledger:cache:v1:ai-adaptive:v2:${profile}`;
  const index = "thesis-ledger:cache:v1:ai-adaptive:v2:profiles";
  const sample = (id, outcome = "success") => ({
    requestId: id,
    at: Date.now(),
    firstMs: 45_000,
    maxGapMs: 1000,
    firstCensored: false,
    gapCensored: false,
    outcome,
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    let item;
    try {
      item = JSON.parse(
        await docker(["inspect", "--format", "{{json .}}", plan.name]),
      );
    } catch {
      return;
    }
    assert.equal(
      item.Config.Labels?.[ownershipLabel],
      plan.id,
      "拒绝清理其他资源",
    );
    assert.equal(item.Image, plan.image, "隔离镜像身份改变");
    assert.equal(
      item.Mounts.filter((mount) => mount.Type !== "tmpfs").length,
      0,
    );
    await docker(["rm", "--force", plan.name]);
    cleaned = true;
  };
  const interrupted = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await docker(plan.args);
    const until = Date.now() + 10_000;
    while (true) {
      try {
        if ((await cli(["PING"])) === "PONG") break;
      } catch {
        /* 仅等待本次临时实例。 */
      }
      if (Date.now() >= until) throw new Error("隔离Redis未在限时内就绪");
      await wait(100);
    }
    const left = new RedisAdaptiveObservationStore(client()),
      right = new RedisAdaptiveObservationStore(client());
    const profile = digest("shared");
    await left.record(profile, sample("success-1"));
    assert.deepEqual(
      (
        await Promise.all([
          left.takeRetry(profile, "reject-1"),
          right.takeRetry(profile, "reject-2"),
        ])
      ).sort(),
      [false, true],
    );
    await right.record(profile, sample("success-1"));
    assert.equal(
      await left.takeRetry(profile, "reject-3"),
      false,
      "重复成功不能补充配额",
    );
    await right.record(profile, sample("success-2"));
    assert.equal(await left.takeRetry(profile, "reject-3"), true);
    assert.equal((await right.read(profile)).observations.length, 2);
    const ttl = await cli(["PTTL", key(profile)]);
    assert(ttl > 0 && ttl <= ADAPTIVE_RULE.windowMs);
    const mutation = (p, observation) => [
      "EVAL",
      ADAPTIVE_HISTORY_MUTATION,
      2,
      key(p),
      index,
      "record",
      JSON.stringify(observation),
      Date.now(),
      ADAPTIVE_RULE.windowMs,
      ADAPTIVE_RULE.maxObservations,
      ADAPTIVE_RULE.maxProfiles,
    ];
    await pipeline(
      plan.name,
      Array.from({ length: 520 }, (_, i) =>
        mutation(profile, sample(`bounded-${i}`)),
      ),
    );
    assert.equal(
      (await left.read(profile)).observations.length,
      ADAPTIVE_RULE.maxObservations,
    );
    await pipeline(
      plan.name,
      Array.from({ length: ADAPTIVE_RULE.maxProfiles + 2 }, (_, i) =>
        mutation(digest(`profile-${i}`), sample(`capacity-${i}`)),
      ),
    );
    assert.equal(await cli(["ZCARD", index]), ADAPTIVE_RULE.maxProfiles);
    assert.equal(await cli(["DBSIZE"]), ADAPTIVE_RULE.maxProfiles + 1);
    const damaged = digest("damaged");
    await cli(["SET", key(damaged), "invalid-json"]);
    assert.equal((await left.read(damaged)).available, false);
    assert.equal(await right.takeRetry(damaged, "blocked"), false);
    await docker(["stop", "--time=1", plan.name]);
    assert.equal((await left.read(profile)).available, false);
    assert.equal(await right.takeRetry(profile, "offline"), false);
    await cleanup();
    return {
      passed: true,
      isolatedImage: plan.image,
      sharedClients: 2,
      atomicQuota: true,
      deduplication: true,
      ttlBounded: true,
      observationsBounded: true,
      profilesBounded: true,
      corruptionAndOutageFailClosed: true,
      ownContainerRemoved: cleaned,
      targetWrites: 0,
      modelCalls: 0,
    };
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await cleanup();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(await verifyAdaptiveCache()));
}
