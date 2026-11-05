import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { checksum, docker, inspect, target } from './research-state-backup.mjs';

export const labelKey = 'io.thesis-ledger.research-dual-read';
export const roles = ['postgres', 'redis', 'server', 'fixture'];
export const receiptFormat = 'research-dual-read-runtime-v1';
export const controlledAccountId = '75000000-0000-4000-8000-000000000900';
export const baselineFiles = ['postgres.dump', 'research-fixtures.json', 'journal-fixtures.json'];

export async function verifyBaseline(directory) {
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  const manifestPath = resolve(directory, 'manifest.json'), manifestStat = lstatSync(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink() && (manifestStat.mode & 0o077) === 0);
  const manifest = JSON.parse(readFileSync(manifestPath));
  assert.equal(manifest.format, 'research-dual-read-baseline-v1');
  assert.equal(manifest.target, target); assert.equal(manifest.database, 'restore_db');
  assert.deepEqual(Object.keys(manifest.images).sort(), ['postgres', 'redis', 'server']);
  assert.equal(manifest.protection.database, 'restore_db');
  assert.equal(manifest.protection.owner, 'restore_owner');
  assert.equal(manifest.schemaHead, manifest.protection.head);
  assert.equal(manifest.controlledAccountId, controlledAccountId);
  assert(Number.isSafeInteger(manifest.counters.runs) && manifest.counters.runs > 0);
  assert.deepEqual(manifest.files.map(file => file.name).sort(), [...baselineFiles].sort());
  for (const image of Object.values(manifest.images)) assert(/^sha256:[a-f0-9]{64}$/.test(image));
  for (const file of manifest.files) {
    assert(baselineFiles.includes(file.name) && /^[a-f0-9]{64}$/.test(file.sha256));
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    const path = resolve(directory, file.name), payload = lstatSync(path);
    assert(payload.isFile() && !payload.isSymbolicLink() && (payload.mode & 0o077) === 0);
    assert.equal(payload.size, file.bytes); assert.equal(await checksum(path), file.sha256);
  }
  return manifest;
}

const columns = {
  Account: ['id', 'name', 'type', 'mode', 'currency', 'active', 'updatedAt'],
  AiRun: ['id', 'provider', 'model', 'promptVersion', 'status', 'question', 'context', 'result',
    'modelMetadata', 'researchOwnerId', 'researchSubmissionId', 'researchInputDigest',
    'researchScopeSnapshot', 'createdAt', 'updatedAt', 'completedAt'],
  AiToolCall: ['id', 'aiRunId', 'tool', 'permission', 'status', 'inputSummary', 'outputSummary', 'provider'],
};
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

export function fixtureSql(fixtures) {
  assert.equal(fixtures.format, 'research-dual-read-fixtures-v1');
  const statements = ['BEGIN;'];
  if (fixtures.account) {
    assert.equal(fixtures.account.id, controlledAccountId);
    assert.equal(fixtures.account.name, '受控双读复盘账户');
  }
  for (const [table, entries] of [['Account', fixtures.account ? [fixtures.account] : []],
    ['AiRun', fixtures.runs], ['AiToolCall', fixtures.calls]]) {
    for (const entry of entries) {
      const row = { ...entry };
      if (table === 'AiRun') Object.assign(row, { createdAt: '2026-10-18T09:00:00.000Z',
        updatedAt: '2026-10-18T09:00:00.000Z', completedAt: '2026-10-18T09:00:00.000Z' });
      assert(Object.keys(row).every(key => columns[table].includes(key)), '样本含未授权字段');
      const values = Object.values(row).map(value => typeof value === 'object'
        ? quote(JSON.stringify(value)) + '::jsonb' : quote(value));
      statements.push(`INSERT INTO "${table}" (${Object.keys(row).map(key => `"${key}"`).join(',')}) VALUES (${values.join(',')});`);
    }
  }
  statements.push('COMMIT;');
  return statements.join('\n');
}

