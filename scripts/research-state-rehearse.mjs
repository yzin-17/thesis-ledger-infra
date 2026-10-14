import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, docker, protectionSql, sql, target, verifyBundle } from './research-state-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function isolatedPostgresArgs(image, owner) {
  assert(/^sha256:[a-f0-9]{64}$/.test(image)); assert(/^[a-f0-9-]{36}$/.test(owner));
  return ['run', '--detach', '--name', `f01-restore-${owner}`, '--label', `io.thesisledger.f01=${owner}`,
    '--network', 'none', '-e', 'POSTGRES_DB=restore_db', '-e', 'POSTGRES_USER=restore_owner',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image];
}
// 只恢复普通文件和目录；拒绝路径越界、链接及特殊设备。
export const archiveProgram = `import pathlib,sys,tarfile,sqlite3,shutil
bundle,destination=map(pathlib.Path,sys.argv[1:3])
for name,folder in [('dsa-data.tar','dsa'),('backtest.tar','backtest')]:
    output=destination/folder; output.mkdir(mode=0o700)
    with tarfile.open(bundle/name) as archive:
        for member in archive.getmembers():
            path=pathlib.PurePosixPath(member.name)
            assert not path.is_absolute() and '..' not in path.parts, '归档路径越界'
            assert member.isfile() or member.isdir(), '归档包含链接或特殊文件'
        archive.extractall(output,filter='data')
shutil.copyfile(bundle/'dsa.sqlite',destination/'dsa'/'stock_analysis.db')
connection=sqlite3.connect('file:'+str(destination/'dsa'/'stock_analysis.db')+'?mode=ro',uri=True)
assert connection.execute('pragma integrity_check').fetchone()[0]=='ok'
print('SQLite完整性和归档恢复通过')`;

export function assertOwnedRestore(container, owner) {
  assert(/^[a-f0-9-]{36}$/.test(owner));
  assert.equal(container.Name, `/f01-restore-${owner}`);
  assert.equal(container.Config.Labels?.['io.thesisledger.f01'], owner);
}
export function cleanupRetained(path) {
  const absolute = resolve(path), directory = dirname(absolute);
  const receiptStat = lstatSync(absolute);
  assert(receiptStat.isFile() && !receiptStat.isSymbolicLink() && (receiptStat.mode & 0o077) === 0);
  const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
  assert.equal(receipt.format, 'thesis-ledger-restored-copy-v1');
  assert.equal(receipt.directory, directory);
  assert.equal(basename(directory), `restored-${receipt.owner}`);
  const directoryStat = lstatSync(directory);
  assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o077) === 0);
  // 借用备份目录边界检查；已有目录先在独立名称上验证其私有根。
  checkOutputDirectory(resolve(directory, `cleanup-check-${randomUUID()}`));
  const value = JSON.parse(docker(['inspect', receipt.containerName]).toString())[0];
  assertOwnedRestore(value, receipt.owner);
  assert.equal(value.Id, receipt.containerId);
  docker(['rm', '-f', '-v', value.Id]);
  rmSync(directory, { recursive: true });
  return { cleanedDirectory: directory, cleanedContainer: receipt.containerName };
}

