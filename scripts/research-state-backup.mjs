import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const target = 'thesis-ledger-dev';
export const payloads = ['postgres.dump', 'dsa.sqlite', 'dsa-data.tar', 'backtest.tar'];
const infraRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const protectedTables = ['Account', 'AccountLedgerState', 'LedgerEvent', 'PortfolioSnapshot', 'Strategy', 'StrategyVersion', 'BacktestJob'];
export const protectionSql = `SELECT json_build_object(
  'database',current_database(), 'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
  'head',(SELECT version FROM "SchemaVersion" WHERE id=1),
  'activeBacktests',(SELECT count(*) FROM "BacktestJob" WHERE status IN ('queued','running')),
  'tables',json_build_object(${protectedTables.map(t => `'${t}',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "${t}" t)`).join(',')}),
  'runs',(SELECT coalesce(json_agg(json_build_object('id',id,'checksum',"resultChecksum") ORDER BY id),'[]'::json)
    FROM "BacktestJob" WHERE status='succeeded' AND result->>'schemaVersion'='3'));`;

export function docker(args, options = {}) {
  const result = spawnSync('docker', args, { maxBuffer: 128 * 1024 * 1024, ...options });
  // 不回显命令环境或可能含私密业务载荷的错误文本。
  assert.equal(result.status, 0, `Docker维护步骤失败：${args[0]} ${args[1] ?? ''}`);
  return result.stdout;
}
export const inspect = name => JSON.parse(docker(['inspect', name]).toString())[0];
export function sql(container, query, database) {
  assert(database === undefined || database === 'restore_db', '隔离库名必须为固定恢复目标');
  return JSON.parse(docker(['exec', '-i', container, 'sh', '-c',
    database ? 'exec psql -U restore_owner -d restore_db -Atq' : 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq'],
    { input: query }).toString());
}
export async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function checkOutputDirectory(path) {
  assert(isAbsolute(path), '备份目录必须为绝对路径');
  const roots = [resolve(infraRoot, '.maintenance-backups'), resolve(infraRoot, '../thesis-ledger/.recovery-artifacts')];
  const root = roots.find(root => resolve(path).startsWith(root + sep));
  assert(root, '备份必须写入约定的私有忽略目录');
  for (let parent = dirname(resolve(path)); parent.startsWith(root); parent = dirname(parent)) {
    if (existsSync(parent)) assert(!lstatSync(parent).isSymbolicLink(), '私有目录不能通过符号链接跳转');
    if (parent === root) break;
  }
  assert(!existsSync(path), '不能覆盖已有备份目录');
}
export function assertManifest(manifest) {
  assert.equal(manifest.format, 'thesis-ledger-research-state-v1');
  assert.equal(manifest.target, target);
  assert.deepEqual(Object.keys(manifest.images).sort(), ['dsa', 'postgres', 'server', 'worker']);
  assert.deepEqual(manifest.files.map(file => file.name).sort(), [...payloads].sort());
  for (const file of manifest.files) {
    assert(/^[a-f0-9]{64}$/.test(file.sha256));
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
  for (const image of Object.values(manifest.images)) assert(/^sha256:[a-f0-9]{64}$/.test(image));
  assert.equal(manifest.images.worker, manifest.images.server);
  assert.equal(manifest.state.database, 'thesis_ledger');
  assert.equal(manifest.state.owner, 'thesis_ledger');
  assert.equal(manifest.state.activeBacktests, 0);
  assert(/^\d{14}_[a-z0-9_]+$/.test(manifest.state.head));
  assert(Array.isArray(manifest.state.runs));
  for (const run of manifest.state.runs) {
    assert(/^[a-f0-9-]{36}$/.test(run.id) && /^[a-f0-9]{16}$/.test(run.checksum));
  }
}
export async function verifyBundle(path) {
  const directory = lstatSync(path);
  assert(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0);
  const manifestPath = resolve(path, 'manifest.json');
  const manifestStat = lstatSync(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink() && (manifestStat.mode & 0o077) === 0);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertManifest(manifest);
  for (const file of manifest.files) {
    const source = resolve(path, file.name), stat = lstatSync(source);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, '载荷必须为私有普通文件');
    assert.equal(stat.size, file.bytes);
    assert.equal(await checksum(source), file.sha256);
  }
  return manifest;
}

const sqliteProgram = `import os, sqlite3, sys
source=sqlite3.connect('file:'+os.environ['DATABASE_PATH']+'?mode=ro',uri=True)
copy=sqlite3.connect(':memory:'); source.backup(copy)
assert copy.execute('pragma integrity_check').fetchone()[0]=='ok'
sys.stdout.buffer.write(copy.serialize())`;
const onlineSqlite = () => docker(['exec', `${target}-dsa-1`, 'python', '-c', sqliteProgram]);
function writeStream(path, args) {
  const fd = openSync(path, 'wx', 0o600);
  try { docker(args, { stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
}
function assertSource(service, mountedPath, volume) {
  const value = inspect(`${target}-${service}-1`);
  assert(value.State.Running && value.State.Health?.Status === 'healthy', `${service}未就绪`);
  if (volume) assert(value.Mounts.some(m => m.Destination === mountedPath && m.Type === 'volume' && m.Name === volume));
  return value;
}
export async function backup(path) {
  checkOutputDirectory(path);
  const postgres = assertSource('postgres'), dsa = assertSource('dsa', '/app/data', 'thesis-ledger-dsa-data');
  const worker = assertSource('backtest-worker', '/app/var/backtest', 'thesis-ledger-backtest-data');
  const server = assertSource('thesis-ledger');
  const state = sql(postgres.Id, protectionSql);
  assert.equal(state.database, 'thesis_ledger'); assert.equal(state.owner, 'thesis_ledger');
  assert.equal(state.activeBacktests, 0, '存在活动回测，不能形成稳定研究备份');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const sqlite = onlineSqlite();
  writeFileSync(resolve(path, 'dsa.sqlite'), sqlite, { flag: 'wx', mode: 0o600 });
  writeStream(resolve(path, 'postgres.dump'), ['exec', postgres.Id, 'sh', '-c',
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl']);
  writeStream(resolve(path, 'dsa-data.tar'), ['exec', dsa.Id, 'tar', '-C', '/app/data',
    '--exclude=./stock_analysis.db', '--exclude=./stock_analysis.db-wal', '--exclude=./stock_analysis.db-shm', '-cf', '-', '.']);
  writeStream(resolve(path, 'backtest.tar'), ['exec', worker.Id, 'tar', '-C', '/app/var/backtest', '-cf', '-', '.']);
  assert.deepEqual(sql(postgres.Id, protectionSql), state, '备份期间业务状态变化，未封存Manifest');
  assert.equal(digest(onlineSqlite()), digest(sqlite), '备份期间DSA状态变化，未封存Manifest');
  const manifest = { format: 'thesis-ledger-research-state-v1', target, createdAt: new Date().toISOString(),
    images: { postgres: postgres.Image, dsa: dsa.Image, worker: worker.Image, server: server.Image }, state,
    files: await Promise.all(payloads.map(async name => ({ name, bytes: lstatSync(resolve(path, name)).size,
      sha256: await checksum(resolve(path, name)) }))),
    sqliteDigest: digest(sqlite), localImageDependency: true };
  assertManifest(manifest);
  writeFileSync(resolve(path, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  await verifyBundle(path);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, flag, selected, outputFlag, path] = process.argv.slice(2);
  assert.equal(flag, '--target'); assert.equal(selected, target); assert.equal(outputFlag, '--output');
  assert(['backup', 'verify'].includes(mode));
  const result = mode === 'backup' ? await backup(path) : await verifyBundle(path);
  console.log(JSON.stringify({ mode, path, files: result.files, runCount: result.state.runs.length, images: result.images }));
}
