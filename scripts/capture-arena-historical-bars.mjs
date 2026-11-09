// 只读冻结一个已配置来源的历史日线响应；不创建比赛或调用模型。
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { values: v } = parseArgs({ options: {
  container: { type: 'string' }, symbol: { type: 'string' }, day: { type: 'string' },
  output: { type: 'string' },
} });
assert(v.container && v.output && /^\d{6}\.SH$/.test(v.symbol ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(v.day ?? ''),
  '必须明确容器、完整沪市代码、历史日期及输出文件');
assert(!existsSync(v.output), '输出回执已存在，禁止重复来源请求');
const code = `
import { DsaClient } from './dist/src/integration/dsa/dsa.client.js';
const [symbol, day] = process.argv.slice(2);
const dsa = new DsaClient();
const policy = (await dsa.effectiveControlPolicyV3()).projection?.effective;
const routeKey = {kind:'bar',market:'CN',assetType:'STOCK',capability:'DAILY_BAR',timeframe:'1d',adjustment:'none'};
const route = policy?.routes.find(r => JSON.stringify(r.key) === JSON.stringify(routeKey));
const target = route?.targets.find(t => t.eligible && t.providerId === 'hithink');
if (!policy?.enabled || !target) throw new Error('现行不复权日线主源未启用，停止');
const routeTarget = {providerId:target.providerId,upstreamSource:target.upstreamSource,routeIndex:target.routeIndex};
const request = {contractVersion:3,requestId:crypto.randomUUID(),symbol,routeKey,routeTarget,tradabilityMode:'assume-untradable-no-bar',start:day,end:day};
const response = await dsa.dataCapabilities.bars(request);
console.log(JSON.stringify({request,response,capturedAt:new Date().toISOString(),sourceFeeStatus:'unverified',modelCalls:0}));
`;
const result = spawnSync('docker', ['exec', '-i', '-w', '/app/apps/server', v.container,
  'node', '--input-type=module', '-', v.symbol, v.day],
{ input: code, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
assert.equal(result.status, 0, '历史日线读取失败；保留错误并停止，不自动重发：' + result.stderr.slice(-400));
const receipt = JSON.parse(result.stdout);
assert.equal(receipt.response.symbol, v.symbol);
assert.equal(receipt.response.bars.length, 1, '需要真实且唯一的完整日线');
assert.equal(receipt.response.bars[0].completionStatus, 'complete');
writeFileSync(v.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: v.output, requestId: receipt.request.requestId,
  fingerprint: receipt.response.inputFingerprint, modelCalls: 0, sourceFeeStatus: 'unverified' }));
