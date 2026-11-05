import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, assertTarget, readAutomationArchive } from './p0-target-contract.mjs';

export const mainRoot = fileURLToPath(new URL('../../thesis-ledger/', import.meta.url));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function command(args, options = {}) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024, ...options }).trim(); }
  catch (error) {
    const detail = String(error.stderr ?? '').split('\n').find((line) => /^(?:Error|AssertionError|TypeError|ReferenceError|SyntaxError)/.test(line));
    throw new Error(`Docker 维护步骤失败（${args[0]}，退出 ${error.status ?? 'unknown'}，${error.code ?? 'command-error'}）${detail ? ': ' + detail.slice(0, 300) : ''}`);
  }
}
export function inspectTargets() {
  const result = {};
  for (const service of ['thesis-ledger', 'backtest-worker', 'postgres', 'redis', 'dsa']) {
    const info = JSON.parse(command(['inspect', `${project}-${service}-1`]))[0];
    assertTarget(info, service);
    if (info.State.Health) assert.equal(info.State.Health.Status, 'healthy', `${service} 健康门禁未通过`);
    result[service] = info;
  }
  assert.equal(result['thesis-ledger'].Image, result['backtest-worker'].Image, 'Server/Worker 镜像不同');
  return result;
}
export function acquireLock() {
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  const context = command(['context', 'show']);
  const endpoint = command(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
  assert(endpoint.startsWith('unix://'), '只允许本地 Docker context');
  const checksum = execFileSync('cksum', { input: endpoint, encoding: 'utf8' }).split(/\s+/)[0];
  const directory = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'pid'), `${process.pid}\n`, { mode: 0o600 });
  return () => {
    assert.equal(readFileSync(join(directory, 'pid'), 'utf8').trim(), String(process.pid));
    unlinkSync(join(directory, 'pid')); rmdirSync(directory);
  };
}
export function node(target, source, env = {}, options = {}) {
  const variables = { NODE_USE_ENV_PROXY: '0', ...env };
  return command(['exec', '-i', ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    target.Id, 'node', '--input-type=module'], { input: source, ...options });
}
export function spawnNode(target, source, env) {
  const child = spawn('docker', ['exec', '-i', ...Object.entries({ NODE_USE_ENV_PROXY: '0', ...env })
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]), target.Id, 'node', '--input-type=module'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(source);
  return child;
}
export const probeSource = (name) => readFileSync(join(mainRoot, 'scripts/p0-target', `${name}.mjs`), 'utf8');
export function protectedBaseline(target, columns) {
  const prefix = `globalThis.__P0_BASELINE_COLUMNS=${JSON.stringify(columns)};\n`;
  const output = node(target, prefix + probeSource('protected-baseline'));
  const line = output.split('\n').find((value) => value.startsWith('P0_BASELINE '));
  assert(line, '保护摘要未返回');
  return JSON.parse(line.slice('P0_BASELINE '.length));
}
export function upgradeProtectedBaseline(targets, baseline, backupDirectory) {
  const allowed = fileURLToPath(new URL('../.database-upgrades/', import.meta.url));
  assert(backupDirectory && resolve(backupDirectory).startsWith(allowed), '必须使用本仓正式保留升级备份目录');
  const rehearsal = JSON.parse(readFileSync(join(backupDirectory, 'rehearsal.json'), 'utf8'));
  assert.equal(rehearsal.target.databaseName, baseline.database);
  assert.equal(rehearsal.checks.preservedData, true);
  assert.equal(rehearsal.checks.restoredSourceHead, baseline.schemaHead);
  const backup = readFileSync(join(backupDirectory, 'backup.dump'));
  assert.equal(sha256(backup), rehearsal.backupSha256, '正式备份摘要不符');
  // pg_restore 选表读完后可先于整份归档流关闭 stdin；只接受退出 0、无诊断且完整 COPY 的 EPIPE。
  const copy = readAutomationArchive(spawnSync('docker', ['exec', '-i', targets.postgres.Id, 'pg_restore', '--data-only', '--table=AutomationJob', '--file=-'],
    { input: backup, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
  const prefix = `globalThis.__P0_AUTOMATION_COPY=${JSON.stringify(copy)};globalThis.__P0_AUTOMATION_COLUMNS=${JSON.stringify(baseline.columns.AutomationJob)};\n`;
  const output = node(targets['thesis-ledger'], prefix + probeSource('automation-backup-projection'));
  const line = output.split('\n').find((value) => value.startsWith('P0_AUTOMATION_PROJECTION '));
  assert(line, '任务备份核对未返回');
  const projection = JSON.parse(line.slice('P0_AUTOMATION_PROJECTION '.length));
  const expected = structuredClone(baseline);
  expected.columns.AutomationJob = projection.columns;
  expected.tables.AutomationJob = projection.table;
  return { expected, audit: { ...projection.audit, backupDirectory, backupSha256: rehearsal.backupSha256,
    consumersStoppedAt: rehearsal.consumersStoppedAt, backupCompletedAt: rehearsal.backupCompletedAt } };
}
const manifestProgram = `import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import{createRequire}from'node:module';
const require=createRequire('/app/package.json');const result={};
const roots={server:'/app/apps/server/dist/src',assembly:'/app/apps/server/dist/test/performance',domain:path.dirname(require.resolve('@thesis-ledger/domain')),
schemas:path.dirname(require.resolve('@thesis-ledger/schemas')),shared:path.dirname(require.resolve('@thesis-ledger/shared'))};
function visit(root,section,relative=''){for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 const name=path.join(relative,item.name);if(item.isDirectory())visit(root,section,name);else if(/\\.(js|json)$/.test(name))result[section+'/'+name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');}}
for(const [section,root]of Object.entries(roots))visit(root,section);console.log(JSON.stringify(result));`;
export function verifyCandidate(targets) {
  const expected = {};
  const excludedHostBuildOrphans = [];
  function visit(root, sourceRoot, section, relative = '') {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, item.name);
      if (item.isDirectory()) visit(root, sourceRoot, section, name);
      else if (/\.(js|json)$/.test(name)) {
        const source = join(sourceRoot, name.replace(/\.js$/, '.ts'));
        if (!existsSync(source)) { excludedHostBuildOrphans.push(`${section}/${name}`); continue; }
        assert(statSync(source).mtimeMs <= statSync(join(root, name)).mtimeMs, `本地编译产物早于当前源码：${section}/${name}`);
        expected[`${section}/${name}`] = sha256(readFileSync(join(root, name)));
      }
    }
  }
  for (const [section, directories] of Object.entries({ server: ['apps/server/dist/src', 'apps/server/src'],
    assembly: ['apps/server/dist/test/performance', 'apps/server/test/performance'],
    domain: ['packages/domain/dist', 'packages/domain/src'], schemas: ['packages/schemas/dist', 'packages/schemas/src'],
    shared: ['packages/shared/dist', 'packages/shared/src'] }))
    visit(join(mainRoot, directories[0]), join(mainRoot, directories[1]), section);
  const server = JSON.parse(node(targets['thesis-ledger'], manifestProgram));
  const worker = JSON.parse(node(targets['backtest-worker'], manifestProgram));
  const differing = Object.keys({ ...expected, ...server }).filter((name) => expected[name] !== server[name]);
  assert.equal(differing.length, 0, `目标编译输入不匹配：${differing.slice(0, 12).join(',')}`);
  assert.deepEqual(worker, server, 'Worker 编译输入与 Server 不匹配');
  return { files: Object.keys(server).length, sha256: sha256(JSON.stringify(server)),
    imageId: targets['thesis-ledger'].Image, excludedHostBuildOrphans };
}
export function targetSummary(targets) {
  return Object.fromEntries(Object.entries(targets).map(([service, info]) => [service, {
    id: info.Id, imageId: info.Image, startedAt: info.State.StartedAt,
    mounts: info.Mounts.map((mount) => ({ type: mount.Type, name: mount.Name ?? null, source: mount.Source, destination: mount.Destination }))
      .sort((a, b) => a.destination.localeCompare(b.destination)),
  }]));
}
export function terminateOwned(target, pid, runId) {
  assert(Number.isInteger(pid) && pid > 1);
  const source = `import fs from 'node:fs';const pid=${pid};const file='/proc/'+pid+'/environ';
if(fs.existsSync(file)){const fields=fs.readFileSync(file,'utf8').split('\\0');
if(!fields.includes(${JSON.stringify(`P0_RUN_ID=${runId}`)}))throw Error('验收进程身份不符');process.kill(pid,'SIGTERM');}`;
  node(target, source);
}
