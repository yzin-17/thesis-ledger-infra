import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const project = "thesis-ledger-dev";
const database = "thesis_ledger";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
export function assertNoInflightWork(counts) {
  for (const [kind, count] of Object.entries(counts)) {
    assert.equal(count, 0, `存在其他在途任务：${kind}`);
  }
}
export function assertQueueRejected(result) {
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "AUTHORING_UNAVAILABLE");
}
/** 固定开发目标的 Redis 故障；回调仅可通过正常 API 提交一个标记操作。 */
export async function withUnavailableAuthoringQueue(prefix, rejectSubmission) {
  assert.match(prefix, /^nla6_\d{8}_[a-f\d]{8}\.$/);
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  assert.equal(docker("context", "show"), "desktop-linux");
  const endpoint = docker(
    "context",
    "inspect",
    "desktop-linux",
    "--format",
    "{{.Endpoints.docker.Host}}",
  );
  assert(endpoint.startsWith("unix://"));
  const checksum = execFileSync("cksum", {
    input: endpoint,
    encoding: "utf8",
  }).split(/\s+/)[0];
  const lock = join(
    tmpdir(),
    `thesis-ledger-update-${process.getuid()}-${checksum}.lock`,
  );
  mkdirSync(lock);
  let stopped = false;
  let redis;
  const inspect = (service) => {
    const row = JSON.parse(docker("inspect", `${project}-${service}-1`))[0];
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    assert.equal(row.Config.Labels["com.docker.compose.service"], service);
    return {
      id: row.Id,
      image: row.Image,
      running: row.State.Running,
      health: row.State.Health?.Status,
    };
  };
  const sql = (query) =>
    JSON.parse(
      docker(
        "exec",
        `${project}-postgres-1`,
        "psql",
        "-U",
        database,
        "-d",
        database,
        "-Atq",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `BEGIN READ ONLY; ${query}; COMMIT;`,
      ),
    );
  const active = () =>
    sql(`SELECT json_build_object(
    'authoring',(SELECT count(*) FROM "StrategyAuthoringOperation" WHERE status IN ('queued','running')),
    'research',(SELECT count(*) FROM "AiRun" WHERE status IN ('queued','running','cancel_requested')),
    'backtest',(SELECT count(*) FROM "BacktestJob" WHERE status IN ('queued','running')),
    'automation',(SELECT count(*) FROM "AutomationRun" WHERE status IN ('queued','running')))`);
  const protectedTables = [
    "Account",
    "LedgerEvent",
    "JournalEntry",
    "JournalReviewSnapshot",
    "Strategy",
    "StrategyVersion",
    "StrategyAuthoringDraft",
    "StrategyAuthoringRevision",
    "StrategyAuthoringOperation",
    "StrategyAuthoringProposal",
    "StrategyAuthoringSource",
    "AiInvocation",
    "AiInvocationFact",
    "AiRun",
    "BacktestJob",
    "ProviderConfig",
    "AiRoutingSettings",
    "DesiredProviderPolicy",
    "DesiredProviderPolicyRevision",
  ];
  const protect = () =>
    sql(
      `SELECT json_build_object(${protectedTables
        .map(
          (table) =>
            `'${table}',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "${table}" t)`,
        )
        .join(",")})`,
    );
  const waitHealthy = async () => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (
        ["redis", "thesis-ledger", "backtest-worker"].every(
          (service) => inspect(service).health === "healthy",
        )
      )
        return;
      await delay(1000);
    }
    throw new Error("Redis、Server、Worker 未在限时内恢复健康");
  };
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    assert(
      !/running|pending/i.test(
        docker(
          "buildx",
          "--builder",
          "desktop-linux",
          "history",
          "ls",
          "--format",
          "{{.Status}}",
        ),
      ),
    );
    assert.deepEqual(
      sql(
        "SELECT json_build_object('database',current_database(),'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))",
      ),
      { database, owner: database },
    );
    assert.equal(
      sql(
        `SELECT count(*) FROM "IdentityUser" WHERE left(username,${prefix.length})='${prefix}'`,
      ),
      1,
    );
    const originals = Object.fromEntries(
      ["redis", "postgres", "thesis-ledger", "backtest-worker"].map(
        (service) => [service, inspect(service)],
      ),
    );
    for (const row of Object.values(originals))
      assert(row.running && row.health === "healthy");
    assertNoInflightWork(active());
    const hashes = protect();
    redis = originals.redis;
    stopped = true;
    docker("stop", "--timeout=5", redis.id);
    assert.equal(inspect("redis").running, false);
    const rejected = await rejectSubmission();
    assertQueueRejected(rejected);
    assertNoInflightWork(active());
    assert.deepEqual(protect(), hashes);
    docker("start", redis.id);
    stopped = false;
    await waitHealthy();
    for (const [service, original] of Object.entries(originals))
      assert.deepEqual(inspect(service), original);
    assert.deepEqual(protect(), hashes);
    console.log(
      JSON.stringify({
        stage: "队列不可用拒绝验收完成",
        status: rejected.status,
        code: rejected.body.code,
        protectedTableCount: protectedTables.length,
        sameContainerAndImage: true,
      }),
    );
    return rejected;
  } finally {
    try {
      if (stopped && redis) docker("start", redis.id);
      if (redis) await waitHealthy();
    } finally {
      rmSync(join(lock, "pid"), { force: true });
      rmdirSync(lock);
    }
  }
}
