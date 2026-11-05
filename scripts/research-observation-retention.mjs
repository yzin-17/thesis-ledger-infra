import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backup, checkOutputDirectory, checksum, digest, docker, inspect, sql } from './research-state-backup.mjs';
import { assertOwned, loadReceipt, openReadBridge, verifyBaseline } from './research-dual-read-runtime.mjs';
import { ownedSql, runDualRead, sourceState } from './research-dual-read.mjs';
import { observationSeedProgram } from './research-observation-retention-probe.mjs';
import { assertUpgradeInput, cleanupObservationResources, compatibleServerArgs, retentionArguments, retentionSql, retentionStructureSql }
  from './research-observation-retention-guards.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..'), main = resolve(infra, '../thesis-ledger');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function verifyObservationReads(baseUrl, sample) {
  const { ThesisLedgerApiClient } = await import(pathToFileURL(resolve(main, 'packages/api-client/dist/index.js')));
  assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
  let requests = 0;
  const client = new ThesisLedgerApiClient(baseUrl + '/', async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET'); requests += 1;
    return fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
  });
  const locator = { view: 'scoped', mode: 'shadow' };
  const capabilities = await client.research.capabilities(); assert.equal(capabilities.canCreate, false);
  const report = await client.research.detail(sample.runId, locator);
  assert.equal(report.availability, 'available'); assert.equal(report.result.version, 2);
  const old = await client.research.observations(sample.runId, { ...locator, asOf: sample.firstCutoff });
  assert.equal(old.items[0].current.id, sample.firstVersionId);
  const current = await client.research.observations(sample.runId, { ...locator, asOf: sample.currentCutoff });
  assert.equal(current.items[0].current.id, sample.currentVersionId);
  const history = await client.research.observationHistory(sample.runId, sample.observationId, locator);
  assert.equal(history.versions.length, 3);
  assert(history.versions.every(version => version.evaluation.status === 'insufficient_data'));
  return { requests, originalReportAvailable: true, oldVersionAvailable: true,
    currentProjectionPreserved: true, historicalVersions: history.versions.length, creationDisabled: true };
}

