import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, digest, inspect, protectionSql, sql, target, verifyBundle } from './research-state-backup.mjs';
import { normalizeMounts, validateSnapshot } from './dsa-runtime-snapshot.mjs';
import { assertDsaTarget } from './dsa-target-contract.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(infra, 'scripts/dsa-state-retention.py');

function python(args, input) {
  const executable = join(infra, '../daily-stock-analysis/.venv/bin/python');
  const result = spawnSync(executable, args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000 });
  assert.equal(result.status, 0, '基线只读解析失败');
  return JSON.parse(result.stdout);
}

export async function auditRetention(backup, checkpointPath, candidateReportPath, output) {
  for (const path of [backup, checkpointPath, candidateReportPath, output]) assert.equal(resolve(path), path);
  checkOutputDirectory(output);
  const original = await verifyBundle(backup);
  const checkpoint = validateSnapshot(JSON.parse(readFileSync(checkpointPath)));
  assert.equal(checkpoint.imageId, original.images.dsa);
  const candidate = JSON.parse(readFileSync(candidateReportPath));
  assert(candidate.completedAt && candidate.cleaned && !candidate.failure && !candidate.cleanupFailure);
  assert.equal(candidate.backup.path, backup);
  const before = inspect(`${target}-dsa-1`);
  assertDsaTarget(before);
  assert.equal(before.Image, candidate.candidate.image);
  assert.deepEqual(normalizeMounts(before.Mounts), normalizeMounts(checkpoint.mounts));
  assert.equal(digest(readFileSync(join(infra, '.env'))), checkpoint.envSha256, '正式配置文件已变化');
  assert.deepEqual(sql(`${target}-postgres-1`, protectionSql), original.state, '主仓保护状态已变化');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const baseline = python([probe, 'baseline', join(backup, 'dsa.sqlite'), join(backup, 'dsa-data.tar')]);
  writeFileSync(join(output, 'baseline.json'), JSON.stringify(baseline) + '\n', { flag: 'wx', mode: 0o600 });
  const report = { version: 'dsa-dg2b-retention-v1', startedAt: new Date().toISOString(),
    baselineCreatedAt: original.createdAt, baselineFiles: original.files,
    candidateImage: before.Image, targetId: before.Id, checkpointImage: checkpoint.imageId,
    verificationScriptSha256: digest(readFileSync(probe)), entrySha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    mountsUnchanged: true, environmentFileUnchanged: true, mainProtectedStateUnchanged: true };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  try {
    const result = spawnSync('docker', ['exec', '-i', '-e', 'PYTHONDONTWRITEBYTECODE=1', before.Id,
      'python', '-c', readFileSync(probe, 'utf8'), 'live'], {
      input: JSON.stringify(baseline), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000,
    });
    let observed;
    try { observed = JSON.parse(result.stdout); } catch { throw new Error('目标留存读取未返回结构化结果'); }
    report.observed = observed;
    assert.equal(result.status, 0, observed.reason ?? '目标留存读取失败');
    assert.equal(observed.passed, true);
    const after = inspect(before.Id);
    assertDsaTarget(after);
    assert.equal(inspect(`${target}-dsa-1`).Id, before.Id, '验收期间目标容器被替换');
    assert.equal(after.State.StartedAt, before.State.StartedAt, '验收期间目标被重启');
    assert.equal(after.Image, before.Image);
    assert.deepEqual(normalizeMounts(after.Mounts), normalizeMounts(before.Mounts));
    assert.deepEqual(sql(`${target}-postgres-1`, protectionSql), original.state);
    assert.equal(digest(readFileSync(join(infra, '.env'))), checkpoint.envSha256);
    assert.equal(digest(readFileSync(probe)), report.verificationScriptSha256);
    report.completedAt = new Date().toISOString(); report.passed = true; save();
    return report;
  } catch (error) {
    report.failure = { name: error.name, message: error.message }; save(); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, backup, checkpoint, candidateReport, output] = process.argv.slice(2);
  assert.equal(mode, 'audit');
  assert(backup && checkpoint && candidateReport && output && !existsSync(output));
  const report = await auditRetention(backup, checkpoint, candidateReport, output);
  console.log(JSON.stringify({ path: join(output, 'report.json'), passed: report.passed,
    tables: report.observed.tables.length, rows: report.observed.tables.reduce((n, t) => n + t.originalRows, 0),
    files: report.observed.objects.length, credentials: report.observed.credentials.length,
    announcementOriginals: report.observed.artifacts.originals.length, fx: report.observed.fx }));
}
