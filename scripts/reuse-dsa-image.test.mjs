import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('DSA 复用核对 ID、服务和公开运行契约，完成后跳过构建', async t => {
  for (const options of [{}, { serviceLabel: 'other' }, { profile: 'legacy' }]) {
    const { runtime, state } = fixture(t, { ...options, env: { REUSE_DSA_IMAGE_ID: fullId(1) } }); await runtime.connect(); runtime.configureCompose();
    const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'dsa' });
    try {
      await build.configuration();
      if (options.serviceLabel || options.profile) await assert.rejects(build.validateReuse('dsa', fullId(1)));
      else { await build.run(); assert.equal(state.builds.length, 0); assert.equal(space.completed.get('dsa'), fullId(1)); }
      await assert.rejects(build.validateReuse('dsa', 'short'));
    } finally { await build.cleanup(); }
  }
});