export async function observationRetention({ upgrade, compatible, output }) {
  checkOutputDirectory(output);
  const before = sourceState();
  const compatibleManifest = compatible === 'current'
    ? { images: { server: before.containers['thesis-ledger'].Image }, schemaHead: before.state.protection.head }
    : await verifyBaseline(compatible);
  assert.equal(compatibleManifest.schemaHead, before.state.protection.head);
  if (compatible !== 'current')
    same(compatibleManifest.originalProtection.tables, before.state.protection.tables, '兼容基线与目标保护数据不一致');
  docker(['image', 'inspect', compatibleManifest.images.server]);
  const imageInput = JSON.parse(docker(['exec', before.containers['thesis-ledger'].Id,
    'node', 'apps/server/dist/src/platform/database-upgrade-export.js']));
  const inputPath = resolve(upgrade, 'image-input.json');
  assertUpgradeInput(imageInput, JSON.parse(readFileSync(inputPath)), main);
  const fileHashes = JSON.parse(docker(['exec', before.containers['thesis-ledger'].Id, 'node', '-e',
    "const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(['schema.prisma','raw-owned-tables.json'].map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/prisma/'+n)).digest('hex')]))))"]));
  for (const [name, hash] of Object.entries(fileHashes))
    assert.equal(digest(readFileSync(resolve(main, 'apps/server/prisma', name))), hash, '现行结构输入与镜像不一致');
  const rehearsal = JSON.parse(readFileSync(resolve(upgrade, 'rehearsal.json')));
  assert.equal(rehearsal.target.databaseName, 'thesis_ledger');
  assert(rehearsal.checks.structureComplete && rehearsal.checks.appRolePermissions && rehearsal.checks.preservedData);
  assert.equal(readFileSync(resolve(upgrade, 'execute.log'), 'utf8').trim(), '事务执行成功。');
  assert.equal(imageInput.currentHead, before.state.protection.head);
  const structure = sql(before.containers.postgres.Id, retentionStructureSql(imageInput.expectedTables));
  same(structure, { missing: [], unreadable: [], observationInsert: true });
  const original = sql(before.containers.postgres.Id, retentionSql);
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), value, { mode: 0o600, flag: 'wx' });
  save('target-before.json', JSON.stringify({ state: before.state, retained: original }));
  const bundle = resolve(output, 'bundle'); await backup(bundle);
  const runtimeDirectory = resolve(output, 'runtime');
  let receipt, bridge, report;
  try {
    await runDualRead({ bundle, output: runtimeDirectory, retain: true });
    receipt = loadReceipt(runtimeDirectory);
    save('candidate-runtime.json', readFileSync(resolve(runtimeDirectory, 'runtime.json')));
    const fixtures = JSON.parse(readFileSync(resolve(runtimeDirectory, 'fixtures.json')));
    const copyBefore = sql(receipt.containers.postgres, retentionSql, 'restore_db');
    const program = observationSeedProgram(fixtures);
    assertOwned(inspect(receipt.containers.server), receipt.token, 'server');
    const sample = JSON.parse(docker(['exec', '-i', receipt.containers.server, 'node'], { input: program }));
    save('sample.json', JSON.stringify(sample));
    const saved = sql(receipt.containers.postgres, retentionSql, 'restore_db');
    for (const name of ['AiRun', 'AiToolCall', 'JournalEntry', 'JournalReviewSnapshot', 'ProviderConfig', 'AiRoutingSettings',
      'AiInvocation', 'AiInvocationFact']) same(saved.tables[name], copyBefore.tables[name], `受控观察改变原副本 ${name}`);
    bridge = await openReadBridge(receipt.containers.server);
    const candidate = await verifyObservationReads(bridge.baseUrl, sample);
    await bridge.close(); bridge = null;
    same(sql(receipt.containers.postgres, retentionSql, 'restore_db'), saved, '候选读取改变副本');
    const snapshot = resolve(output, 'observations.dump');
    save('observations.dump', docker(['exec', receipt.containers.postgres, 'pg_dump', '-U', 'restore_owner',
      '-d', 'restore_db', '--format=custom', '--no-owner', '--no-acl']));
    const imageArchive = resolve(output, 'compatible-image.tar');
    console.log('阶段：归档兼容镜像并实际加载归档，保留可恢复的数据库/镜像组合');
    docker(['image', 'save', '-o', imageArchive, compatibleManifest.images.server]); chmodSync(imageArchive, 0o600);
    const imageArchiveSha256 = await checksum(imageArchive);
    docker(['image', 'load', '--input', imageArchive]);
    assert.equal(JSON.parse(docker(['image', 'inspect', compatibleManifest.images.server]))[0].Id, compatibleManifest.images.server);
    const point = { format: 'research-observation-compatible-point-v1', image: compatibleManifest.images.server,
      schemaHead: compatibleManifest.schemaHead, imageArchiveSha256, candidate,
      dualReadReportSha256: await checksum(resolve(runtimeDirectory, 'report.json')),
      source: compatible === 'current' ? 'current-verified-image' : 'registered-dual-read-baseline' };
    save('compatible-point.json', JSON.stringify(point, null, 2));
    const oldServer = inspect(receipt.containers.server);
    const rollbackArgs = compatibleServerArgs(oldServer, compatibleManifest.images.server,
      receipt.containers.postgres, receipt.token);
    docker(['rm', '-f', receipt.containers.server]);
    assertOwned(inspect(receipt.containers.postgres), receipt.token, 'postgres');
    console.log('阶段：仅在自有隔离库恢复含三版观察的封存副本');
    docker(['exec', '-i', receipt.containers.postgres, 'pg_restore', '--clean', '--if-exists', '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl', '-U', 'restore_owner', '-d', 'restore_db'],
    { input: readFileSync(snapshot) });
    ownedSql(receipt.containers.postgres, receipt.token, 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO research_reader;');
    same(sql(receipt.containers.postgres, retentionSql, 'restore_db'), saved, '非空观察实际恢复后摘要不同');
    receipt.containers.server = docker(rollbackArgs).toString().trim();
    receipt.images.server = compatibleManifest.images.server;
    writeFileSync(resolve(runtimeDirectory, 'runtime.json'), JSON.stringify(receipt), { mode: 0o600 });
    loadReceipt(runtimeDirectory);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = spawnSync('docker', ['exec', receipt.containers.server, 'node', '-e',
        "fetch('http://127.0.0.1:3000/api/v1/research/capabilities').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
      if (probe.status === 0) { ready = true; break; }
      if (!inspect(receipt.containers.server).State.Running) break;
      await sleep(500);
    }
    assert(ready, '登记兼容镜像未能启动');
    bridge = await openReadBridge(receipt.containers.server);
    const rollback = await verifyObservationReads(bridge.baseUrl, sample);
    const { verifyDualReadSdk } = await import(pathToFileURL(resolve(main, 'scripts/research-dual-read-sdk.mjs')));
    const originalReports = await verifyDualReadSdk(bridge.baseUrl, fixtures);
    same(sql(receipt.containers.postgres, retentionSql, 'restore_db'), saved, '兼容镜像读取改变观察或原报告');
    same(sourceState().state, before.state, '验收改变目标状态');
    same(sql(before.containers.postgres.Id, retentionSql), original, '验收改变目标研究/配置数据');
    report = { format: 'research-observation-retention-v1', passed: true, createdAt: new Date().toISOString(),
      schemaHead: imageInput.currentHead, migrationCount: imageInput.migrations.length,
      expectedTables: imageInput.expectedTables.length, structure, candidate, rollback, originalReports,
      candidateImage: before.containers['thesis-ledger'].Image, compatibleImage: compatibleManifest.images.server,
      compatibleBaselineKind: point.source, imageArchiveSha256, fileHashes,
      upgradeReceiptSha256: await checksum(inputPath), compatibleBaselineSha256: await checksum(resolve(output, 'compatible-point.json')),
      ...(compatible === 'current' ? {} : { priorBaselineSha256: await checksum(resolve(compatible, 'manifest.json')) }),
      observationDumpSha256: await checksum(snapshot), inputSha256: digest(Buffer.from(program +
        ['research-observation-retention.mjs', 'research-observation-retention-guards.mjs',
          'research-observation-retention-probe.mjs', 'research-dual-read-runtime.mjs']
          .map(name => readFileSync(resolve(infra, 'scripts', name), 'utf8')).join('\n'))), inputs: receipt.inputs,
      targetCounts: Object.fromEntries(Object.entries(original.tables).map(([name, value]) => [name, value.count])),
      restoredCounts: Object.fromEntries(Object.entries(saved.tables).map(([name, value]) => [name, value.count])),
      targetPreserved: true, targetV2WritesEnabled: false, modelInvocationsAdded: 0, externalNetwork: false,
      boundary: '正式目标升级证据、目标只读核对与非空隔离副本恢复；不代表实源价格资格或 G4b 用户路径。' };
  } finally {
    if (bridge) await bridge.close();
    if (receipt) cleanupObservationResources(receipt, docker);
    same(sourceState().state, before.state, '退出后目标状态不同');
    same(sql(before.containers.postgres.Id, retentionSql), original, '退出后目标保留数据不同');
  }
  report.isolatedResourcesCleaned = true;
  save('report.json', JSON.stringify(report, null, 2)); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await observationRetention(retentionArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report));
}
