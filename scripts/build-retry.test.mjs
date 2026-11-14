import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('普通失败只重试一次，保留先完成的镜像且不清空依赖缓存', async t => {
  const { runtime, state } = fixture(t, { buildFailure: (count, service) => service === 'thesis-ledger' && count === 2 ? 'controlled build failure' : '' });
  await runtime.connect(); runtime.configureCompose(); const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'all' });
  try {
    await build.configuration(); await build.withRetry(() => assert.fail('不能重装'));
    assert.deepEqual(state.builds, ['dsa', 'thesis-ledger', 'thesis-ledger']);
    assert(state.calls.filter(args => args.includes('prune')).every(args => args.includes('type!=exec.cachemount')));
  } finally { await build.cleanup(); }
});

test('ENOSPC 最多一次保卷恢复；恢复后再失败立即退出', async t => {
  const { runtime, state } = fixture(t, { buildFailure: () => 'ENOSPC' });
  await runtime.connect(); runtime.configureCompose(); const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'dsa' });
  let recovered = 0;
  try {
    await build.configuration();
    await assert.rejects(build.withRetry(async () => { recovered += 1; space.reinstalled = true; }));
    assert.equal(recovered, 1); assert.equal(state.builds.length, 2);
  } finally { await build.cleanup(); }
});

test('镜像身份变化或构建间维护失败不进入重试/重装', async t => {
  for (const failure of ['image', 'cache']) {
    const { runtime, state } = fixture(t); await runtime.connect(); runtime.configureCompose();
    const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'dsa' });
    try {
      await build.configuration();
      if (failure === 'image') { space.completed.set('dsa', fullId(3)); }
      else state.cacheFailure = true;
      await assert.rejects(build.withRetry(() => assert.fail('不能重装')), error => error.code === 75);
      assert(state.builds.length <= 1);
    } finally { await build.cleanup(); }
  }
});
