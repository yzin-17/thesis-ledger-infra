import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { extendDisk, extendSettings, readSettings } from './docker-desktop-disk.mjs';
import { LocalDocker } from './runtime/docker.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'node-desktop-disk-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const settings = join(root, 'Library/Group Containers/group.com.docker/settings-store.json');
  const raw = join(root, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
  mkdirSync(dirname(settings), { recursive: true }); mkdirSync(dirname(raw), { recursive: true });
  const original = { DiskSizeMiB: 1024, OtherSetting: { keep: '原值' } };
  writeFileSync(settings, JSON.stringify(original)); chmodSync(settings, 0o600); writeFileSync(raw, '');
  truncateSync(raw, 1024 * 1024 ** 2);
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'ps') return '1'; if (binary === 'cksum') return '123 20';
    const a = args[0] === '--context' ? args.slice(2) : args;
    if (a[0] === 'context') return a[1] === 'show' ? (options.context ?? 'desktop-linux') : 'unix:///controlled.sock';
    if (a[0] === 'buildx') return options.active ? 'Running' : 'Completed';
    if (a[0] === 'desktop') {
      if (a[1] === 'stop' && options.concurrent) writeFileSync(settings, JSON.stringify({ ...original, OtherSetting: '并发修改' }));
      if (a[1] === 'start') truncateSync(raw, JSON.parse(readFileSync(settings)).DiskSizeMiB * 1024 ** 2);
      return '';
    }
    if (['image', 'container', 'volume'].includes(a[0])) return 'original';
    if (a[0] === 'info') return 'ok';
    throw new Error('未声明操作');
  };
  const runtime = new LocalDocker({ root, env: { TMPDIR: root }, run, log() {} });
  return { root, settings, raw, original, runtime, calls };
}

test('扩容原子保存原配置、权限及私有备份；禁止缩盘、分数、布尔值和链接', t => {
  const f = fixture(t), backup = join(f.root, 'backup');
  extendSettings(f.settings, 2048, f.original, backup);
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { ...f.original, DiskSizeMiB: 2048 });
  const file = join(backup, readdirSync(backup)[0]);
  assert.deepEqual(JSON.parse(readFileSync(file)), f.original); assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(f.settings).mode & 0o777, 0o600);
  for (const invalid of [1024, 2049, true, -1024]) assert.throws(() => readSettings(f.settings, invalid));
  const link = join(f.root, 'linked'); symlinkSync(f.settings, link); assert.throws(() => readSettings(link, 4096));
});

test('容量相同时不停止；远端与活动构建均在停止前拒绝并释放锁', async t => {
  const same = fixture(t); await extendDisk(same.runtime, 1024, same.root); assert.equal(same.calls.length, 0);
  for (const options of [{ context: 'remote' }, { active: true }]) {
    const f = fixture(t, options); await assert.rejects(extendDisk(f.runtime, 2048, f.root));
    assert(!f.calls.some(args => args.includes('stop'))); assert(!f.runtime.lockOwned);
  }
});

test('正常扩容保持资源和磁盘身份；并发配置变化保留且仍恢复引擎', async t => {
  const normal = fixture(t); const inode = statSync(normal.raw).ino;
  await extendDisk(normal.runtime, 2048, normal.root);
  assert.equal(statSync(normal.raw).ino, inode); assert(!existsSync(normal.runtime.lockPath));
  const concurrent = fixture(t, { concurrent: true });
  await assert.rejects(extendDisk(concurrent.runtime, 2048, concurrent.root), /并发修改/);
  assert.equal(JSON.parse(readFileSync(concurrent.settings)).OtherSetting, '并发修改');
  assert(concurrent.calls.some(args => args.includes('start'))); assert(!concurrent.runtime.lockOwned);
});
