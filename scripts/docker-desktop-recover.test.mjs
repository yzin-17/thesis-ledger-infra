import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverDockerDesktop } from './docker-desktop-recover.mjs';

function fixture({ ready = false, restartCode = 0, afterReady = true, processCode = 0, processText = '' } = {}) {
  const calls = [];
  let checks = 0;
  const run = (command, args, timeout) => {
    calls.push({ command, args, timeout });
    if (command === '/bin/ps') return { status: processCode, stdout: processText };
    if (args[0] === 'info') return { status: (checks++ === 0 ? ready : afterReady) ? 0 : 1, stdout: '', stderr: '测试诊断' };
    assert.deepEqual(args, ['desktop', 'restart', '--timeout', '45']);
    return { status: restartCode, stdout: '', stderr: '' };
  };
  return { calls, run, freeBytes: () => 1024 };
}

test('默认只读预览，不执行引擎重启', () => {
  const f = fixture();
  const result = recoverDockerDesktop(f);
  assert.equal(result.engineReady, false);
  assert.equal(result.restarted, false);
  assert.equal(f.calls.length, 2);
});
test('健康引擎即使显式执行也保持不动', () => {
  const f = fixture({ ready: true });
  assert.equal(recoverDockerDesktop({ ...f, execute: true }).engineReady, true);
  assert.equal(f.calls.length, 2);
});
test('显式执行只重启一次并重新核对引擎', () => {
  const f = fixture();
  assert.equal(recoverDockerDesktop({ ...f, execute: true }).engineReady, true);
  assert.deepEqual(f.calls.map(call => call.timeout), [8000, 8000, 55000, 8000]);
  assert.equal(f.calls.filter(call => call.args[0] === 'desktop').length, 1);
});
test('重启失败保留失败，不重试或追加状态变更', () => {
  const f = fixture({ restartCode: 9 });
  assert.equal(recoverDockerDesktop({ ...f, execute: true }).engineReady, false);
  assert.equal(f.calls.length, 3);
});
test('重启后仍不可用不能标记通过', () => {
  const f = fixture({ afterReady: false });
  assert.equal(recoverDockerDesktop({ ...f, execute: true }).engineReady, false);
});
test('活动更新或无法检查进程时不得重启', () => {
  for (const options of [{ processCode: 1 }, { processText: '123 bash ./scripts/update.sh thesis-ledger' }, { processText: '124 bash ./scripts/sync-code.sh thesis-ledger' }]) {
    const f = fixture(options);
    assert.throws(() => recoverDockerDesktop({ ...f, execute: true }));
    assert.equal(f.calls.length, 1);
  }
});
test('磁盘余量未知或为零时停止，正余量不另设门槛', () => {
  for (const bytes of [0, NaN, -1]) {
    const f = fixture();
    assert.throws(() => recoverDockerDesktop({ ...f, freeBytes: () => bytes, execute: true }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ ready: true });
  assert.equal(recoverDockerDesktop({ ...f, freeBytes: () => 1 }).engineReady, true);
});

function forceFixture({ stopCode = 0, startCode = 0, afterReady = true, ready = false } = {}) {
  const calls = [];
  let checks = 0;
  const run = (command, args, timeout) => {
    calls.push({ command, args, timeout });
    if (command === '/bin/ps') return { status: 0, stdout: '' };
    if (args[0] === 'info') {
      let available = afterReady;
      if (checks++ === 0) available = ready;
      return { status: available ? 0 : 1, stderr: '' };
    }
    if (args[1] === 'stop') {
      assert.deepEqual(args, ['desktop', 'stop', '--force', '--timeout', '45']);
      return { status: stopCode, stderr: '' };
    }
    assert.deepEqual(args, ['desktop', 'start', '--timeout', '45']);
    return { status: startCode, stderr: '' };
  };
  return { calls, run, freeBytes: () => 1024 };
}

test('显式强制恢复最多停止和启动各一次，并独立核对 daemon', () => {
  const f = forceFixture();
  const result = recoverDockerDesktop({ ...f, execute: true, forceStop: true });
  assert.equal(result.engineReady, true);
  assert.equal(result.forcedStop, true);
  assert.deepEqual(f.calls.map(x => x.timeout), [8000, 8000, 55000, 55000, 8000]);
  assert.equal(f.calls.filter(x => x.args[0] === 'desktop').length, 2);
});
test('强制停止失败时不得启动，启动失败时不得继续检查或重试', () => {
  for (const [options, expectedCalls, forcedStop] of [[{ stopCode: 9 }, 3, false], [{ startCode: 9 }, 4, true]]) {
    const f = forceFixture(options);
    const result = recoverDockerDesktop({ ...f, execute: true, forceStop: true });
    assert.equal(result.engineReady, false);
    assert.equal(result.forcedStop, forcedStop);
    assert.equal(f.calls.length, expectedCalls);
  }
});
test('强制分支预览和健康引擎不变更状态，恢复后仍不可用保持失败', () => {
  const preview = forceFixture();
  recoverDockerDesktop({ ...preview, forceStop: true });
  assert.equal(preview.calls.length, 2);
  const healthy = forceFixture({ ready: true });
  recoverDockerDesktop({ ...healthy, execute: true, forceStop: true });
  assert.equal(healthy.calls.length, 2);
  const unavailable = forceFixture({ afterReady: false });
  assert.equal(recoverDockerDesktop({ ...unavailable, execute: true, forceStop: true }).engineReady, false);
});
test('强制分支同样拒绝无磁盘余量和活动更新', () => {
  for (const options of [{ freeBytes: () => 0 }, { run: () => ({ status: 0, stdout: '99 bash ./scripts/update.sh thesis-ledger' }) }]) {
    const f = forceFixture();
    assert.throws(() => recoverDockerDesktop({ ...f, ...options, execute: true, forceStop: true }));
    assert.equal(f.calls.length, 0);
  }
});
