import assert from 'node:assert/strict';
import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkOutputDirectory, checksum, digest, docker, protectionSql, sql, target } from './research-state-backup.mjs';
import { baselineFiles as files, loadReceipt, controlledAccountId, verifyBaseline } from './research-dual-read-runtime.mjs';
export { verifyBaseline } from './research-dual-read-runtime.mjs';
import { counterSql, sourceState } from './research-dual-read.mjs';

const same = (a, b, message) => assert(digest(Buffer.from(JSON.stringify(a))) === digest(Buffer.from(JSON.stringify(b))), message);
const privateFile = path => {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, '基线载荷必须为私有普通文件');
  return stat;
};

export async function sealBaseline(runtimeDirectory, consumerDirectory, output) {
  checkOutputDirectory(output);
  const receipt = loadReceipt(runtimeDirectory), before = sourceState().state;
  same(before, receipt.before, '目标已偏离双读验收基线');
  const reportPath = resolve(consumerDirectory, 'report.json'); privateFile(reportPath);
  const report = JSON.parse(readFileSync(reportPath));
  assert(report.passed && report.targetPreserved && report.originalProtectedDataUnchanged);
  assert.equal(report.serverImage, receipt.images.server);
  assert.equal(report.consumers.existingStrategyResultsRead, receipt.copyBefore.runs.length);
  const originalSql = protectionSql.replace('FROM "Account" t',
    `FROM (SELECT * FROM "Account" WHERE id<>'${controlledAccountId}'::uuid) t`);
  same(sql(receipt.containers.postgres, originalSql, 'restore_db'), receipt.copyBefore, '副本原有业务数据变化');
  const counters = sql(receipt.containers.postgres, counterSql, 'restore_db');
  assert.equal(counters.runs, receipt.seeded.runs + 4);
  assert.equal(counters.tools, receipt.seeded.tools + 4);
  assert.equal(counters.invocations, receipt.seeded.invocations);
  const protection = sql(receipt.containers.postgres, protectionSql, 'restore_db');
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), value, { flag: 'wx', mode: 0o600 });
  save('postgres.dump', docker(['exec', receipt.containers.postgres, 'pg_dump', '-U', 'restore_owner',
    '-d', 'restore_db', '--format=custom', '--no-owner', '--no-acl']));
  save('research-fixtures.json', readFileSync(resolve(runtimeDirectory, 'fixtures.json')));
  save('journal-fixtures.json', readFileSync(resolve(consumerDirectory, 'fixtures.json')));
  same(sql(receipt.containers.postgres, counterSql, 'restore_db'), counters, '封存期间副本任务状态变化');
  same(sql(receipt.containers.postgres, protectionSql, 'restore_db'), protection, '封存期间副本数据变化');
  same(sourceState().state, before, '封存改变目标状态');
  const manifest = { format: 'research-dual-read-baseline-v1', target, database: 'restore_db',
    createdAt: new Date().toISOString(), images: receipt.images, schemaHead: protection.head,
    protection, originalProtection: receipt.copyBefore, counters,
    controlledAccountId, inputs: report.inputs, consumerInputsSha256: report.consumerInputsSha256,
    consumerReportSha256: await checksum(reportPath),
    files: await Promise.all(files.map(async name => ({ name,
      bytes: lstatSync(resolve(output, name)).size, sha256: await checksum(resolve(output, name)) }))) };
  save('manifest.json', JSON.stringify(manifest, null, 2));
  await verifyBaseline(output);
  console.log(JSON.stringify({ format: manifest.format, output, files: manifest.files,
    serverImage: receipt.images.server, schemaHead: manifest.schemaHead,
    savedRuns: counters.runs, originalProtectedTables: Object.keys(protection.tables).length,
    existingStrategyResults: protection.runs.length, targetPreserved: true }));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, targetFlag, selected, runtimeFlag, runtimeDirectory, consumerFlag, consumerDirectory, outputFlag, output] = process.argv.slice(2);
  assert.equal(mode, 'seal'); assert.equal(targetFlag, '--target'); assert.equal(selected, target);
  assert.equal(runtimeFlag, '--runtime'); assert.equal(consumerFlag, '--consumers'); assert.equal(outputFlag, '--output');
  await sealBaseline(runtimeDirectory, consumerDirectory, output);
}
