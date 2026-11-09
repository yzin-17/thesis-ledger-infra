// 显式开发维护入口：冻结决策的历史成交重建，不调用模型，不更新原比赛。
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const { values: v } = parseArgs({ options: Object.fromEntries([
  'mode', 'container', 'receipt', 'reserved', 'opening', 'bundle', 'receipt-sha', 'plan-sha',
].map(key => [key, { type: 'string' }])) });
assert(['check', 'rehearse', 'apply', 'repair-report'].includes(v.mode));
assert(v.container?.includes('-dev-'), '仅允许明确的开发容器');
const read = path => { const bytes = readFileSync(path); return {
  data: JSON.parse(bytes), sha: createHash('sha256').update(bytes).digest('hex'),
}; };
const receipt = read(v.receipt), reserved = read(v.reserved), opening = read(v.opening), bundle = read(v.bundle);
assert.equal(receipt.sha, v['receipt-sha'], '原模型回执摘要不符');
const qualification = spawnSync('python3', ['-m', 'src.services.arena_historical_opening_evidence',
  '--bundle', resolve(v.bundle), '--verify', resolve(v.opening)],
{ cwd: fileURLToPath(new URL('../../daily-stock-analysis/', import.meta.url)), encoding: 'utf8', timeout: 10000 });
assert.equal(qualification.status, 0, '必须先从全部原件重新核验冻结开盘证据：' + qualification.stderr.slice(-400));
for (const [key, file] of Object.entries(bundle.data.files))
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), opening.data.sourceHashes[key], '来源文件摘要不符：' + key);
const payload = { receipt: receipt.data, reserved: reserved.data, opening: opening.data,
  hashes: { receipt: receipt.sha, reserved: reserved.sha, opening: opening.sha, bundle: bundle.sha },
  historicalQuote: read(bundle.data.files.opening).data.quote,
};
const program = ['./model-arena-replay-time.mjs', './model-arena-historical-fill-runtime.mjs']
  .map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const result = spawnSync('docker', ['exec', '-i', '-w', '/app/apps/server', v.container,
  'node', '--input-type=module', '-', v.mode, JSON.stringify(payload), v['plan-sha'] ?? ''],
{ input: program, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
if (result.status !== 0) throw new Error('历史成交维护未完成：' + result.stderr.slice(-1600));
console.log(result.stdout.trim());
