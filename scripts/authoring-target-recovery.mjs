import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = "thesis-ledger-dev";
const database = "thesis_ledger";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
export function parseRecoveryArguments(args) {
  assert.equal(args.length, 3);
  assert.equal(args[0], `--confirm=${project}/${database}`);
  const id = args[1]?.replace(/^--operation=/, "");
  const prefix = args[2]?.replace(/^--owner-prefix=/, "");
  assert.match(
    id,
    /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i,
  );
  assert.match(prefix, /^nla6_\d{8}_[a-f\d]{8}\.$/);
  return { id, prefix };
}
export function assertOwnedFaultWindow(row, prefix) {
  assert(row.username.startsWith(prefix), "编写操作不属于标记验收用户");
  assert.equal(row.status, "running");
  assert.equal(row.attempt, 1);
  assert.equal(row.invocations.length, 1);
  assert.equal(row.invocations[0].facts.at(-1)?.kind, "dispatching");
}
export function assertAuthoringRecovery(before, after) {
  assert.equal(after.status, "failed");
  assert.equal(after.outcome.externalResult, "unknown");
  assert.equal(after.outcome.errorCode, "AUTHORING_RESULT_UNKNOWN");
  assert.equal(after.outcome.usage, null);
  assert.deepEqual(after.outcome.cost, {
    status: "unknown",
    amount: null,
    currency: null,
    source: null,
    pricingVersion: null,
  });
  assert.equal(after.attempt, before.attempt);
  assert.deepEqual(
    after.invocations.map((row) => row.requestId),
    before.invocations.map((row) => row.requestId),
  );
  assert.equal(after.invocations[0].facts.at(-1)?.kind, "unknown");
}
export async function main(args = process.argv.slice(2)) {
  const { id, prefix } = parseRecoveryArguments(args);
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
  let server;
  let stopped = false;
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
  const state = () =>
    sql(`SELECT json_build_object('username',u.username,'status',o.status,'attempt',o.attempt,'outcome',o.outcome,
    'invocations',coalesce((SELECT json_agg(json_build_object('requestId',a."requestId",'facts',
      coalesce((SELECT json_agg(json_build_object('kind',f.kind,'sequence',f.sequence) ORDER BY f.sequence) FROM "AiInvocationFact" f WHERE f."requestId"=a."requestId"),'[]'::json)))
      FROM "AiInvocation" a WHERE a."referenceId"=o.id AND a."ownerId"=u.id),'[]'::json))
    FROM "StrategyAuthoringOperation" o JOIN "IdentityUser" u ON u.id::text=o."ownerId" WHERE o.id='${id}'`);
  const noOtherWork = () => {
    const counts =
      sql(`SELECT json_build_object('authoring',(SELECT count(*) FROM "StrategyAuthoringOperation" WHERE status IN ('queued','running') AND id<>'${id}'),
      'research',(SELECT count(*) FROM "AiRun" WHERE status IN ('queued','running','cancel_requested')),
      'backtest',(SELECT count(*) FROM "BacktestJob" WHERE status IN ('queued','running')),
      'automation',(SELECT count(*) FROM "AutomationRun" WHERE status IN ('queued','running')))`);
    for (const [kind, count] of Object.entries(counts))
      assert.equal(count, 0, `存在其他在途任务：${kind}`);
  };
  const protect = () => {
    const tables = [
      "Account",
      "LedgerEvent",
      "JournalEntry",
      "JournalReviewSnapshot",
      "Strategy",
      "StrategyVersion",
      "StrategyAuthoringDraft",
      "StrategyAuthoringRevision",
      "StrategyAuthoringSource",
      "ProviderConfig",
      "AiRoutingSettings",
      "DesiredProviderPolicy",
      "DesiredProviderPolicyRevision",
    ];
    return sql(
      `SELECT json_build_object(${tables.map((table) => `'${table}',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "${table}" t)`).join(",")})`,
    );
  };
  const wait = async (probe, label, milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await delay(500);
    }
    throw new Error(`${label}未在限时内完成`);
  };
  const queueState = () => {
    const code = `import {createRequire} from 'node:module';const require=createRequire('/app/apps/server/package.json');
      const {Queue}=require('bullmq');const {Redis}=require('ioredis');const {loadConfig}=await import('/app/apps/server/dist/src/platform/config.js');
      const client=new Redis(loadConfig().redisUrl,{maxRetriesPerRequest:1});const q=new Queue('strategy-authoring',{connection:client,skipMetasUpdate:true,prefix:'thesis-ledger:queue:v1:authoring'});
      try{const job=await q.getJob(${JSON.stringify(id)});console.log(JSON.stringify(job?await job.getState():'missing'));}
      finally{await Promise.allSettled([q.close(),client.quit()]);}`;
    return JSON.parse(
      docker("exec", server.id, "node", "--input-type=module", "-e", code),
    );
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
    server = inspect("thesis-ledger");
    assert(server.running && server.health === "healthy");
    const others = Object.fromEntries(
      ["backtest-worker", "postgres", "redis"].map((service) => [
        service,
        inspect(service),
      ]),
    );
    noOtherWork();
    const hashes = protect();
    let before;
    await wait(
      () => {
        const row = state();
        if (row?.invocations[0]?.facts.at(-1)?.kind !== "dispatching")
          return false;
        assertOwnedFaultWindow(row, prefix);
        before = row;
        return true;
      },
      "发送授权窗口",
      120000,
    );
    noOtherWork();
    assertOwnedFaultWindow(state(), prefix);
    console.log(
      JSON.stringify({ stage: "故障窗口", operationId: id, ...before, server }),
    );
    stopped = true;
    docker("kill", "--signal=SIGKILL", server.id);
    docker("start", server.id);
    stopped = false;
    await wait(() => state()?.status === "failed", "持久化终态恢复", 150000);
    const recovered = state();
    assertAuthoringRecovery(before, recovered);
    await delay(31000);
    assertAuthoringRecovery(before, state());
    // BullMQ 的 180 秒基础设施锁自然到期后可能重领；数据库 CAS 必须继续阻止模型重发。
    const queueDeadline = Date.now() + 210000;
    let delivery;
    while (Date.now() < queueDeadline) {
      delivery = queueState();
      if (["completed", "failed", "missing"].includes(delivery)) break;
      noOtherWork();
      await delay(5000);
    }
    assert(
      ["completed", "failed", "missing"].includes(delivery),
      "故障投递未在限时内自然收敛",
    );
    assertAuthoringRecovery(before, state());
    assert.deepEqual(protect(), hashes);
    assert.equal(inspect("thesis-ledger").id, server.id);
    assert.equal(inspect("thesis-ledger").image, server.image);
    for (const [service, original] of Object.entries(others))
      assert.deepEqual(inspect(service), original);
    console.log(
      JSON.stringify({
        stage: "恢复验收完成",
        operationId: id,
        ...recovered,
        protectedTableCount: Object.keys(hashes).length,
        sameContainerAndImage: true,
        observationMs: 31000,
        deliveryState: delivery,
      }),
    );
  } finally {
    if (stopped && server) docker("start", server.id);
    if (server)
      await wait(
        () => inspect("thesis-ledger").health === "healthy",
        "Server 健康恢复",
        120000,
      );
    rmSync(join(lock, "pid"), { force: true });
    rmdirSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
