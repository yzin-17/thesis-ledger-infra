import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, docker, protectionSql, sql, target, digest } from './research-state-backup.mjs';
import { controlledAccountId, loadReceipt, fixtureSql, openReadBridge } from './research-dual-read-runtime.mjs';
import { counterSql, ownedSql, sourceState } from './research-dual-read.mjs';
import { auditDualReadInputs } from './research-dual-read-inputs.mjs';

const main = resolve(dirname(fileURLToPath(import.meta.url)), '../../thesis-ledger');
const same = (a, b, message) => assert(digest(Buffer.from(JSON.stringify(a))) === digest(Buffer.from(JSON.stringify(b))), message);

export async function runConsumerReads(runtimeDirectory, output, reuse = false) {
  checkOutputDirectory(output);
  const receipt = loadReceipt(runtimeDirectory);
  same(sourceState().state, receipt.before, '目标状态已偏离双读基线');
  const pg = receipt.containers.postgres;
  const originalProtectionSql = protectionSql.replace('FROM "Account" t',
    `FROM (SELECT * FROM "Account" WHERE id<>'${controlledAccountId}'::uuid) t`);
  assert.notEqual(originalProtectionSql, protectionSql);
  const expectedCounters = { ...receipt.seeded };
  if (reuse) { expectedCounters.runs += 4; expectedCounters.tools += 4; }
  same(sql(pg, counterSql, 'restore_db'), expectedCounters, '副本已偏离登记的样本数量');
  same(sql(pg, originalProtectionSql, 'restore_db'), receipt.copyBefore, '副本原有保护状态已变化');
  const { reviewEvidenceFixture } = await import(pathToFileURL(resolve(main, 'apps/server/test/journal/review-evidence.fixture.ts')));
  const { verifyConsumerReads } = await import(pathToFileURL(resolve(main, 'scripts/research-dual-read-consumers.mjs')));
  const { verifyDualReadSdk } = await import(pathToFileURL(resolve(main, 'scripts/research-dual-read-sdk.mjs')));
  const selected = JSON.parse(ownedSql(pg, receipt.token, `SELECT json_build_object(
    'controlledAccountExists',EXISTS(SELECT 1 FROM "Account" WHERE id='${controlledAccountId}'),
    'activeActualAccounts',(SELECT count(*) FROM "Account" WHERE mode='actual' AND active AND id<>'${controlledAccountId}'),
    'runs',(SELECT coalesce(json_agg(json_build_object('id',id,'result',result) ORDER BY id),'[]'::json)
      FROM "BacktestJob" WHERE status='succeeded' AND result->>'schemaVersion'='3'));`));
  assert.equal(selected.controlledAccountExists, reuse);
  assert.equal(selected.runs.length, receipt.copyBefore.runs.length);
  const reports = JSON.parse(readFileSync(resolve(runtimeDirectory, 'fixtures.json')));
  const factory = readFileSync(resolve(main, 'scripts/research-dual-read-consumer-fixtures.mjs'), 'utf8');
  const program = factory + `\nimport {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const runtime={...require('@thesis-ledger/schemas'),...require('@thesis-ledger/domain'),
...require('/app/apps/server/dist/src/ai/ai-frozen-research.js'),
...require('/app/apps/server/dist/src/journal/journal-review-candidate.js'),
...require('/app/apps/server/dist/src/journal/journal-review-evidence.js'),
...require('/app/apps/server/dist/src/journal/journal-review-analysis.js'),
...require('/app/apps/server/dist/src/journal/journal-review-prompt.js')};
console.log(JSON.stringify(buildConsumerFixtures(${JSON.stringify(reviewEvidenceFixture())},runtime,
${JSON.stringify(controlledAccountId)},${JSON.stringify(reports.cases.legacy.result)},${JSON.stringify(reports.cases.actual.result)})));`;
  const fixtures = JSON.parse(docker(['exec', '-i', receipt.containers.server, 'node', '--input-type=module'], { input: program }));
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  save('fixtures.json', fixtures);
  const inputs = auditDualReadInputs(receipt.containers.server, main);
  if (!reuse) ownedSql(pg, receipt.token, fixtureSql(fixtures));
  else {
    const saved = JSON.parse(ownedSql(pg, receipt.token, `SELECT json_build_object(
      'runs',(SELECT json_agg(to_jsonb(r)) FROM "AiRun" r WHERE "modelMetadata"->>'acceptanceFixture'='controlled-saved-journal-v1'),
      'calls',(SELECT json_agg(to_jsonb(c)) FROM "AiToolCall" c WHERE "aiRunId" IN
        (SELECT id FROM "AiRun" WHERE "modelMetadata"->>'acceptanceFixture'='controlled-saved-journal-v1')),
      'account',(SELECT to_jsonb(a) FROM "Account" a WHERE id='${controlledAccountId}'));`));
    for (const kind of ['runs', 'calls']) for (const expected of fixtures[kind]) {
      const actual = saved[kind].find(row => row.id === expected.id);
      assert(actual, '缺少已保存的受控产物');
      for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key]);
    }
    for (const key of ['id', 'name', 'type', 'mode', 'currency', 'active'])
      assert.equal(saved.account[key], fixtures.account[key]);
  }
  same(sql(pg, originalProtectionSql, 'restore_db'), receipt.copyBefore, '样本创建改变了原有保护数据');
  const seeded = sql(pg, counterSql, 'restore_db');
  assert.equal(seeded.runs, receipt.seeded.runs + 4);
  assert.equal(seeded.tools, receipt.seeded.tools + 4);
  assert.equal(seeded.invocations, receipt.seeded.invocations);
  const before = sql(pg, protectionSql, 'restore_db');
  let bridge;
  try {
    bridge = await openReadBridge(receipt.containers.server);
    const dualRead = await verifyDualReadSdk(bridge.baseUrl, reports);
    const consumers = await verifyConsumerReads(bridge.baseUrl, fixtures, selected.runs);
    same(sql(pg, counterSql, 'restore_db'), seeded, '读取改变副本任务/审计数量');
    same(sql(pg, protectionSql, 'restore_db'), before, '读取改变既有副本业务数据');
    same(sourceState().state, receipt.before, '读取改变目标状态');
    const report = { format: 'research-dual-read-consumers-v1', passed: true,
      createdAt: new Date().toISOString(), serverImage: receipt.images.server,
      inputs, consumerFixtureSha256: digest(Buffer.from(factory + JSON.stringify(reviewEvidenceFixture()))),
      consumerInputsSha256: digest(Buffer.concat([
        Buffer.from(factory), readFileSync(resolve(main, 'scripts/research-dual-read-consumers.mjs')),
        readFileSync(fileURLToPath(import.meta.url)),
        readFileSync(resolve(main, 'apps/server/test/journal/review-evidence.fixture.ts')),
      ])),
      dualRead, consumers, targetPreserved: true, copyReadOnly: true, modelInvocationsAdded: 0,
      targetHistoricalAiRuns: receipt.before.counters.runs,
      existingActiveActualAccounts: selected.activeActualAccounts, controlledAccountsAddedToCopy: 1,
      originalProtectedDataUnchanged: true,
      boundary: 'Journal 保存样本为受控材料；策略结果来自正式备份的既有记录，不执行回测或模型。' };
    save('report.json', report); console.log(JSON.stringify(report)); return report;
  } finally {
    if (bridge) await bridge.close();
    same(sourceState().state, receipt.before, '退出核对发现目标状态变化');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [targetFlag, selectedTarget, runtimeFlag, runtimeDirectory, outputFlag, output, reuseFlag] = process.argv.slice(2);
  assert.equal(targetFlag, '--target'); assert.equal(selectedTarget, target);
  assert.equal(runtimeFlag, '--runtime'); assert.equal(outputFlag, '--output');
  assert(reuseFlag === undefined || reuseFlag === '--reuse');
  await runConsumerReads(runtimeDirectory, output, reuseFlag === '--reuse');
}
