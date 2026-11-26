import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existingPlan, resumePlan } from './resume-existing-development.mjs';

const services = ['postgres', 'redis', 'dsa', 'thesis-ledger', 'backtest-worker'];
const paths = ['/var/lib/postgresql/data', '/data', '/app/data', '/app/var/backtest', '/app/var/backtest'];
const names = ['postgres', 'redis', 'dsa', 'backtest', 'backtest'];
function fixtures() {
  return services.map((service, index) => ({ Name: `/thesis-ledger-dev-${service}-1`, Id: String(index + 1).repeat(64), Image: `sha256:${'a'.repeat(64)}`,
    Config: { Labels: { 'com.docker.compose.project': 'thesis-ledger-dev', 'com.docker.compose.service': service } },
    State: { Status: 'exited', Health: { Status: 'healthy' } },
    Mounts: [{ Type: 'volume', Name: `thesis-ledger-${names[index]}-data`, Destination: paths[index] }] }));
}
test('启动前拒绝缺失容器、错项目、错持久卷和不安全状态', () => {
  assert.throws(() => existingPlan(fixtures().slice(1)));
  for (const change of [x => { x.Config.Labels['com.docker.compose.project'] = 'other'; },
    x => { x.Mounts[0].Name = 'other'; }, x => { x.State.Status = 'restarting'; }]) {
    const rows = fixtures(); change(rows[4]); assert.throws(() => existingPlan(rows));
  }
});
function adapter(rows, fail = false) {
  const starts = [];
  const run = (action, ...ids) => {
    if (action === 'inspect') return JSON.stringify(rows.filter(x => ids.includes(x.Id)));
    assert.equal(action, 'start'); const row = rows.find(x => x.Id === ids[0]);
    starts.push(row.Config.Labels['com.docker.compose.service']); row.State.Status = 'running';
    if (fail) row.State.Health.Status = 'unhealthy';
    return row.Id;
  };
  return { starts, run };
}
test('按依赖阶段恢复原容器，不调用构建/创建/重建，重复执行零启动', async () => {
  const rows = fixtures(), a = adapter(rows), plan = existingPlan(rows);
  await resumePlan(plan, a.run, async () => { throw new Error('不应等待'); });
  assert.deepEqual(a.starts, services);
  a.starts.length = 0; await resumePlan(plan, a.run);
  assert.deepEqual(a.starts, []);
});
test('先恢复持久存储可核对队列，再完整恢复时只启动其余应用', async () => {
  const rows = fixtures(), a = adapter(rows), plan = existingPlan(rows);
  const first = await resumePlan(plan, a.run, undefined, { storageOnly: true });
  assert.equal(first.status, 'storage_healthy');
  assert.deepEqual(a.starts, ['postgres', 'redis']);
  assert(rows.slice(2).every(row => row.State.Status === 'exited'));

  const second = await resumePlan(plan, a.run);
  assert.equal(second.status, 'healthy');
  assert.deepEqual(a.starts, services);
});
test('依赖不健康时不启动应用，身份漂移时零启动', async () => {
  const rows = fixtures(), a = adapter(rows, true), plan = existingPlan(rows);
  await assert.rejects(resumePlan(plan, a.run));
  assert.deepEqual(a.starts, ['postgres', 'redis']);
  const next = fixtures(), b = adapter(next), original = existingPlan(next);
  next[0].Image = `sha256:${'b'.repeat(64)}`;
  await assert.rejects(resumePlan(original, b.run)); assert.deepEqual(b.starts, []);
});
test('挂载集合重排保持身份，挂载来源或集合变化仍然零启动', async () => {
  const rows = fixtures();
  rows[2].Mounts.push({ Type: 'volume', Name: '受控日志卷', Source: '/volumes/logs', Destination: '/app/logs' });
  const plan = existingPlan(rows); rows[2].Mounts.reverse();
  assert.deepEqual(existingPlan(rows), plan);
  const a = adapter(rows); await resumePlan(plan, a.run); assert.deepEqual(a.starts, services);
  for (const mutate of [r => { r[2].Mounts.find(m => m.Destination === '/app/logs').Source = '/volumes/other'; }, r => { r[2].Mounts = r[2].Mounts.filter(m => m.Destination !== '/app/logs'); }]) {
    const changed = structuredClone(rows), before = existingPlan(changed), b = adapter(changed);
    mutate(changed); await assert.rejects(resumePlan(before, b.run)); assert.deepEqual(b.starts, []);
  }
});
