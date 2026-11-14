import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const target = 'thesis-ledger-dev';
export const payloads = ['postgres.dump', 'dsa.sqlite', 'dsa-data.tar', 'backtest.tar'];
const infraRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { docker, dockerRuntime, inspect, digest } from './runtime-io.mjs';
import { runApplicationCommand } from './application-contract.mjs';
export { docker, inspect, digest };
export function sql(container, query, connection) {
  let command = ['sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq'];
  if (connection !== undefined) {
    assert(connection && typeof connection === 'object', '数据库连接目标无效');
    assert([connection.owner, connection.database].every(value => typeof value === 'string' && value.length > 0), '数据库连接目标无效');
    command = ['psql', '-U', connection.owner, '-d', connection.database, '-Atq'];
  }
  return JSON.parse(docker(['exec', '-i', container, ...command], { input: query }).toString());
}
export async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

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
export function assertManifest(manifest, { format } = {}) {
  assert(typeof format === 'string' && format.length > 0, '调用方必须声明备份格式');
  assert.equal(manifest.format, format);
  assert.equal(manifest.target, target);
  assert.deepEqual(Object.keys(manifest.images).sort(), ['dsa', 'postgres', 'server', 'worker']);
  assert.deepEqual(manifest.files.map(file => file.name).sort(), [...payloads].sort());
  for (const file of manifest.files) {
    assert(/^[a-f0-9]{64}$/.test(file.sha256));
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
  for (const image of Object.values(manifest.images)) assert(/^sha256:[a-f0-9]{64}$/.test(image));
  assert.equal(manifest.images.worker, manifest.images.server);
  assert(manifest.state && typeof manifest.state === 'object', '缺少备份状态');
}
export async function verifyBundle(path, contract) {
  const directory = lstatSync(path);
  assert(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0);
  const manifestPath = resolve(path, 'manifest.json');
  const manifestStat = lstatSync(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink() && (manifestStat.mode & 0o077) === 0);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertManifest(manifest, contract);
  for (const file of manifest.files) {
    const source = resolve(path, file.name), stat = lstatSync(source);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, '载荷必须为私有普通文件');
    assert.equal(stat.size, file.bytes);
    assert.equal(await checksum(source), file.sha256);
  }
  return manifest;
}

const application = resolve(infraRoot, '../daily-stock-analysis');
const onlineSqlite = () => runApplicationCommand(application, ['snapshot-state'], { env: dockerRuntime().env });
function writeApplicationStream(path, command) {
  const fd = openSync(path, 'wx', 0o600);
  try { runApplicationCommand(application, [command], { env: dockerRuntime().env, stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
}
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
export async function backup(path, { protectionSql, assertState, format } = {}) {
  assert(typeof protectionSql === 'string' && typeof assertState === 'function', '业务项目必须提供备份保护合同');
  assert(typeof format === 'string' && format.length > 0, '调用方必须声明备份格式');
  checkOutputDirectory(path);
  const postgres = assertSource('postgres'), dsa = assertSource('dsa', '/app/data', 'thesis-ledger-dsa-data');
  const worker = assertSource('backtest-worker', '/app/var/backtest', 'thesis-ledger-backtest-data');
  const server = assertSource('thesis-ledger');
  const state = sql(postgres.Id, protectionSql);
  assertState(state);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const sqlite = onlineSqlite();
  writeFileSync(resolve(path, 'dsa.sqlite'), sqlite, { flag: 'wx', mode: 0o600 });
  writeStream(resolve(path, 'postgres.dump'), ['exec', postgres.Id, 'sh', '-c',
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl']);
  writeApplicationStream(resolve(path, 'dsa-data.tar'), 'archive-state');
  writeStream(resolve(path, 'backtest.tar'), ['exec', worker.Id, 'tar', '-C', '/app/var/backtest', '-cf', '-', '.']);
  assert.deepEqual(sql(postgres.Id, protectionSql), state, '备份期间业务状态变化，未封存Manifest');
  assert.equal(digest(onlineSqlite()), digest(sqlite), '备份期间DSA状态变化，未封存Manifest');
  const manifest = { format, target, createdAt: new Date().toISOString(),
    images: { postgres: postgres.Image, dsa: dsa.Image, worker: worker.Image, server: server.Image }, state,
    files: await Promise.all(payloads.map(async name => ({ name, bytes: lstatSync(resolve(path, name)).size,
      sha256: await checksum(resolve(path, name)) }))),
    sqliteDigest: digest(sqlite), localImageDependency: true };
  assertManifest(manifest, { format });
  writeFileSync(resolve(path, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  await verifyBundle(path, { format });
  return manifest;
}
