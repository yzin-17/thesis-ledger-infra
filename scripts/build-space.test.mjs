import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BuildSpace, availableKiB, sizeKiB } from './runtime/space.mjs';
import { fixture } from './fixtures/node-runtime.mjs';

test('容量和 df 解析保持最小实际余量，未知输入拒绝', () => {
  assert.equal(sizeKiB('18gb'), 18 * 1024 ** 2); assert.equal(sizeKiB('0.5GB'), 512 * 1024);
  assert.equal(availableKiB('header\na 100 1 40 1% /\nb 100 1 20 1% /data'), 20);
  for (const value of ['bad', '-1', '1 gb']) assert.throws(() => sizeKiB(value));
  for (const value of ['', 'header\n', 'header\na 1 2 unknown 1% /']) assert.throws(() => availableKiB(value));
});

for (const target of ['all', 'dsa', 'thesis-ledger']) test(`参考目标达到后只维护有界缓存：${target}`, async t => {
  const { runtime, state } = fixture(t); await runtime.connect();
  const space = new BuildSpace(runtime, { target }); await space.initialize(); await space.ensure('test');
  assert(state.calls.some(args => args.includes('--reserved-space') && args.includes('4gb')));
  assert(!state.calls.some(args => args.some(value => value.endsWith('docker-space-images.mjs'))));
});

test('正余量低于参考值仍放行；普通整备不进入 all-unused', async t => {
  const { runtime, state } = fixture(t, { hostAvailable: 1024, dockerAvailable: 1024 }); await runtime.connect();
  const space = new BuildSpace(runtime); await space.initialize(); await space.ensure('test');
  assert(state.calls.some(args => args.some(value => value.endsWith('docker-space-images.mjs'))));
  assert(!state.calls.some(args => args.includes('--all-unused')));
});

test('零余量返回76；关闭清理不改变缓存或镜像', async t => {
  const { runtime, state } = fixture(t, { dockerAvailable: 0 }); await runtime.connect();
  const space = new BuildSpace(runtime, { repair: false }); await space.initialize();
  await assert.rejects(space.ensure('test'), error => error.code === 76);
  assert(!state.calls.some(args => args.includes('prune') || args.includes('--apply')));
});

test('活动构建、无效驱动和未知 df 均不进入资源清理', async t => {
  for (const options of [{ activeBuilder: true }, { driver: 'remote' }, { hostAvailable: 'unknown' }]) {
    const { runtime, state } = fixture(t, options); await runtime.connect(); const space = new BuildSpace(runtime, { repair: false });
    await assert.rejects(async () => { await space.initialize(); await space.ensure('test'); });
    assert(!state.calls.some(args => args.includes('prune') || args.includes('--apply')));
  }
});

test('全部未引用清理保护探针、复用镜像和本轮完成镜像', async t => {
  const { runtime, state } = fixture(t, { env: { REUSE_DSA_IMAGE_ID: 'sha256:' + 'a'.repeat(64) } });
  await runtime.connect(); const space = new BuildSpace(runtime); await space.initialize();
  space.completed.set('thesis-ledger', 'sha256:' + 'b'.repeat(64));
  await space.repairImages(true);
  const call = state.calls.find(args => args.includes('--all-unused'));
  assert(call.includes(space.probe)); assert(call.includes(runtime.env.REUSE_DSA_IMAGE_ID)); assert(call.includes(space.completed.get('thesis-ledger')));
  assert(!state.calls.some(args => args[0] === 'docker' && args.includes('volume') && args.includes('rm')));
});

test('首次探针只允许全空且宿主有余量；本地镜像已有时不下载', async t => {
  for (const denied of ['containers', 'volumes', 'host']) {
    const { runtime, state } = fixture(t, { env: { BOOTSTRAP_SPACE_PROBE: 'true' } }); state.tags.clear();
    if (denied === 'containers') state.inventory = '1 0';
    if (denied === 'host') { state.volumes.clear(); state.hostAvailable = 0; }
    if (denied !== 'volumes') state.volumes.clear();
    await runtime.connect(); const space = new BuildSpace(runtime); await space.initialize();
    await assert.rejects(space.prepareProbe());
    assert(!state.calls.some(args => args.includes('pull')));
  }
  const { runtime, state } = fixture(t, { env: { BOOTSTRAP_SPACE_PROBE: 'true' } }); state.tags.clear(); state.volumes.clear();
  await runtime.connect(); const space = new BuildSpace(runtime); await space.initialize(); await space.prepareProbe();
  assert.equal(state.calls.filter(args => args.includes('pull')).length, 1);
});
