import assert from 'node:assert/strict';
import { test } from 'vitest';
import { syncCode } from './runtime/sync.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('快更更新全部选中服务，保持镜像且不构建或修改数据库和卷', async t => {
  const { runtime, state } = fixture(t); await syncCode(runtime, ['all']);
  assert.equal(state.calls.filter(args => args.includes('restart')).length, 1);
  assert.equal(state.calls.filter(args => args.includes('sh') && args.includes('-s')).length, 3);
  assert(!state.calls.some(args => ['bake', 'pull', 'up', 'volume', 'down'].some(word => args.includes(word))));
  assert(state.messages.some(message => message.includes('镜像 ID 保持不变')));
  assert(!runtime.lockOwned);
});

test('所有兼容预检和载荷成功之前不修改容器；镜像漂移也拒绝', async t => {
  for (const failure of ['preflight', 'payload', 'image', 'health']) {
    const { runtime, state } = fixture(t, { preflightFailure: failure === 'preflight', payloadFailure: failure === 'payload', noHealth: failure === 'health' });
    if (failure === 'image') state.tags.set('daily-stock-analysis:thesisledger-dev', fullId(3));
    await assert.rejects(syncCode(runtime, ['all']));
    assert(!state.calls.some(args => ['exec', 'restart', 'up'].some(word => args.includes(word))));
  }
});

test('应用替换或健康失败只恢复已修改服务到同一镜像，不操作卷', async t => {
  for (const options of [{ applyFailure: true }, { healthFailure: true }]) {
    const { runtime, state } = fixture(t, options); await assert.rejects(syncCode(runtime, ['all']));
    const restore = state.calls.find(args => args.includes('up'));
    assert(restore.includes('--force-recreate') && restore.includes('--no-build') && restore.includes('never'));
    if (options.applyFailure) assert.deepEqual(restore.slice(restore.indexOf('--force-recreate') + 1), ['dsa']);
    else assert.deepEqual(restore.slice(restore.indexOf('--force-recreate') + 1), ['dsa', 'thesis-ledger', 'backtest-worker']);
    assert(!state.calls.some(args => args.includes('volume') || args.includes('prune')));
    assert(!runtime.lockOwned);
  }
});

test('帮助与非法目标不连接 Docker', async t => {
  const { runtime, state } = fixture(t); await syncCode(runtime, ['--help']);
  await assert.rejects(syncCode(runtime, ['other'])); assert.equal(state.calls.length, 0);
});
