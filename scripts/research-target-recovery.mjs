import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, checksum, digest, protectionSql, sql, target } from './research-state-backup.mjs';
import { loadReceipt, openReadBridge, verifyBaseline } from './research-dual-read-runtime.mjs';
import { cleanupDualRead, counterSql, runDualRead, sourceState } from './research-dual-read.mjs';

const main = resolve(dirname(fileURLToPath(import.meta.url)), '../../thesis-ledger');
const sourceNames = ['research-recovery-guards.mjs', 'research-recovery-runtime.mjs',
  'research-recovery-worker.mjs', 'research-recovery-processes.mjs', 'research-recovery-cases.mjs', 'research-recovery-driver.mjs'];
const same = (a, b, message) => assert.equal(digest(Buffer.from(JSON.stringify(a))), digest(Buffer.from(JSON.stringify(b))), message);

export function recoveryArguments(args) {
  assert.equal(args.length, 6);
  const [targetFlag, selected, baselineFlag, baseline, outputFlag, output] = args;
  assert.equal(targetFlag, '--target'); assert.equal(selected, target);
  assert.equal(baselineFlag, '--baseline'); assert.equal(outputFlag, '--output');
  assert(baseline && output); return { baseline, output };
}

export function recoveryBootstrap(sources, sample) {
  assert.deepEqual(Object.keys(sources).sort(), [...sourceNames].sort());
  assert(Object.values(sources).every(value => typeof value === 'string' && value.length > 0));
  return `import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
const root=mkdtempSync('/tmp/research-recovery-');
try {
  for(const [name,source] of Object.entries(${JSON.stringify(sources)})) writeFileSync(join(root,name),source,{mode:0o600});
  const {runRecovery}=await import(pathToFileURL(join(root,'research-recovery-driver.mjs')));
  const report=await runRecovery(${JSON.stringify(sample)},join(root,'research-recovery-worker.mjs'));
  console.log(JSON.stringify({event:'recovery-complete',report}));
} catch(error) {
  console.log(JSON.stringify({event:'recovery-failed',message:error.message})); process.exitCode=1;
} finally { rmSync(root,{recursive:true,force:true}); }`;
}

export async function researchTargetRecovery({ baseline, output }) {
  checkOutputDirectory(output);
  const manifest = await verifyBaseline(baseline), before = sourceState().state;
  const { verifyRecoveryReads } = await import(pathToFileURL(resolve(main, 'scripts/research-recovery-sdk.mjs')));
  const sources = Object.fromEntries(sourceNames.map(name => [name, readFileSync(resolve(main, 'scripts', name), 'utf8')]));
  const sample = JSON.parse(readFileSync(resolve(main, 'packages/schemas/fixtures/research-v2.samples.json')));
  const bootstrap = recoveryBootstrap(sources, sample);
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), value, { mode: 0o600, flag: 'wx' });
  const runtimeDirectory = resolve(output, 'runtime');
  let receipt, bridge;
  try {
    await runDualRead({ baseline, output: runtimeDirectory, retain: true });
    receipt = loadReceipt(runtimeDirectory);
    same(receipt.images, manifest.images, '执行候选与登记双读基线镜像不一致');
    console.log('阶段：在同一镜像和保留副本中执行独立进程恢复、取消与结算矩阵');
    const probe = spawnSync('docker', ['exec', '-i',
      '-e', 'AI_EXECUTION_DATABASE_URL=postgresql://restore_owner@127.0.0.1:5432/restore_db',
      '-e', `RESEARCH_RECOVERY_TEST_TOKEN=${receipt.token}`,
      receipt.containers.server, 'node', '--input-type=module'],
    { input: bootstrap, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    const logs = Buffer.concat([probe.stdout ?? Buffer.alloc(0), probe.stderr ?? Buffer.alloc(0)]);
    save('probe.log', logs);
    const events = logs.toString().split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const failure = events.find(value => value.event === 'recovery-failed');
    assert.equal(probe.status, 0, failure?.message ?? '受控进程矩阵退出失败；详情保留于私有回执');
    const result = events.find(value => value.event === 'recovery-complete')?.report;
    assert(result?.passed && result.remainingChildren === 0 && result.realModelRequests === 0);
    save('probe.json', JSON.stringify(result, null, 2));
    same(sql(receipt.containers.postgres, protectionSql, 'restore_db'), manifest.protection, '执行改变副本原有业务保护状态');
    const counters = sql(receipt.containers.postgres, counterSql, 'restore_db');
    assert.equal(counters.runs, manifest.counters.runs + result.outcomes.length);
    assert.equal(counters.invocations, manifest.counters.invocations);
    assert.equal(counters.invocationFacts, manifest.counters.invocationFacts);
    bridge = await openReadBridge(receipt.containers.server);
    const sdk = await verifyRecoveryReads(bridge.baseUrl, result);
    same(sourceState().state, before, '受控执行改变目标状态');
    const report = { format: 'research-target-recovery-v1', passed: true, createdAt: new Date().toISOString(),
      images: receipt.images, schemaHead: manifest.schemaHead, baselineSha256: await checksum(resolve(baseline, 'manifest.json')),
      inputSha256: digest(Buffer.from(bootstrap + readFileSync(resolve(main, 'scripts/research-recovery-sdk.mjs'), 'utf8') + readFileSync(fileURLToPath(import.meta.url), 'utf8'))),
      cases: result.outcomes.map(({ id, ...value }) => value), sdk,
      processes: result.processExits.length, killedProcesses: result.processExits.filter(value => value.signal === 'SIGKILL').length,
      controlledRequests: result.controlledRequests, realModelRequests: 0, remainingChildren: 0,
      originalProtectedDataUnchanged: true, originalReportsUnchanged: result.originalReportsUnchanged,
      originalToolAuditUnchanged: result.originalToolAuditUnchanged, changedCopyTables: result.changedTables,
      settledRequests: result.settledRequestCount, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      syntheticSettlementAmount: result.syntheticSettlementAmount, syntheticSettlementCurrency: result.syntheticSettlementCurrency,
      targetPreserved: true, targetV2WritesEnabled: false, externalNetwork: false,
      boundary: '登记镜像与保留副本的独立执行进程、实际本地 SDK 传输和 PostgreSQL；合成费用不代表真实模型支出。' };
    save('report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return report;
  } finally {
    if (bridge) await bridge.close();
    if (receipt) cleanupDualRead(runtimeDirectory);
    same(sourceState().state, before, '退出核对发现目标状态变化');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await researchTargetRecovery(recoveryArguments(process.argv.slice(2)));
