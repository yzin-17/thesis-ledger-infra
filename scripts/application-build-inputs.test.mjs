import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('应用构建准备保持目标选择、已验镜像跳过和成功幂等', async t => {
  for (const [target, reuse, expected] of [['thesis-ledger', false, 0], ['dsa', true, 0], ['dsa', false, 1]]) {
    const { runtime, state } = fixture(t, { env: reuse ? { REUSE_DSA_IMAGE_ID: fullId(1) } : {} });
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target });
    try {
      await build.configuration(); await build.prepareInputs(); await build.prepareInputs();
      assert.equal(state.calls.filter(args => args.includes('prepare-build')).length, expected);
      const other = join(build.work, 'other-assets'); mkdirSync(other); await build.cleanup(); assert(existsSync(other));
    } finally { await build.cleanup(); }
  }
});

test('失败准备仍执行应用精确清理，不将未完成标记为可复用', async t => {
  const { runtime, state } = fixture(t, { prefetchFailure: true });
  const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'dsa' });
  await build.configuration(); await assert.rejects(build.prepareInputs());
  assert.equal(build.inputsPrepared, false); await build.cleanup();
  assert(state.calls.some(args => args.includes('cleanup-build')));
});
