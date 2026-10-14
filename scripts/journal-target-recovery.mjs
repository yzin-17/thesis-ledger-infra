import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ThesisLedgerApiClient } from '../../thesis-ledger/packages/api-client/dist/index.js';

const project = 'thesis-ledger-dev';
const database = 'thesis_ledger';
const fixture = '95bd7e1a-72df-4cd7-aae8-121d8545e5ea';
const scope = { accountId: fixture, mode: 'actual' };
const base = 'http://127.0.0.1:3000/api/v1';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }).trim();

export function assertFaultWindow(row) {
  assert.equal(row.status, 'running', '运行必须仍在执行');
  assert.equal(row.attempt, 1, '只能对第一次 attempt 注入故障');
  assert.equal(row.requests.length, 1, '只能有一个已授权请求');
  assert.equal(row.requests[0].state, 'dispatching', '必须进入发送授权阶段');
  assert.match(row.requests[0].requestId, /^[0-9a-f-]{36}$/i);
}
export function assertNoOtherResearch(count) {
  assert.equal(count, 0, '存在其他在途研究任务，禁止中断 Server');
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--confirm', `${project}/${database}`]);
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  assert.equal(docker('context', 'show'), 'desktop-linux');
  const endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}');
  assert(endpoint.startsWith('unix://'));
  const checksum = execFileSync('cksum', { input: endpoint, encoding: 'utf8' }).split(/\s+/)[0];
  const lock = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
  mkdirSync(lock);
  let server;
  let stopped = false;
  const inspect = (service) => {
    const row = JSON.parse(docker('inspect', `${project}-${service}-1`))[0];
    assert.equal(row.Config.Labels['com.docker.compose.project'], project);
    assert.equal(row.Config.Labels['com.docker.compose.service'], service);
    assert(row.State.Running, `${service} 未运行`);
    return { id: row.Id, image: row.Image, startedAt: row.State.StartedAt };
  };
  const boundedFetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  const client = new ThesisLedgerApiClient(base, boundedFetch);
  const read = async (path) => {
    const response = await boundedFetch(`${base}${path}`);
    assert(response.ok, `目标读取失败：${response.status}`);
    return response.json();
  };
  const protectedIds = ['0e9677d2-98c6-45b1-8bc3-8d07b9209180', '93337db7-a5a0-40c5-823f-63577e9e924b', fixture];
  const ledgerHashes = () => Promise.all(protectedIds.map(async (id) => {
    const { instrumentDirectory, ...economic } = await read(`/ledger/${id}/events`);
    assert(instrumentDirectory !== undefined);
    return createHash('sha256').update(JSON.stringify(economic)).digest('hex');
  }));
  const savedSettings = async () => {
    const row = await read('/ai/settings');
    return { revision: row.revision, researchDefault: row.researchDefault };
  };
  try {
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    assert(!/running|pending/i.test(docker('buildx', '--builder', 'desktop-linux', 'history', 'ls', '--format', '{{.Status}}')));
    server = inspect('thesis-ledger');
    const worker = inspect('backtest-worker');
    const postgres = inspect('postgres');
    const sql = (query) => JSON.parse(docker('exec', postgres.id, 'psql', '-U', database, '-d', database,
      '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `BEGIN READ ONLY; ${query}; COMMIT;`));
    assert.deepEqual(sql(`SELECT json_build_object('database', current_database(), 'owner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`), { database, owner: database });
    const others = (except) => sql(`SELECT count(*)::int FROM "AiRun" WHERE status IN ('queued','running','cancel_requested')${except ? ` AND id <> '${except}'` : ''}`);
    assertNoOtherResearch(others());
    const accounts = await read('/accounts');
    assert(accounts.find((row) => row.id === fixture)?.name.startsWith('复盘验收 '));
    const settings = await savedSettings();
    assert(settings.researchDefault, '默认模型缺失，保留配置，不提交');
    const hashes = await ledgerHashes();
    const oldObject = await client.journalReviews.explanation('e2c829d1-6ad6-4325-81bb-26e931047669', scope);
    const oldPeriod = await client.journalReviews.periodExplanation('67e14795-2113-4174-b366-9c95db6ddb14', scope);
    const candidate = (await client.journalReviews.candidates(scope)).items.find((row) => row.input.reference.reviewObjectType === 'TRADE_CYCLE');
    assert(candidate);
    const request = { ...scope, reference: candidate.input.reference, evidenceFingerprint: candidate.input.projection.evidenceFingerprint };
    const analysis = await client.journalReviews.analyze(request);
    const run = await client.journalReviews.explain({ ...request, expectedAlgorithmVersion: analysis.result.algorithmVersion });
    assert.match(run.id, /^[0-9a-f-]{36}$/i);
    console.log(JSON.stringify({ stage: 'submitted', id: run.id, provider: run.provider, model: run.model }));
    const state = () => sql(`SELECT json_build_object('status', status, 'attempt', "executionAttempt", 'leaseUntil', "leaseUntil", 'requests', coalesce((SELECT json_agg(json_build_object('requestId', r->>'requestId', 'state', r->>'state')) FROM jsonb_array_elements(coalesce("modelMetadata"->'sdkExecution'->'requests', '[]')) r), '[]'::json)) FROM "AiRun" WHERE id='${run.id}'`);
    let before;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const row = state();
      if (row.requests.some((request) => request.state === 'dispatching')) { before = row; break; }
      assert(['queued', 'running'].includes(row.status), '未进入故障窗口；保留运行，不重新提交');
      await delay(250);
    }
    assert(before, '发送授权窗口超时；未执行故障');
    assertFaultWindow(before);
    assertNoOtherResearch(others(run.id));
    console.log(JSON.stringify({ stage: 'fault-window', id: run.id, ...before, server }));
    stopped = true;
    docker('kill', '--signal=SIGKILL', server.id);
    docker('start', server.id);
    stopped = false;
    let recovered;
    const restoreDeadline = Date.now() + 180_000;
    while (Date.now() < restoreDeadline) {
      try {
        const row = await client.journalReviews.explanation(run.id, scope);
        if (!['queued', 'running', 'cancel_requested'].includes(row.status)) { recovered = row; break; }
      } catch { /* 同一容器启动中，继续读取已有任务。 */ }
      await delay(2000);
    }
    assert(recovered, '原运行恢复未收敛');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.errorCode, 'research_unknown_outcome');
    assert.equal(recovered.result, null);
    await delay(6000); // 跨过一次调度周期，确认终态后不会再次发送。
    const after = state();
    assert.equal(after.attempt, before.attempt);
    assert.deepEqual(after.requests.map((row) => row.requestId), before.requests.map((row) => row.requestId));
    assert.deepEqual(await ledgerHashes(), hashes);
    assert.deepEqual(await savedSettings(), settings);
    assert.deepEqual(await client.journalReviews.explanation(oldObject.id, scope), oldObject);
    assert.deepEqual(await client.journalReviews.periodExplanation(oldPeriod.id, scope), oldPeriod);
    const currentServer = inspect('thesis-ledger');
    assert.equal(currentServer.id, server.id);
    assert.equal(currentServer.image, server.image);
    assert.notEqual(currentServer.startedAt, server.startedAt);
    assert.deepEqual(inspect('backtest-worker'), worker);
    console.log(JSON.stringify({ stage: 'recovered', id: run.id, status: recovered.status, errorCode: recovered.errorCode,
      executionAttempt: after.attempt, requestCount: after.requests.length, ledgerHashes: hashes, defaultRevision: settings.revision,
      sameServerContainer: true, sameServerImage: true, workerUnchanged: true, oldReportsUnchanged: true }));
  } finally {
    try { if (stopped && server) docker('start', server.id); }
    finally { rmSync(join(lock, 'pid'), { force: true }); rmdirSync(lock); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
