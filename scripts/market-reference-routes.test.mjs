import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { routePlan, withServerPlan, mergedReferenceRoutes } from './market-reference-routes.mjs';

test('路由应用必须带精确目标、计划和绝对证据路径', () => {
  const output = '--output=/tmp/reference-plan.json';
  assert.equal(routePlan([output]).mode, 'plan');
  for (const args of [[output, '--mode=apply'], [output, '--url=https://example.com'],
    ['--output=relative'], [output, output], [output, '--plan=/tmp/plan.json']]) assert.throws(() => routePlan(args));
  assert.equal(routePlan([output, '--mode=apply', '--plan=/tmp/plan.json',
    '--confirm=thesis-ledger-dev/reference-routes/append-only']).mode, 'apply');
});

test('Server 与 DSA 的事实一致才允许生成计划', () => {
  const dsa = { previousRevision: 1, previousRoutes: [{ key: 'old' }] };
  const server = { contractVersion: 3, enabled: true, syncState: 'applied', effectiveStale: false, revision: 1, routes: dsa.previousRoutes };
  assert.equal(withServerPlan(dsa, server).serverRevision, 1);
  for (const patch of [{ revision: 2 }, { routes: [] }, { syncState: 'pending' }, { effectiveStale: true }]) assert.throws(() => withServerPlan(dsa, { ...server, ...patch }));
});

test('取消只撤销本轮已创建且未变化的路由', () => {
  const original = { key: { capability: 'old' }, targets: [] };
  const created = { key: { capability: 'new' }, targets: [] };
  const current = { serverRoutes: [original, created], dsa: { retirements: [created], additions: [] } };
  assert.throws(() => mergedReferenceRoutes(current, null));
  const owned = { serverRoutes: [original], dsa: { additions: [created] } };
  assert.deepEqual(mergedReferenceRoutes(current, owned), [original]);
  assert.throws(() => mergedReferenceRoutes(current, { ...owned, serverRoutes: [original, created] }));
});
