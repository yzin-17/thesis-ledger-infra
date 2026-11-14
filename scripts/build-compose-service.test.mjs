import assert from 'node:assert/strict';
import { test } from 'vitest';
import { networkOptions, BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture } from './fixtures/node-runtime.mjs';

test('构建网络参数保持代理和软件源边界，拒绝换行及错误协议', () => {
  assert.deepEqual(networkOptions({ BUILD_HTTP_PROXY: 'http://proxy:7890', BUILD_ALPINE_MIRROR: 'https://mirror.example/alpine' }),
    ['--set', '*.args.ALPINE_MIRROR=https://mirror.example/alpine', '--set', '*.args.HTTP_PROXY=http://proxy:7890']);
  for (const env of [{ BUILD_HTTPS_PROXY: 'socks5://proxy' }, { BUILD_NO_PROXY: 'host\ninjected' },
    { BUILD_ALPINE_MIRROR: 'https://user:password@mirror.example/alpine' }]) assert.throws(() => networkOptions(env));
});

test('Compose 输出直接传给固定 context 的 Bake，不经过 Shell 管道', async t => {
  const { runtime, state } = fixture(t); await runtime.connect(); runtime.configureCompose();
  const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'all' });
  try {
    await build.configuration(); await build.run();
    assert.deepEqual(state.builds, ['dsa', 'thesis-ledger']);
    const bakes = state.calls.filter(args => args.includes('bake'));
    assert(bakes.every(args => args.slice(0, 3).join(' ') === 'docker --context local' && args.includes('--allow')));
    assert.equal(space.completed.size, 2);
  } finally { await build.cleanup(); }
});
