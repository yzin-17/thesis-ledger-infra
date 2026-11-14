import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { reinstall } from './runtime/reinstall.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('保卷恢复先预取，持久保存挂载，扩大到全部服务且不删除卷', async t => {
  const { runtime, state, root } = fixture(t); await runtime.connect(); runtime.configureCompose();
  const space = new BuildSpace(runtime, { target: 'thesis-ledger' }); await space.initialize();
  const build = new BuildPlan(runtime, space, { target: 'thesis-ledger' });
  try {
    await build.configuration(); space.completed.set('thesis-ledger', fullId(2));
    await runtime.locked(() => reinstall(build));
    assert.equal(build.target, 'all'); assert(space.reinstalled);
    const source = state.calls.findIndex(args => args.includes('prepare-build'));
    const stop = state.calls.findIndex(args => args.includes('stop'));
    assert(source !== -1 && source < stop);
    assert(!state.calls.some(args => args.includes('volume') && args.includes('rm')));
    assert(!state.calls.some(args => args.includes('down') && args.includes('-v')));
    const file = join(root, '.maintenance-backups/docker-space-recovery/compose.json');
    assert.deepEqual(JSON.parse(readFileSync(file))['x-thesis-ledger-recovery'].volumeNames, [...state.volumes.keys()]);
    assert(existsSync(join(root, '.maintenance-backups/docker-space-recovery/incomplete')));
  } finally { await build.cleanup(); }
});

test('预取失败不停止容器；停止失败不 down；零余量保留恢复文件', async t => {
  for (const failure of ['prefetch', 'stop', 'space']) {
    const { runtime, state, root } = fixture(t, { prefetchFailure: failure === 'prefetch', stopFailure: failure === 'stop', dockerAvailable: failure === 'space' ? 0 : 40 * 1024 ** 2 });
    await runtime.connect(); runtime.configureCompose(); const space = new BuildSpace(runtime); await space.initialize();
    const build = new BuildPlan(runtime, space, { target: 'all' });
    try {
      await build.configuration(); await assert.rejects(runtime.locked(() => reinstall(build)));
      if (failure === 'prefetch') assert(!state.calls.some(args => args.includes('stop')));
      if (failure === 'stop') assert(!state.calls.some(args => args.includes('down')));
      if (failure === 'space') assert(existsSync(join(root, '.maintenance-backups/docker-space-recovery/compose.json')));
      assert(!runtime.lockOwned);
    } finally { await build.cleanup(); }
  }
});

test('无锁、重复恢复和不完整计划均拒绝在容器修改之前', async t => {
  const { runtime, state } = fixture(t); await runtime.connect(); runtime.configureCompose();
  const space = new BuildSpace(runtime); const build = new BuildPlan(runtime, space, { target: 'all' });
  try {
    await build.configuration(); await assert.rejects(reinstall(build));
    state.intercept = (binary, args) => args[0]?.endsWith('docker-reinstall-plan.mjs') ? '{}' : undefined;
    await assert.rejects(runtime.locked(() => reinstall(build)));
    await assert.rejects(runtime.locked(() => reinstall(build)));
    assert(!state.calls.some(args => args.includes('stop')));
  } finally { await build.cleanup(); }
});
