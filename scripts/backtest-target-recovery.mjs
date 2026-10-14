import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createTargetRuntime, project, database, docker } from './backtest-target-runtime.mjs';
import { backtestResultSchemaV3 } from '../../thesis-ledger/packages/schemas/dist/index.js';

export const scenarios = ['normal', 'hard-kill', 'redis-active', 'redis-queued', 'queued-cancel', 'running-cancel', 'cancel-crash'];

async function prepare(runtime) {
  const seed = runtime.sql(`SELECT row_to_json(t) FROM (SELECT "strategyVersionId", input FROM "BacktestJob" WHERE mode='V3' AND status='succeeded' AND input->'runConfig'->'executionModel'->>'id' LIKE 'common-price-tencent%' ORDER BY "createdAt" DESC LIMIT 1)t`);
  assert(seed, '缺少现行共同价格验收种子');
  const config = structuredClone(seed.input.runConfig);
  const { priceBasis: { adjustment }, accountingBasis, history } = config.executionPriceProtocol;
  for (const key of ['schemaVersion', 'executionPriceProtocol', 'priceInputBindings', 'frozenExecutionWindow', 'frozenWarmupBudgetSessions']) delete config[key];
  config.dataAsOf = new Date().toISOString();
  const result = await runtime.request('/backtests/run-config/prepare', { contractVersion: 3, requestId: runtime.prefix, strategyVersionId: seed.strategyVersionId, runConfig: config, adjustment, accountingBasis, history, freezeTimePolicy: 'after-acquisition' });
  assert.equal(result.status, 'prepared', JSON.stringify(result.diagnostics));
  return { contractVersion: 3, strategyVersionId: seed.strategyVersionId, runConfig: result.runConfig,
    preparationStamp: result.executionPreflight.revisionStamp, idempotencyKey: runtime.prefix };
}

async function ownedQueued(runtime, body) {
  if (runtime.inspect('backtest-worker').State.Running) runtime.stop('backtest-worker');
  const created = await runtime.request('/backtests/runs', body);
  const row = runtime.state(created.id);
  assert.equal(row.status, 'queued', row.errorSummary); assert.equal(row.executionAttempt, 0);
  runtime.record('created', { id: row.id, owner: 0, errorCode: row.errorCode });
  return row.id;
}

async function claimed(runtime, id, owner) {
  return runtime.wait(() => { const row = runtime.state(id); return row.status === 'running' && row.executionAttempt === owner ? row : false; }, '数据库领取');
}

async function terminal(runtime, id, status, owner) {
  const row = await runtime.wait(() => { const row = runtime.state(id); return row.status === status ? row : false; }, `终态 ${status}`);
  assert.equal(row.executionAttempt, owner);
  if (status === 'succeeded') {
    const result = backtestResultSchemaV3.parse(row.result);
    assert.equal(row.resultChecksum, result.resultChecksum);
    const checksum = JSON.parse(runtime.node(`import {LocalSnapshotStore} from './apps/server/dist/src/backtest/backtest-snapshot.js'; import {LocalSnapshotV3Runner} from './apps/server/dist/src/backtest/backtest-v3-runner.js'; const s=new LocalSnapshotStore('/app/var/backtest'); const m=await s.v3.replay('${id}'); const r=await new LocalSnapshotV3Runner(s).run({runId:'${id}',snapshotRef:{snapshotId:m.contentHash,contentHash:m.contentHash},artifactRefs:m.artifacts},new AbortController().signal); console.log(JSON.stringify(r.resultChecksum));`));
    assert.equal(checksum, row.resultChecksum);
  } else assert.equal(row.result, null);
  const before = runtime.hash(row);
  await runtime.request(`/backtests/runs/${id}/run`, {});
  await runtime.delay(16_000);
  assert.equal(runtime.hash(runtime.state(id)), before, '终态被重复投递或协调改写');
  runtime.record('terminal', { id, status, owner, checksum: row.resultChecksum, uniqueResult: true, offlineReplay: status === 'succeeded' });
  return row;
}

async function staleOwner(runtime, id) {
  const row = runtime.state(id); assert.equal(row.executionAttempt, 2);
  const result = JSON.parse(runtime.node(`import {PrismaClient} from '@prisma/client';const p=new PrismaClient();try {console.log(JSON.stringify(await p.backtestJob.updateMany({where:{id:'${id}',mode:'V3',status:'running',executionAttempt:1,cancelRequestedAt:null},data:{status:'failed',errorCode:'t4_stale_owner_probe'}})));}finally{await p.$disconnect()}`));
  assert.equal(result.count, 0); assert.deepEqual(runtime.state(id), row);
  runtime.record('stale-owner-rejected', { id, count: result.count });
}

