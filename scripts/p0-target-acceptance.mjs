import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { project, fixtureDatabase, fixtureOwner, compareProtected, assertBridgeRequest, browserTransportStatus } from './p0-target-contract.mjs';
import { acquireLock, command, inspectTargets, mainRoot, node, probeSource, protectedBaseline,
  sha256, spawnNode, targetSummary, terminateOwned, verifyCandidate } from './p0-target-runtime.mjs';
import { upgradeProtectedBaseline } from './p0-target-runtime.mjs';

const [action, baselineFile, inputsFile, reportFile, backupDirectory] = process.argv.slice(2);
assert(['baseline', 'run'].includes(action), '使用 baseline <绝对文件> 或 run <基线> <输入> <报告>');
for (const file of [baselineFile, ...(action === 'run' ? [inputsFile, reportFile] : [])])
  assert(file && resolve(file) === file, '所有输入输出必须是绝对路径');
if (action === 'run') assert(!existsSync(reportFile), '报告路径已存在，请保留此前证据并使用新路径');
const unlock = acquireLock();
const runId = `p0-${randomUUID()}`;
const container = `ledger-${runId}`;
const port = 35432;
let created = false;
let performance;
let performancePid;
let ready;
let bridge;
let targets;
let expectedProtected;
let interrupted = false;
let finishWaiting;
const interrupt = () => { interrupted = true; finishWaiting?.(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const report = { version: 'p0-target-acceptance-v1', runId, project, startedAt: new Date().toISOString(), results: [], bridgeTrace: [] };
report.maintenanceSha256 = {
  entry: sha256(readFileSync(new URL(import.meta.url))),
  runtime: sha256(readFileSync(new URL('./p0-target-runtime.mjs', import.meta.url))),
  contract: sha256(readFileSync(new URL('./p0-target-contract.mjs', import.meta.url))),
  probes: Object.fromEntries(['protected-baseline', 'automation-backup-projection', 'risk-probe', 'indicator-probe', 'performance-probe']
    .map((name) => [name, sha256(probeSource(name))])),
};
const write = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const resultLine = (output) => {
  const line = output.split('\n').find((value) => value.startsWith('P0_RESULT '));
  assert(line, '目标验收结果缺失'); return JSON.parse(line.slice('P0_RESULT '.length));
};
try {
  targets = inspectTargets();
  if (action === 'baseline') {
    const protectedState = protectedBaseline(targets['thesis-ledger']);
    writeFileSync(baselineFile, JSON.stringify({ version: report.version, project,
      targets: targetSummary(targets), protected: protectedState }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ stage: 'baseline', path: baselineFile, head: protectedState.schemaHead,
      tables: Object.keys(protectedState.tables).length, snapshotFiles: protectedState.snapshots.length, aiActive: protectedState.aiActive }));
  } else {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    assert.equal(baseline.version, report.version); assert.equal(baseline.project, project);
    report.targets = targetSummary(targets);
    for (const service of ['postgres', 'redis', 'dsa'])
      assert.deepEqual(report.targets[service].mounts,
        [...baseline.targets[service].mounts].sort((a, b) => a.destination.localeCompare(b.destination)), `${service} 原挂载改变`);
    const projection = upgradeProtectedBaseline(targets, baseline.protected, backupDirectory);
    expectedProtected = projection.expected; report.operationalCursorAudit = projection.audit;
    report.candidate = verifyCandidate(targets);
    const before = protectedBaseline(targets['thesis-ledger'], expectedProtected.columns);
    report.afterUpdate = { ...compareProtected(expectedProtected, before), schemaHead: before.schemaHead };
    const migrationsRoot = join(mainRoot, 'apps/server/prisma/migrations');
    const migrations = readdirSync(migrationsRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort();
    assert.equal(before.schemaHead, migrations.at(-1));
    const raw = readFileSync(inputsFile); const inputs = JSON.parse(raw);
    assert.equal(inputs.datasetKind, 'synthetic'); assert.equal(inputs.version, 'p0-target-inputs-v1');
    report.inputs = { sha256: sha256(raw), bytes: raw.length, cases: inputs.cases.map((item) => item.name) };
    // 独立 PostgreSQL 共享 Server 网络命名空间，只使用专属端口和 tmpfs；生产数据库未被传入探针。
    node(targets['thesis-ledger'], `import net from 'node:net';await new Promise((resolve,reject)=>{
      const s=net.connect(${port},'127.0.0.1');s.once('connect',()=>{s.destroy();reject(Error('验收端口已占用'))});s.once('error',resolve);});`);
    command(['run', '--pull', 'never', '-d', '--name', container, '--network', `container:${targets['thesis-ledger'].Id}`,
      '--tmpfs', '/var/lib/postgresql/data', '-e', `POSTGRES_USER=${fixtureOwner}`, '-e', 'POSTGRES_PASSWORD=isolated_fixture',
      '-e', `POSTGRES_DB=${fixtureDatabase}`, targets.postgres.Image, 'postgres', '-c', `port=${port}`, '-c', 'listen_addresses=*']);
    created = true;
    for (let attempt = 0; ; attempt++) {
      assert(!interrupted, '验收已中断');
      try { command(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', String(port), '-U', fixtureOwner, '-d', fixtureDatabase]); break; }
      catch { assert(attempt < 40, '隔离 PostgreSQL 未就绪'); await delay(250); }
    }
    for (const database of ['p0_risk_fixture', 'p0_indicator_fixture', fixtureDatabase]) {
      if (database !== fixtureDatabase)
        command(['exec', container, 'createdb', '-p', String(port), '-U', fixtureOwner, database]);
      for (const migration of migrations)
        command(['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-p', String(port), '-U', fixtureOwner,
          '-d', database, '-f', '-'], { input: readFileSync(join(migrationsRoot, migration, 'migration.sql'), 'utf8') });
    }
    const serverUrl = `postgresql://${fixtureOwner}:isolated_fixture@127.0.0.1:${port}/${fixtureDatabase}`;
    const commonNetwork = Object.keys(targets['thesis-ledger'].NetworkSettings.Networks)
      .find((name) => targets['backtest-worker'].NetworkSettings.Networks[name]);
    assert(commonNetwork, 'Server/Worker 没有共同目标网络');
    const address = targets['thesis-ledger'].NetworkSettings.Networks[commonNetwork].IPAddress;
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
    const workerUrl = `postgresql://${fixtureOwner}:isolated_fixture@${address}:${port}/p0_indicator_fixture`;
    const riskUrl = `postgresql://${fixtureOwner}:isolated_fixture@127.0.0.1:${port}/p0_risk_fixture`;
    report.results.push(resultLine(node(targets['thesis-ledger'], probeSource('risk-probe'), { P0_DATABASE_URL: riskUrl, P0_RUN_ID: runId })));
    assert(!interrupted, '验收已中断');
    console.log(JSON.stringify({ stage: 'RVCG', passed: true }));
    report.results.push(resultLine(node(targets['backtest-worker'], `globalThis.__P0_TARGET_INPUTS=${JSON.stringify(inputs)};\n` + probeSource('indicator-probe'),
      { P0_DATABASE_URL: workerUrl, P0_RUN_ID: runId }, { timeout: 120000 })));
    console.log(JSON.stringify({ stage: 'IVAG', passed: true }));
    performance = spawnNode(targets['thesis-ledger'], probeSource('performance-probe'), {
      PERFORMANCE_CORRECTNESS_DATABASE_URL: serverUrl, P0_RUN_ID: runId,
    });
    ready = await new Promise((resolveReady, reject) => {
      let output = '', error = '';
      const timer = setTimeout(() => reject(Error('收益独立服务启动超时')), 60000);
      performance.stdout.on('data', (part) => {
        output += part;
        const identity = output.split('\n').find((value) => value.startsWith('P0_PROCESS '));
        if (identity) performancePid = Number(identity.slice('P0_PROCESS '.length));
        const line = output.split('\n').find((value) => value.startsWith('P0_READY '));
        if (line) { clearTimeout(timer); resolveReady(JSON.parse(line.slice('P0_READY '.length))); }
      });
      performance.stderr.on('data', (part) => { error = (error + part).slice(-2000); });
      performance.on('exit', (code) => { clearTimeout(timer); reject(Error(`收益服务退出 ${code}: ${error}`)); });
      performance.on('error', reject);
    });
    assert(ready.port > 0 && ready.port !== 3000);
    report.results.push({ gate: 'PFCG-backend', outcomes: ready.outcomes, realModelCalls: 0 });
    let failNext = false;
    let complete;
    const finished = new Promise((resolveFinished) => { complete = resolveFinished; });
    finishWaiting = complete;
    bridge = createServer(async (request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, 'http://p0.local');
      if (request.method === 'POST' && url.pathname === '/__p0/fail-next-target-save') {
        failNext = true; response.end('{"armed":true}'); return;
      }
      if (request.method === 'POST' && url.pathname === '/__p0/finish') {
        response.end('{"finishing":true}'); complete(); return;
      }
      try {
        assertBridgeRequest(url, request.method);
        const parts = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; assert(length <= 20000); parts.push(chunk); }
        const body = Buffer.concat(parts).toString();
        if (failNext && request.method === 'POST' && url.pathname.endsWith('/targets')) {
          failNext = false; response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{"message":"本轮受控传输故障"}');
          report.bridgeTrace.push({ method: request.method, path: url.pathname, status: 503, controlledFailure: true }); return;
        }
        const payload = { path: url.pathname + url.search, method: request.method, body };
        const forwarded = node(targets['thesis-ledger'], `const p=${JSON.stringify(payload)};
const r=await fetch('http://127.0.0.1:${ready.port}'+p.path,{method:p.method,...(p.body?{headers:{'content-type':'application/json'},body:p.body}:{}),signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify({status:r.status,body:await r.text()}));`);
        const result = JSON.parse(forwarded);
        response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(result.body);
        report.bridgeTrace.push({ method: request.method, path: url.pathname, status: result.status, requestSha256: sha256(body) });
      } catch { response.writeHead(400); response.end('{"message":"独立验收请求被拒绝"}'); }
    });
    await new Promise((resolveListen) => bridge.listen(0, '127.0.0.1', resolveListen));
    report.bridge = { origin: `http://127.0.0.1:${bridge.address().port}`, accountId: ready.accountId, lossId: ready.lossId };
    write(); console.log('P0_BROWSER_READY ' + JSON.stringify({ ...report.bridge, backendOutcomes: ready.outcomes.length }));
    await finished;
    assert(!interrupted, '验收已中断');
    report.browserTransport = browserTransportStatus(report.bridgeTrace);
    assert(report.browserTransport.controlledFailures >= 1 && report.browserTransport.successfulSaves >= 1, '浏览器失败与重试尚未完成');
    report.completedAt = new Date().toISOString();
  }
} catch (error) {
  if (action === 'run') { report.failure = { name: error.name, message: error.message }; write(); }
  throw error;
} finally {
  try {
    if (bridge) await new Promise((resolveClose) => bridge.close(resolveClose));
    try {
      if (performancePid) terminateOwned(targets['thesis-ledger'], performancePid, runId);
      if (performance && performance.exitCode === null)
        await Promise.race([new Promise((resolveExit) => performance.once('exit', resolveExit)), delay(5000)]);
    } finally {
      if (created) command(['rm', '-f', container]);
    }
    if (action === 'run' && targets) {
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
      const expected = expectedProtected ?? baseline.protected;
      const after = protectedBaseline(targets['thesis-ledger'], expected.columns);
      try { report.afterAcceptance = compareProtected(expected, after); }
      catch (error) {
        report.afterAcceptanceFailure = error.message; write();
        if (!report.failure) throw error;
      }
      report.cleaned = !performance || performance.exitCode !== null; write();
      assert(report.cleaned, '独立收益进程尚未退出');
    }
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); unlock();
  }
}
