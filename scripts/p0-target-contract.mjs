import assert from 'node:assert/strict';

export const project = 'thesis-ledger-dev';
export const fixtureDatabase = 'portfolio_valuation_fixture';
export const fixtureOwner = 'fixture_owner';
export function browserTransportStatus(trace) {
  const saves = trace.filter((row) => row.method === 'POST' && row.path === '/api/v1/performance/targets');
  return {
    controlledFailures: saves.filter((row) => row.status === 503 && row.controlledFailure === true).length,
    successfulSaves: saves.filter((row) => row.status === 201).length,
  };
}
export function readAutomationArchive(result) {
  assert.equal(result.status, 0, '只读备份解析失败');
  assert(!result.error || result.error.code === 'EPIPE', '备份传输发生非预期错误');
  assert.equal(result.stderr.trim(), '', '备份解析返回诊断，保留失败');
  assert(result.stdout.includes('COPY public."AutomationJob" (') && result.stdout.includes('\n\\.\n'), '任务 COPY 数据不完整');
  return result.stdout;
}
export function assertTarget(info, service) {
  assert.equal(info.Config.Labels['com.docker.compose.project'], project);
  assert.equal(info.Config.Labels['com.docker.compose.service'], service);
  assert.equal(info.State.Running, true);
  assert.match(info.Id, /^[a-f0-9]{64}$/);
}
export function compareProtected(before, after) {
  assert.equal(before.database, 'thesis_ledger');
  assert.equal(after.database, before.database);
  const additions = {};
  for (const [name, original] of Object.entries(before.tables)) {
    const current = after.tables[name];
    assert(current, `原业务表缺失：${name}`);
    const remaining = new Map();
    for (const value of current.hashes) remaining.set(value, (remaining.get(value) ?? 0) + 1);
    for (const value of original.hashes) {
      assert((remaining.get(value) ?? 0) > 0, `原业务行发生变化或丢失：${name}`);
      remaining.set(value, remaining.get(value) - 1);
    }
    if (current.count > original.count) additions[name] = current.count - original.count;
  }
  assert.deepEqual(after.snapshots, before.snapshots, '原回测快照内容或路径发生变化');
  assert.equal(after.aiActive, 0);
  assert.equal(after.workerActive, 0);
  return { protectedTables: Object.keys(before.tables).length,
    protectedRows: Object.values(before.tables).reduce((total, value) => total + value.count, 0),
    protectedSnapshotFiles: before.snapshots.length, additions };
}
export function assertBridgeRequest(url, method) {
  assert(['GET', 'POST'].includes(method), '只允许验收 GET/POST');
  assert.equal(url.origin, 'http://p0.local');
  assert(url.pathname.startsWith('/api/v1/performance/'), '只允许独立收益验收资源');
  assert(!url.username && !url.password && !url.hash);
}
