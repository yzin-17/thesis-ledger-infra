import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('构建间仅释放普通中间层，健康后有界收敛且保留完成镜像保护', async t => {
  const { runtime, state } = fixture(t); await runtime.connect();
  const space = new BuildSpace(runtime); await space.initialize();
  space.completed.set('dsa', fullId(1)); await space.releaseIntermediates('dsa'); await space.finalize();
  const prunes = state.calls.filter(args => args.includes('prune'));
  assert(prunes[0].includes('type!=exec.cachemount')); assert(prunes[1].includes('--reserved-space'));
  assert.equal(space.completed.get('dsa'), fullId(1));
  assert(!state.calls.some(args => args.includes('--all-unused')));
});

test('关闭清理无副作用；活动构建和实际清理失败传播，不清除保护', async t => {
  const disabled = fixture(t); await disabled.runtime.connect();
  const space = new BuildSpace(disabled.runtime, { repair: false }); await space.finalize();
  assert(!disabled.state.calls.some(args => args.includes('prune') || args.includes('run')));
  for (const options of [{ activeBuilder: true }, { cacheFailure: true }]) {
    const { runtime } = fixture(t, options); await runtime.connect(); const current = new BuildSpace(runtime);
    current.completed.set('dsa', fullId(1)); await assert.rejects(current.finalize()); assert.equal(current.completed.size, 1);
  }
});