export function assertOwned(value, token, role) {
  assert(/^[a-f0-9-]{36}$/.test(token));
  assert(roles.includes(role));
  assert.equal(value.Name, `/research-dual-read-${token}-${role}`);
  assert.equal(value.Config.Labels?.[labelKey], token);
  assert.equal(value.Config.Labels?.[`${labelKey}.role`], role);
  assert.equal(value.HostConfig.Privileged, false);
  assert.equal(value.HostConfig.Binds?.length ?? 0, 0, '隔离资源不得挂载宿主业务路径');
  assert(!value.Mounts.some(mount => mount.Type === 'volume'), '隔离资源不得使用持久卷');
  const network = value.HostConfig.NetworkMode;
  assert(network === 'none' || (role !== 'postgres' && network.startsWith('container:')));
  return value;
}

export function loadReceipt(directory) {
  const path = resolve(directory, 'runtime.json'), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  const value = JSON.parse(readFileSync(path));
  assert.equal(value.format, receiptFormat);
  assert.equal(value.target, target);
  assert.equal(resolve(directory), value.output);
  for (const role of ['postgres', 'redis', 'server']) {
    const container = assertOwned(inspect(value.containers[role]), value.token, role);
    assert.equal(container.Image, value.images[role]);
    if (role === 'postgres') assert.equal(container.HostConfig.NetworkMode, 'none');
    else assert.equal(container.HostConfig.NetworkMode, `container:${value.containers.postgres}`);
    if (role === 'server') {
      const environment = Object.fromEntries(container.Config.Env.map(item => {
        const split = item.indexOf('='); return [item.slice(0, split), item.slice(split + 1)];
      }));
      for (const key of ['AI_RESEARCH_EXECUTION_ENABLED', 'AI_RESEARCH_V2_WRITES_ENABLED',
        'STRATEGY_AI_OPTIMIZATION_ENABLED']) assert.equal(environment[key], 'false');
      assert.equal(environment.NODE_ENV, 'test');
      const database = new URL(environment.DATABASE_URL);
      assert.equal(database.protocol, 'postgresql:');
      assert.equal(database.username, 'research_reader');
      assert.equal(database.hostname, '127.0.0.1');
      assert.equal(database.port, '5432');
      assert.equal(database.pathname, '/restore_db');
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
    }
  }
  return value;
}

const transport = `const path=process.argv[1];
fetch('http://127.0.0.1:3000/api/v1'+path,{signal:AbortSignal.timeout(10000)})
.then(async response=>console.log(JSON.stringify({status:response.status,
type:response.headers.get('content-type'),retryAfter:response.headers.get('retry-after'),
body:Buffer.from(await response.arrayBuffer()).toString('base64')})))
.catch(()=>process.exit(1));`;

export function allowedGet(path) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) return false;
  const url = new URL(path, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/v1/')) url.pathname = url.pathname.slice(7);
  return url.origin === 'http://127.0.0.1' && (
    /^\/research\/(?:capabilities|reports(?:\/[a-f0-9-]{36}(?:\/evidence\/[a-f0-9-]{36})?)?)$/.test(url.pathname)
    || /^\/research\/reports\/[a-f0-9-]{36}\/observations(?:\/[a-f0-9-]{36}\/versions)?$/.test(url.pathname)
    || /^\/journal\/(?:explanations|period-explanations)\/[a-f0-9-]{36}$/.test(url.pathname)
    || /^\/backtests\/runs\/[a-f0-9-]{36}$/.test(url.pathname));
}

/** 只转发 GET 原始字节与状态；不创建或替换任何业务响应。 */
export async function openReadBridge(container, port = 0) {
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'GET' || !allowedGet(request.url ?? '')) {
      response.writeHead(405); response.end(); return;
    }
    try {
      const path = request.url.startsWith('/api/v1/') ? request.url.slice(7) : request.url;
      const wire = JSON.parse(docker(['exec', container, 'node', '-e', transport, path]));
      if (wire.type) response.setHeader('Content-Type', wire.type);
      if (wire.retryAfter) response.setHeader('Retry-After', wire.retryAfter);
      response.writeHead(wire.status); response.end(Buffer.from(wire.body, 'base64'));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)) };
}
