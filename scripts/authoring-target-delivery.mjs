import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
export function assertUndispatched(row, prefix) {
  assert(row.username.startsWith(prefix));
  assert.equal(row.status, "queued");
  assert.equal(row.attempt, 0);
  assert.equal(row.invocations, 0);
}
export function assertDeliveryTerminal(row, model) {
  assert(["succeeded", "failed"].includes(row.status));
  assert.equal(row.attempt, 1);
  assert.equal(row.deliveryAttempts, 1);
  assert.equal(row.invocations.length, 1);
  assert.equal(row.invocations[0].requestedModel, model);
  assert(row.invocations[0].facts.some((fact) => fact.kind === "dispatching"));
  assert(["received", "unknown"].includes(row.outcome.externalResult));
  if (row.outcome.externalResult === "unknown") {
    assert.equal(row.status, "failed");
    assert(
      [
        "AUTHORING_RESULT_UNKNOWN",
        "AUTHORING_TIMEOUT",
        "AUTHORING_TRANSPORT_UNKNOWN",
        "AUTHORING_PROVIDER_STREAM_ERROR",
        "AUTHORING_WORKER_INTERRUPTED",
      ].includes(row.outcome.errorCode),
    );
    assert.equal(row.outcome.cost.status, "unknown");
    assert.equal(row.outcome.cost.amount, null);
    assert.equal(row.outcome.cost.currency, null);
    assert.equal(row.invocations[0].facts.at(-1).kind, "unknown");
  }
}
/** 创建操作的回调只能使用正常编写 API；Docker/Redis 故障由本维护入口持有。 */
export async function withMissingAuthoringDelivery(prefix, createOperation) {
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
  let paused = false;
  let server;
  const sql = (query) =>
    JSON.parse(
      docker(
        "exec",
        "thesis-ledger-dev-postgres-1",
        "psql",
        "-U",
        "thesis_ledger",
        "-d",
        "thesis_ledger",
        "-Atq",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `BEGIN READ ONLY; ${query}; COMMIT;`,
      ),
    );
  const queue = (action, id) => {
    if (id) assert.match(id, /^[a-f\d-]{36}$/i);
    const code = `import {createRequire} from 'node:module';
      const require=createRequire('/app/apps/server/package.json');const {Queue}=require('bullmq');const {Redis}=require('ioredis');
      const {loadConfig}=await import('/app/apps/server/dist/src/platform/config.js');
      const client=new Redis(loadConfig().redisUrl,{maxRetriesPerRequest:1});const q=new Queue('strategy-authoring',{connection:client,skipMetasUpdate:true,prefix:'thesis-ledger:queue:v1:authoring'});
      try {
        if(${JSON.stringify(action)}==='pause') {if(await q.isPaused()) throw new Error('队列已暂停，禁止接管');
          const counts=await q.getJobCounts('active','waiting','delayed');if(Object.values(counts).some(n=>n!==0))throw new Error('存在其他队列投递');await q.pause();}
        else if(${JSON.stringify(action)}==='remove') {if(!await q.isPaused()) throw new Error('故障窗口已变化');
          const job=await q.getJob(${JSON.stringify(id)});if(!job||job.data.operationId!==${JSON.stringify(id)})throw new Error('投递引用不符');
          const state=await job.getState();if(!['waiting','paused'].includes(state))throw new Error('任务已领取，禁止删除');
          await job.remove();if(await q.getJob(${JSON.stringify(id)}))throw new Error('目标投递仍存在');}
        else await q.resume();
        console.log(JSON.stringify({action:${JSON.stringify(action)},operationId:${JSON.stringify(id ?? null)}}));
      } finally {await Promise.allSettled([q.close(),client.quit()]);}`;
    return JSON.parse(
      docker("exec", server.Id, "node", "--input-type=module", "-e", code),
    );
  };
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    server = JSON.parse(
      docker("inspect", "thesis-ledger-dev-thesis-ledger-1"),
    )[0];
    assert.equal(
      server.Config.Labels["com.docker.compose.project"],
      "thesis-ledger-dev",
    );
    assert.equal(server.State.Health.Status, "healthy");
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
      { database: "thesis_ledger", owner: "thesis_ledger" },
    );
    const active =
      sql(`SELECT (SELECT count(*) FROM "StrategyAuthoringOperation" WHERE status IN ('queued','running'))+
      (SELECT count(*) FROM "BacktestJob" WHERE status IN ('queued','running'))+(SELECT count(*) FROM "AiRun" WHERE status IN ('queued','running'))+
      (SELECT count(*) FROM "AutomationRun" WHERE status IN ('queued','running'))`);
    assert.equal(active, 0, "存在其他在途工作");
    queue("pause");
    paused = true;
    const operation = await createOperation();
    const id = operation.id;
    assert.match(id, /^[a-f\d-]{36}$/i);
    const row =
      sql(`SELECT json_build_object('username',u.username,'status',o.status,'attempt',o.attempt,
      'invocations',(SELECT count(*) FROM "AiInvocation" a WHERE a."referenceId"=o.id)) FROM "StrategyAuthoringOperation" o
      JOIN "IdentityUser" u ON u.id::text=o."ownerId" WHERE o.id='${id}'`);
    assertUndispatched(row, prefix);
    console.log(
      JSON.stringify({ stage: "未派发窗口", operationId: id, ...row }),
    );
    queue("remove", id);
    queue("resume");
    paused = false;
    console.log(
      JSON.stringify({ stage: "单一投递已移除并恢复队列", operationId: id }),
    );
    return operation;
  } finally {
    try {
      if (paused) queue("resume");
    } finally {
      rmSync(join(lock, "pid"), { force: true });
      rmdirSync(lock);
    }
  }
}
