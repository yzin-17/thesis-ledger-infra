import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryArguments, recoveryBootstrap } from './research-target-recovery.mjs';

test('研究恢复入口只接受精确目标、显式基线和新输出目录参数', () => {
  assert.deepEqual(recoveryArguments(['--target', 'thesis-ledger-dev', '--baseline', '/private/base', '--output', '/private/result']),
    { baseline: '/private/base', output: '/private/result' });
  assert.throws(() => recoveryArguments(['--target', 'production', '--baseline', '/private/base', '--output', '/private/result']));
  assert.throws(() => recoveryArguments(['--target', 'thesis-ledger-dev', '--output', '/private/result']));
});

test('受控进程载荷拒绝任意文件及路径跳转，不接受缺失驱动', () => {
  assert.throws(() => recoveryBootstrap({ '../main.js': 'unsafe' }, {}));
  assert.throws(() => recoveryBootstrap({}, {}));
});
