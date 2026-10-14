import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const project = 'thesis-ledger-dev';
export const database = 'thesis_ledger';
const services = ['thesis-ledger', 'backtest-worker', 'postgres', 'redis', 'dsa'];
export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).trim();
export function assertOwnedRun(row, prefix) {
  assert.match(row.id, /^[0-9a-f-]{36}$/i);
  assert.equal(row.mode, 'V3');
  assert(typeof row.idempotencyKey === 'string' && row.idempotencyKey.startsWith(prefix), 'Run 不属于本次验收');
}
export function assertContainer(row, service) {
  assert.equal(row.Config.Labels['com.docker.compose.project'], project);
  assert.equal(row.Config.Labels['com.docker.compose.service'], service);
  assert(row.State.Running, `${service} 未运行`);
}

export function createTargetRuntime(prefix) {
  assert.match(prefix, /^t4-[0-9a-f-]+$/);
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  assert.equal(docker('context', 'show'), 'desktop-linux');
  const endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}');
  assert(endpoint.startsWith('unix://'));
  const checksum = execFileSync('cksum', { input: endpoint, encoding: 'utf8' }).split(/\s+/)[0];
  const lock = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  const baseline = new Map();
  const stopped = new Set();
  const snapshots = new Set();
  const trace = [];
  const record = (stage, facts) => {
    const row = { at: new Date().toISOString(), stage, ...facts };
    trace.push(row);
    console.log(JSON.stringify(row));
  };
  const inspect = (service) => JSON.parse(docker('inspect', `${project}-${service}-1`))[0];
  const sql = (query) => JSON.parse(docker('exec', baseline.get('postgres').Id, 'psql', '-U', database, '-d', database,
    '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `BEGIN READ ONLY; ${query}; COMMIT;`));
  const node = (code) => execFileSync('docker', ['exec', '-i', baseline.get('thesis-ledger').Id, 'node', '--input-type=module'],
    { input: code, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }).trim();
  const state = (id) => {
    assert.match(id, /^[0-9a-f-]{36}$/i);
    const row = sql(`SELECT row_to_json(t) FROM "BacktestJob" t WHERE id='${id}'`);
    assertOwnedRun(row, prefix);
    return row;
  };
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:3000/api/v1${path}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result).slice(0, 1200)}`);
    return result;
  };
  const wait = async (probe, label, timeout = 150_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result) return result;
      await delay(500);
    }
    throw new Error(`${label} 超时`);
  };
  const protect = () => {
    const tables = ['Account', 'LedgerEvent', 'JournalEntry', 'JournalReviewSnapshot', 'AiRun', 'AiToolCall', 'Strategy', 'StrategyVersion', 'StrategyAuthoringOperation', 'AutomationRun', 'ProviderConfig', 'AiRoutingSettings', 'DesiredProviderPolicy', 'DesiredProviderPolicyRevision'];
    return sql(`SELECT json_build_object(${tables.map(t => `'${t}',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) FROM "${t}" t)`).join(',')},'BacktestJob',(SELECT md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY id),'')) FROM "BacktestJob" t WHERE coalesce("idempotencyKey",'') NOT LIKE '${prefix}%'))`);
  };
  const noOtherWork = () => {
    const counts = sql(`SELECT json_build_object('backtest',(SELECT count(*) FROM "BacktestJob" WHERE status IN ('queued','running') AND coalesce("idempotencyKey",'') NOT LIKE '${prefix}%'),'ai',(SELECT count(*) FROM "AiRun" WHERE status IN ('queued','running')),'authoring',(SELECT count(*) FROM "StrategyAuthoringOperation" WHERE status IN ('queued','running')),'automation',(SELECT count(*) FROM "AutomationRun" WHERE status IN ('queued','running'))) `);
    for (const [kind, count] of Object.entries(counts)) assert.equal(count, 0, `存在其他在途任务: ${kind}`);
  };
  const stop = (service, signal = 'SIGTERM') => {
    assert(['redis', 'backtest-worker'].includes(service), '仅允许故障注入目标 Redis/Worker');
    noOtherWork();
    const current = inspect(service);
    assertContainer(current, service);
    assert.equal(current.Id, baseline.get(service).Id);
    assert.equal(current.Image, baseline.get(service).Image);
    stopped.add(service);
    docker('kill', `--signal=${signal}`, baseline.get(service).Id);
    record('service-stopped', { service, signal });
  };
  const start = (service) => {
    assert.equal(inspect(service).Id, baseline.get(service).Id);
    docker('start', baseline.get(service).Id);
    stopped.delete(service);
    record('service-restored', { service });
  };
  const snapshot = (id, action) => {
    state(id);
    const p = `/app/var/backtest/snapshots/${id}/finalized.json`;
    const code = `import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto'; const p=${JSON.stringify(p)},b=p+'.t4-original';
      if(${JSON.stringify(action)}==='block'){fs.renameSync(p,b);execFileSync('mkfifo',[p]);}
      else if(${JSON.stringify(action)}==='release'){fs.writeFileSync(p,fs.readFileSync(b));fs.unlinkSync(p);fs.renameSync(b,p);}
      else if(fs.existsSync(b)){fs.unlinkSync(p);fs.renameSync(b,p);}
      console.log(JSON.stringify({hash:createHash('sha256').update(fs.readFileSync(${JSON.stringify(action)}==='block'?b:p)).digest('hex')}));`;
    if (action === 'block') snapshots.add(id);
    const result = JSON.parse(node(code));
    if (action !== 'block') snapshots.delete(id);
    record(`snapshot-${action}`, { id, ...result });
    return result.hash;
  };
  const cleanup = async () => {
    if (snapshots.size && inspect('backtest-worker').State.Running) stop('backtest-worker', 'SIGKILL');
    for (const id of snapshots) snapshot(id, 'restore');
    for (const service of stopped) start(service);
    await wait(() => sql(`SELECT count(*) FROM "BacktestJob" WHERE "idempotencyKey" LIKE '${prefix}%' AND status IN ('queued','running')`) === 0, '验收任务恢复终态');
    await wait(() => services.every(s => inspect(s).State.Health?.Status === 'healthy'), '服务恢复健康');
    for (const service of services) {
      const current = inspect(service), initial = baseline.get(service);
      assert.equal(current.Id, initial.Id); assert.equal(current.Image, initial.Image);
    }
    record('cleanup', { healthy: true, containerIdentityPreserved: true });
    rmSync(join(lock, 'pid'), { force: true }); rmdirSync(lock);
  };
  try {
    assert(!/running|pending/i.test(docker('buildx', '--builder', 'desktop-linux', 'history', 'ls', '--format', '{{.Status}}')));
    for (const service of services) {
      const row = inspect(service); assertContainer(row, service);
      assert.equal(row.State.Health?.Status, 'healthy'); baseline.set(service, row);
    }
    assert.equal(baseline.get('thesis-ledger').Image, baseline.get('backtest-worker').Image);
    const identity = sql('SELECT json_build_object(\'database\',current_database(),\'owner\',current_user,\'head\',(SELECT version FROM "SchemaVersion" WHERE id=1))');
    assert.equal(identity.database, database); assert.equal(identity.owner, database);
    noOtherWork();
    record('baseline', { ...identity, image: baseline.get('backtest-worker').Image });
  } catch (error) {
    rmSync(join(lock, 'pid'), { force: true }); rmdirSync(lock); throw error;
  }
  return { prefix, trace, record, inspect, baseline, sql, node, state, request, wait, protect, noOtherWork, stop, start, snapshot, cleanup, delay, hash: value => createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