export async function runScenario(runtime, scenario) {
  assert(scenarios.includes(scenario));
  const protection = runtime.protect();
  const body = await prepare(runtime);
  if (scenario === 'redis-queued') {
    runtime.stop('backtest-worker');
    runtime.stop('redis');
    const id = await ownedQueued(runtime, body);
    assert.equal(runtime.state(id).errorCode, 'queue_temporarily_unavailable');
    runtime.start('redis'); runtime.start('backtest-worker');
    await terminal(runtime, id, 'succeeded', 1);
  } else {
    const id = await ownedQueued(runtime, body);
    if (scenario === 'queued-cancel') {
      await runtime.request(`/backtests/runs/${id}/cancel`, {});
      await runtime.request(`/backtests/runs/${id}/cancel`, {});
      runtime.start('backtest-worker'); await terminal(runtime, id, 'cancelled', 0);
    } else {
      const manifestHash = runtime.snapshot(id, 'block');
      runtime.start('backtest-worker'); const row = await claimed(runtime, id, 1);
      runtime.record('claimed', { id, status: row.status, owner: row.executionAttempt });
      const firstHeartbeat = docker('exec', runtime.baseline.get('redis').Id, 'redis-cli', '--raw', 'GET', 'thesis-ledger:queue:v1:backtest-worker-heartbeat');
      await runtime.delay(16_000);
      const secondHeartbeat = docker('exec', runtime.baseline.get('redis').Id, 'redis-cli', '--raw', 'GET', 'thesis-ledger:queue:v1:backtest-worker-heartbeat');
      assert(Date.parse(secondHeartbeat) > Date.parse(firstHeartbeat));
      runtime.record('heartbeat', { id, advancing: true, ttlMs: Number(docker('exec', runtime.baseline.get('redis').Id, 'redis-cli', 'PTTL', 'thesis-ledger:queue:v1:backtest-worker-heartbeat')) });
      if (scenario === 'hard-kill') {
        runtime.stop('backtest-worker', 'SIGKILL'); runtime.start('backtest-worker');
        await claimed(runtime, id, 2); await staleOwner(runtime, id);
      } else if (scenario === 'redis-active') {
        const before = runtime.state(id); runtime.stop('redis'); await runtime.delay(20_000);
        const query = JSON.parse(runtime.node(`import {BacktestBullQueue} from './apps/server/dist/src/backtest/backtest-bull-queue.js';const q=new BacktestBullQueue();try{try{await q.getState('${id}');console.log(JSON.stringify({failed:false}));}catch{console.log(JSON.stringify({failed:true}));}}finally{await q.onModuleDestroy();}`));
        assert.equal(query.failed, true, '必须实际观测队列查询失败');
        assert.deepEqual(runtime.state(id), before);
        runtime.record('query-failure-preserved', { id, owner: before.executionAttempt, productionQueueQueryFailed: true });
        runtime.start('redis');
      } else if (scenario === 'running-cancel' || scenario === 'cancel-crash') {
        if (process.env.BACKTEST_T4_UI_CANCEL === 'true') {
          runtime.record('awaiting-ui-cancel', { id, owner: 1 });
          await runtime.wait(() => Boolean(runtime.state(id).cancelRequestedAt), '真实客户端取消请求');
        } else await runtime.request(`/backtests/runs/${id}/cancel`, {});
        await runtime.request(`/backtests/runs/${id}/cancel`, {});
        if (scenario === 'cancel-crash') {
          runtime.stop('backtest-worker', 'SIGKILL'); runtime.start('backtest-worker');
          await runtime.wait(() => runtime.state(id).status === 'cancelled', '取消中断恢复');
          assert.equal(runtime.snapshot(id, 'restore'), manifestHash);
        }
      }
      if (scenario !== 'cancel-crash') assert.equal(runtime.snapshot(id, 'release'), manifestHash);
      await terminal(runtime, id, ['running-cancel', 'cancel-crash'].includes(scenario) ? 'cancelled' : 'succeeded', scenario === 'hard-kill' ? 2 : 1);
    }
  }
  assert.deepEqual(runtime.protect(), protection, '受保护业务数据发生变化');
  runtime.record('protected-data', { unchanged: true, tables: Object.keys(protection).length });
}

async function main() {
  const [confirm, target, option, scenario, outputFlag, output] = process.argv.slice(2);
  assert.equal(confirm, '--confirm'); assert.equal(target, `${project}/${database}`);
  assert.equal(option, '--scenario'); assert(scenarios.includes(scenario));
  assert.equal(outputFlag, '--output'); assert(output?.startsWith('/private/tmp/'));
  const runtime = createTargetRuntime(`t4-${randomUUID()}`);
  let success = false;
  try { await runScenario(runtime, scenario); success = true; }
  finally {
    try { await runtime.cleanup(); }
    finally { writeFileSync(output, JSON.stringify({ scenario, success, trace: runtime.trace }, null, 2), { mode: 0o600 }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
