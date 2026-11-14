import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'vitest';
import { update } from './runtime/update.mjs';
import { fixture, fullId } from './fixtures/node-runtime.mjs';

test('正式更新保持构建、结构门禁、启动与健康顺序', async t => {
  const { runtime, state } = fixture(t); await update(runtime, ['all']);
  const build = state.calls.findIndex(args => args.includes('bake'));
  const sql = state.calls.findIndex(args => args.includes('run') && args.includes('DEV_DATABASE_MODE=check'));
  const start = state.calls.findIndex(args => args.includes('up') && args.includes('backtest-worker'));
  assert(build >= 0 && sql > build && start > sql);
  assert.deepEqual(state.builds, ['dsa', 'thesis-ledger']);
  assert(!existsSync(runtime.lockPath));
  assert(!state.calls.some(args => args.includes('down')));
});

test('帮助和错误参数在 Docker 操作前处理，compact 与关闭清理冲突', async t => {
  for (const [args, env, accepted] of [[['--help'], {}, true], [['other'], {}, false], [['all'], { UPDATE_SPACE_MODE: 'compact', REPAIR_BUILD_CACHE_ON_NO_SPACE: 'false' }, false]]) {
    const { runtime, state } = fixture(t, { env });
    if (accepted) await update(runtime, args); else await assert.rejects(update(runtime, args));
    assert.equal(state.calls.length, 0);
  }
});

test('活动构建和 ps 权限失败不进入资源变更，锁保持归属', async t => {
  for (const option of [{ activeBuilder: true }, { psDenied: true }]) {
    const { runtime, state } = fixture(t, option); await assert.rejects(update(runtime, ['dsa']));
    assert(!state.calls.some(args => ['prune', 'up', 'stop', 'pull', 'bake'].some(word => args.includes(word))));
    assert(!runtime.lockOwned);
  }
});

test('结构或启动失败不进入构建重试，健康后清理失败只报告警告', async t => {
  const { runtime, state } = fixture(t, { sqlFailure: true });
  await assert.rejects(update(runtime, ['thesis-ledger']));
  assert.equal(state.builds.length, 1); assert(!state.calls.some(args => args.includes('up') && args.includes('backtest-worker')));
  const failedStart = fixture(t, { startFailure: true });
  await assert.rejects(update(failedStart.runtime, ['dsa']));
  assert.equal(failedStart.state.builds.length, 1);
  assert(failedStart.state.calls.some(args => args.includes('logs')));
  const second = fixture(t);
  second.state.intercept = (binary, args, options, fail) => {
    if (args.includes('prune') && second.state.calls.some(call => call.includes('up') && call.includes('backtest-worker'))) fail();
  };
  await update(second.runtime, ['thesis-ledger']);
  assert(second.state.messages.some(message => message.includes('警告')));
});

test('显式重建必须先停止全部消费者；成功后才启动，失败保持停止', async t => {
  for (const sqlFailure of [false, true]) {
    const { runtime, state } = fixture(t, { sqlFailure, env: { DEV_DATABASE_MODE: 'rebuild', DEV_DATABASE_ALLOW_DATA_LOSS: 'true', DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger' } });
    if (sqlFailure) await assert.rejects(update(runtime, ['thesis-ledger'])); else await update(runtime, ['thesis-ledger']);
    const stop = state.calls.findIndex(args => args.includes('stop') && args.includes('backtest-worker'));
    const gate = state.calls.findIndex(args => args.includes('DEV_DATABASE_MODE=rebuild'));
    const start = state.calls.findIndex(args => args.includes('up') && args.includes('backtest-worker'));
    assert(stop >= 0 && gate > stop);
    if (sqlFailure) assert.equal(start, -1); else assert(start > gate);
    assert(!state.calls.some(args => args.includes('down') || args.includes('volume') && args.includes('rm')));
  }
});

test('已验 Server 模式恢复依赖后才重建两消费者，拒绝目标或镜像漂移', async t => {
  const { runtime, state } = fixture(t, { env: { REUSE_THESIS_LEDGER_IMAGE_ID: fullId(2) } });
  await update(runtime, ['thesis-ledger']); assert.equal(state.builds.length, 0);
  const dependency = state.calls.findIndex(args => args.includes('up') && args.includes('postgres') && args.includes('redis') && args.includes('dsa'));
  const consumers = state.calls.findIndex(args => args.includes('--force-recreate') && args.includes('backtest-worker'));
  assert(dependency >= 0 && consumers > dependency);
  const invalid = fixture(t, { env: { REUSE_THESIS_LEDGER_IMAGE_ID: fullId(2) } });
  await assert.rejects(update(invalid.runtime, ['all']));
});
