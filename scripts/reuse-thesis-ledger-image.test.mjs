import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('Server 镜像复用检查项目、服务和更新目标', async t => {
  for (const options of [{}, { projectLabel: 'other' }, { serviceLabel: 'other' }]) {
    const { runtime } = fixture(t, options); await runtime.connect();
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'thesis-ledger' });
    if (Object.keys(options).length) await assert.rejects(build.validateReuse('thesis-ledger', fullId(2)));
    else await build.validateReuse('thesis-ledger', fullId(2));
    build.select('all'); await assert.rejects(build.validateReuse('thesis-ledger', fullId(2)));
  }
});

test('Server 镜像复用传递完整运行形态并传播应用拒绝', async t => {
  const shape = { directory: '/fixture/app', user: 'fixture-user', command: '["node","fixture.js"]' };
  const requests = [];
  const { runtime } = fixture(t, {
    ...shape,
    intercept(binary, args, { input }, fail) {
      if (binary !== 'bash' || args[1] !== 'validate-image') return undefined;
      requests.push({ args, input });
      if (requests.length === 2) fail(1, '受控应用拒绝运行形态');
      return '';
    },
  });
  await runtime.connect();
  const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'thesis-ledger' });

  await build.validateReuse('thesis-ledger', fullId(2));
  await assert.rejects(build.validateReuse('thesis-ledger', fullId(2)), {
    code: 1,
    stderr: '受控应用拒绝运行形态',
  });
  const expected = {
    args: [resolve(runtime.root, '../thesis-ledger/scripts/local-deployment.sh'), 'validate-image'],
    input: [shape.directory, shape.user, shape.command, ''].join('\n'),
  };
  assert.deepEqual(requests, [expected, expected]);
});
