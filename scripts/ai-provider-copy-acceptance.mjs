import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, checksum, digest, protectionSql, sql, target } from './research-state-backup.mjs';
import { loadReceipt, verifyBaseline } from './research-dual-read-runtime.mjs';
import { cleanupDualRead, counterSql, runDualRead, sourceState } from './research-dual-read.mjs';

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../thesis-ledger/scripts/ai-provider-copy-acceptance.mjs');
export function providerCopyArguments(args) {
  assert.equal(args.length, 6);
  const [flag, selected, baselineFlag, baseline, outputFlag, output] = args;
  assert.equal(flag, '--target'); assert.equal(selected, target);
  assert.equal(baselineFlag, '--baseline'); assert.equal(outputFlag, '--output');
  assert(baseline && output); return { baseline, output };
}

export function providerCopyBootstrap(source) {
  assert.equal(typeof source, 'string'); assert(source.length > 0);
  return `import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
const root=mkdtempSync('/tmp/provider-copy-');
try {
 const file=join(root,'acceptance.mjs'); writeFileSync(file,${JSON.stringify(source)},{mode:0o600});
 const {verifyProviderCopy}=await import(pathToFileURL(file));
 console.log(JSON.stringify({event:'provider-copy-complete',report:await verifyProviderCopy()}));
} catch(error) {
 console.log(JSON.stringify({event:'provider-copy-failed',message:error.message})); process.exitCode=1;
} finally {rmSync(root,{recursive:true,force:true});}`;
}

export async function providerCopyAcceptance({ baseline, output }) {
  checkOutputDirectory(output);
  const manifest = await verifyBaseline(baseline), before = sourceState().state;
  const bootstrap = providerCopyBootstrap(readFileSync(sourcePath, 'utf8'));
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), value, { mode: 0o600, flag: 'wx' });
  const runtime = resolve(output, 'runtime'); let receipt;
  try {
    await runDualRead({ baseline, output: runtime, retain: true });
    receipt = loadReceipt(runtime);
    assert.deepEqual(receipt.images, manifest.images);
    console.log('阶段：同一镜像保留副本的实际 AI 配置 HTTP 生命周期及重启');
    const probe = spawnSync('docker', ['exec', '-i',
      '-e', 'AI_PROVIDER_COPY_DATABASE_URL=postgresql://restore_owner@127.0.0.1:5432/restore_db',
      '-e', `AI_PROVIDER_COPY_TEST_TOKEN=${receipt.token}`,
      receipt.containers.server, 'node', '--input-type=module'],
    { input: bootstrap, timeout: 120000, maxBuffer: 1024 * 1024 });
    const logs = Buffer.concat([probe.stdout ?? Buffer.alloc(0), probe.stderr ?? Buffer.alloc(0)]);
    save('probe.log', logs);
    const events = logs.toString().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(probe.status, 0, events.find(row => row.event === 'provider-copy-failed')?.message ?? '副本验收失败，见私有回执');
    const result = events.find(row => row.event === 'provider-copy-complete')?.report;
    assert(result?.passed && result.realModelRequests === 0 && result.upstreamRequests === 0);
    assert.deepEqual(sql(receipt.containers.postgres, protectionSql, 'restore_db'), manifest.protection);
    assert.deepEqual(sql(receipt.containers.postgres, counterSql, 'restore_db'), manifest.counters);
    assert.deepEqual(sourceState().state, before, '副本验收改变目标状态');
    const report = { ...result, images: receipt.images, baselineSha256: await checksum(resolve(baseline, 'manifest.json')),
      inputSha256: digest(Buffer.from(bootstrap + readFileSync(fileURLToPath(import.meta.url), 'utf8'))),
      createdAt: new Date().toISOString(), targetPreserved: true, externalNetwork: false,
      originalProtectedTables: 7, originalSuccessfulBacktests: manifest.protection.runs.length };
    save('report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return report;
  } finally {
    if (receipt) cleanupDualRead(runtime);
    assert.deepEqual(sourceState().state, before, '退出核对发现目标状态变化');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await providerCopyAcceptance(providerCopyArguments(process.argv.slice(2)));