export async function rehearse(bundle, requestedRuns, retainedOutput) {
  const manifest = await verifyBundle(bundle);
  assert(requestedRuns.length > 0 && requestedRuns.length <= 5, '选择1～5条代表性任务');
  const runs = requestedRuns.map(id => {
    assert(/^[a-f0-9-]{36}$/.test(id));
    const run = manifest.state.runs.find(item => item.id === id);
    assert(run && /^[a-f0-9]{16}$/.test(run.checksum), '任务不在该备份的成功V3清单');
    return run;
  });
  assert.equal(new Set(requestedRuns).size, requestedRuns.length);
  const source = `${target}-postgres-1`;
  const protectedState = sql(source, protectionSql);
  const owner = randomUUID(), containerName = `f01-restore-${owner}`;
  let directory;
  if (retainedOutput) {
    checkOutputDirectory(retainedOutput);
    mkdirSync(retainedOutput, { mode: 0o700 });
    directory = resolve(retainedOutput, `restored-${owner}`); mkdirSync(directory, { mode: 0o700 });
  } else directory = mkdtempSync(resolve(tmpdir(), 'thesis-ledger-f01-'));
  const replays = [];
  let restored, cleanupError, completed = false;
  try {
    const extraction = spawnSync('python3', ['-c', archiveProgram, resolve(bundle), directory], { encoding: 'utf8' });
    assert.equal(extraction.status, 0, '归档/SQLite恢复失败');
    docker(isolatedPostgresArgs(manifest.images.postgres, owner));
    let ready = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const probe = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'restore_owner', '-d', 'restore_db']);
      if (probe.status === 0) { ready = true; break; }
      await new Promise(done => setTimeout(done, 2000));
    }
    assert(ready, '隔离PostgreSQL未就绪');
    const restore = spawnSync('docker', ['exec', '-i', containerName, 'pg_restore', '--exit-on-error', '--single-transaction',
      '--no-owner', '--no-acl', '-U', 'restore_owner', '-d', 'restore_db'],
    { input: readFileSync(resolve(bundle, 'postgres.dump')), maxBuffer: 16 * 1024 * 1024 });
    assert.equal(restore.status, 0, '隔离数据库恢复失败');
    restored = sql(containerName, protectionSql, 'restore_db');
    assert.equal(restored.head, manifest.state.head);
    assert.deepEqual(restored.tables, manifest.state.tables);
    assert.deepEqual(restored.runs, manifest.state.runs);
    assert.equal(restored.activeBacktests, 0);
    const program = readFileSync(resolve(root, '../thesis-ledger/scripts/research-window-replay.mjs'));
    for (const run of runs) {
      const args = ['run', '--rm', '--label', `io.thesisledger.f01=${owner}`, '--network', 'none', '--read-only',
        '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,source=${resolve(directory, 'backtest')},target=/app/var/backtest,readonly`,
        '--entrypoint', 'node', '-i', manifest.images.worker, '--input-type=module', '-', run.id, run.checksum];
      const replay = spawnSync('docker', args, { input: program, maxBuffer: 128 * 1024 * 1024 });
      if (replay.status !== 0) {
        const diagnostic = replay.stderr.toString().split('\n').filter(line =>
          /Error:|ERR_|ENOENT|EACCES|cannot find|Cannot find|Permission denied/.test(line)).slice(0, 5).join('\n');
        throw new Error(`隔离镜像重放失败，任务${run.id}：${diagnostic}`);
      }
      const result = JSON.parse(replay.stdout.toString());
      assert(result.identicalReplay && result.replayCount === 2 && result.networkCalls === 0);
      assert.equal(result.resultChecksum, run.checksum);
      replays.push({ id: run.id, checksum: result.resultChecksum, replayCount: 2, networkCalls: 0 });
    }
    assert.deepEqual(sql(source, protectionSql), protectedState, '源业务状态变化');
    if (retainedOutput) {
      const value = JSON.parse(docker(['inspect', containerName]).toString())[0];
      assertOwnedRestore(value, owner);
      writeFileSync(resolve(directory, 'restore-receipt.json'), JSON.stringify({ format: 'thesis-ledger-restored-copy-v1',
        owner, containerName, containerId: value.Id, directory, bundle: resolve(bundle), images: manifest.images }, null, 2),
      { mode: 0o600, flag: 'wx' });
    }
    completed = true;
  } finally {
    const found = spawnSync('docker', ['inspect', containerName]);
    if (found.status === 0 && (!retainedOutput || !completed)) {
      const value = JSON.parse(found.stdout.toString())[0];
      if (value.Config.Labels?.['io.thesisledger.f01'] === owner && value.Name === `/${containerName}`) {
        try { docker(['rm', '-f', '-v', value.Id]); } catch { cleanupError = '隔离容器清理失败'; }
      } else cleanupError = '所有权不符，保留容器，不删除';
    }
    if (!retainedOutput || !completed) rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(sql(source, protectionSql), protectedState, '源业务状态变化');
    assert(!cleanupError, cleanupError);
  }
  return { bundle: resolve(bundle), restoredHead: restored.head, tableFingerprintsMatch: true,
    sqliteIntegrity: 'ok', replays, sourceUnchanged: true, isolatedResourcesCleaned: !retainedOutput,
    ...(retainedOutput ? { retainedDirectory: directory, retainedContainer: containerName,
      cleanupReceipt: resolve(directory, 'restore-receipt.json') } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, bundle, confirmation, ...flags] = process.argv.slice(2);
  if (flag === '--cleanup-receipt') {
    assert.equal(confirmation, '--confirm-isolated'); assert.equal(flags.length, 0);
    console.log(JSON.stringify(cleanupRetained(bundle)));
  } else {
    assert.equal(flag, '--bundle'); assert.equal(confirmation, '--confirm-isolated');
    assert(flags.every(flag => flag.startsWith('--run=') || flag.startsWith('--retain-output=')));
    const outputs = flags.filter(flag => flag.startsWith('--retain-output=')); assert(outputs.length <= 1);
    const result = await rehearse(bundle, flags.filter(flag => flag.startsWith('--run=')).map(flag => flag.slice(6)),
      outputs[0]?.slice('--retain-output='.length));
    console.log(JSON.stringify(result));
  }
}
