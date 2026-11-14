import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { LocalDocker } from './runtime/docker.mjs';
import { readConfiguration } from './runtime/options.mjs';
import { createSyncRunner } from './runtime/process.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-lock-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const state = { endpoint: 'unix:///test.sock', status: 'Completed', psDenied: false };
  const run = (command, args) => {
    if (command === 'cksum') return '123 20';
    if (command === 'ps') { if (state.psDenied) throw new Error('进程查询失败'); return '1'; }
    if (args[0] === 'context') return args[1] === 'show' ? 'desktop-linux' : state.endpoint;
    if (args.includes('history')) return state.status;
    throw new Error('未声明操作');
  };
  const env = { TMPDIR: root };
  return { state, env, runtime: () => new LocalDocker({ env, runSync: run, run: async (...args) => run(...args) }) };
}

test('完整镜像保护去重且拒绝标签', () => {
  const id = 'sha256:' + 'a'.repeat(64);
  assert.deepEqual(readConfiguration({ BUILD_PROTECTED_IMAGES: id }, [id]).protectedReferences, [id]);
  assert.throws(() => readConfiguration({ BUILD_PROTECTED_IMAGES: 'app:latest' }));
});

test('同步异步共用相同锁路径，活动构建失败释放自有锁', async t => {
  const f = fixture(t), sync = f.runtime().connectSync(), asyncRuntime = await f.runtime().connect();
  assert.equal(sync.lockPath, asyncRuntime.lockPath);
  sync.lockedSync(() => assert(existsSync(sync.lockPath))); assert(!existsSync(sync.lockPath));
  f.state.status = 'Running';
  assert.throws(() => sync.lockedSync(() => sync.idleSync())); assert(!existsSync(sync.lockPath));
});

test('同步异步均拒绝删除归属变化的锁', async t => {
  for (const asynchronous of [false, true]) {
    const runtime = fixture(t).runtime().connectSync();
    const action = () => writeFileSync(join(runtime.lockPath, 'pid'), '999999\n');
    if (asynchronous) await assert.rejects(runtime.locked(async () => action()), /归属发生变化/);
    else assert.throws(() => runtime.lockedSync(action), /归属发生变化/);
    assert.equal(readFileSync(join(runtime.lockPath, 'pid'), 'utf8'), '999999\n');
  }
});

test('同步入口接收异步结果时仍等待终态释放锁', async t => {
  const runtime = fixture(t).runtime().connectSync(); let finish;
  const pending = runtime.lockedSync(() => new Promise(done => { finish = done; }));
  assert(existsSync(runtime.lockPath)); finish(); await pending; assert(!existsSync(runtime.lockPath));
});

test('借锁必须匹配真实祖先且保留原锁；进程权限失败不创建锁', t => {
  const f = fixture(t), runtime = f.runtime().connectSync(); mkdirSync(runtime.lockPath);
  const pid = join(runtime.lockPath, 'pid'); writeFileSync(pid, '999999');
  assert.throws(() => runtime.lockedSync(() => assert.fail(), '999999'));
  writeFileSync(pid, String(process.ppid)); runtime.lockedSync(() => {}, String(process.ppid));
  assert.equal(readFileSync(pid, 'utf8'), String(process.ppid));
  const denied = fixture(t); denied.state.psDenied = true;
  const next = denied.runtime().connectSync(); assert.throws(() => next.lockedSync(() => assert.fail()));
  assert(!existsSync(next.lockPath));
});

test('同步异步均拒绝远端和端点覆盖', async t => {
  for (const override of ['remote', 'host']) {
    const f = fixture(t);
    if (override === 'remote') f.state.endpoint = 'tcp://remote:2375'; else f.env.DOCKER_HOST = 'unix:///other';
    assert.throws(() => f.runtime().connectSync()); await assert.rejects(f.runtime().connect());
  }
});

test('实际中间进程不会绕过或阻断祖先借锁校验', t => {
  const runtime = fixture(t).runtime().connectSync();
  runtime.lockedSync(() => {
    const code = `import {ownsUpdateLock} from ${JSON.stringify(new URL('./runtime/lock.mjs', import.meta.url).href)};if(!ownsUpdateLock(process.argv[1]))process.exit(17);`;
    createSyncRunner()('bash', ['-c', 'node --input-type=module -e "$1" "$2"; result=$?; exit "$result"', 'lock-test', code, runtime.lockPath]);
    assert(existsSync(runtime.lockPath));
  });
  assert(!existsSync(runtime.lockPath));
});
