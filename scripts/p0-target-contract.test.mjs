import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTarget, compareProtected, assertBridgeRequest, readAutomationArchive, browserTransportStatus } from './p0-target-contract.mjs';

const info = () => ({ Id: 'a'.repeat(64), State: { Running: true },
  Config: { Labels: { 'com.docker.compose.project': 'thesis-ledger-dev', 'com.docker.compose.service': 'thesis-ledger' } } });
const baseline = () => ({ database: 'thesis_ledger', tables: { Account: { count: 2, hashes: ['a', 'a'] } },
  snapshots: [['run/manifest.json', 'original']], aiActive: 0, workerActive: 0 });
test('只接受明确项目、服务及完整运行容器身份', () => {
  assertTarget(info(), 'thesis-ledger');
  const wrong = info(); wrong.Config.Labels['com.docker.compose.project'] = 'other';
  assert.throws(() => assertTarget(wrong, 'thesis-ledger'));
  assert.throws(() => assertTarget(info(), 'backtest-worker'));
  const stopped = info(); stopped.State.Running = false;
  assert.throws(() => assertTarget(stopped, 'thesis-ledger'));
});
test('逐原业务行核对，重复行不能掩盖丢失，合法追加单独列明', () => {
  assert.equal(compareProtected(baseline(), baseline()).protectedRows, 2);
  const missing = baseline(); missing.tables.Account = { count: 2, hashes: ['a', 'b'] };
  assert.throws(() => compareProtected(baseline(), missing));
  const appended = baseline(); appended.tables.Account = { count: 3, hashes: ['a', 'a', 'c'] };
  assert.deepEqual(compareProtected(baseline(), appended).additions, { Account: 1 });
});
test('原快照修改、错误数据库及活动任务均拒绝验收', () => {
  for (const field of ['aiActive', 'workerActive']) {
    const changed = baseline(); changed[field] = 1;
    assert.throws(() => compareProtected(baseline(), changed));
  }
  const changed = baseline(); changed.snapshots[0][1] = 'modified';
  assert.throws(() => compareProtected(baseline(), changed));
  changed.database = 'other'; assert.throws(() => compareProtected(baseline(), changed));
});
test('宿主转发只允许独立收益路径及有限方法', () => {
  assertBridgeRequest(new URL('http://p0.local/api/v1/performance/summary'), 'GET');
  for (const path of ['/api/v1/ai/generate', '/api/v1/performance/../ledger', '//outside.test/'])
    assert.throws(() => assertBridgeRequest(new URL(path, 'http://p0.local'), 'GET'));
  assert.throws(() => assertBridgeRequest(new URL('http://p0.local/api/v1/performance/targets'), 'DELETE'));
});
test('选表归档的 EPIPE 仅在成功退出且 COPY 完整时接受', () => {
  const result = { status: 0, error: { code: 'EPIPE' }, stderr: '', stdout: 'COPY public."AutomationJob" (id) FROM stdin;\na\n\\.\n' };
  assert.equal(readAutomationArchive(result), result.stdout);
  assert.throws(() => readAutomationArchive({ ...result, status: 1 }));
  assert.throws(() => readAutomationArchive({ ...result, error: { code: 'ETIMEDOUT' } }));
  assert.throws(() => readAutomationArchive({ ...result, stdout: 'truncated' }));
  assert.throws(() => readAutomationArchive({ ...result, stderr: 'restore warning' }));
});
test('浏览器门禁只统计目标保存接口的受控失败与成功重试', () => {
  const unrelated = [
    { method: 'POST', path: '/api/v1/performance/allocation', status: 201 },
    { method: 'POST', path: '/api/v1/performance/allocation', status: 503, controlledFailure: true },
    { method: 'GET', path: '/api/v1/performance/targets', status: 201 },
  ];
  assert.deepEqual(browserTransportStatus(unrelated), { controlledFailures: 0, successfulSaves: 0 });
  assert.deepEqual(browserTransportStatus([...unrelated,
    { method: 'POST', path: '/api/v1/performance/targets', status: 503, controlledFailure: true },
    { method: 'POST', path: '/api/v1/performance/targets', status: 201 },
  ]), { controlledFailures: 1, successfulSaves: 1 });
});
