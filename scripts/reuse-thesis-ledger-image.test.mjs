import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('Server 复用保持应用拥有的运行形态判断及全部身份保护', async t => {
  for (const options of [{}, { projectLabel: 'other' }, { serviceLabel: 'other' }, { directory: '/other' }, { user: 'root' }, { command: '[]' }]) {
    const { runtime } = fixture(t, options); await runtime.connect();
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'thesis-ledger' });
    if (Object.keys(options).length) await assert.rejects(build.validateReuse('thesis-ledger', fullId(2)));
    else await build.validateReuse('thesis-ledger', fullId(2));
    build.select('all'); await assert.rejects(build.validateReuse('thesis-ledger', fullId(2)));
  }
});
