import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { bootstrap, lockedCommand } from './runtime/maintenance.mjs';
import { fixture } from './fixtures/node-runtime.mjs';

test('bootstrap 复用同级现有工作树和 gitdir 文件，不覆盖未提交目录', async t => {
  const { root, state, runtime } = fixture(t);
  await assert.rejects(bootstrap(runtime.run, root, {}, () => {}));
  for (const name of ['thesis-ledger', 'daily-stock-analysis']) writeFileSync(join(root, '..', name, '.git'), 'gitdir: controlled');
  await bootstrap(runtime.run, root, {}, () => {});
  assert(!state.calls.some(args => args[0] === 'git'));
});

test('持锁命令只接受登记的 Node 文件，拒绝临时解释器和未登记脚本', async t => {
  const { runtime, root, state } = fixture(t);
  const file = resolve(root, '../daily-stock-analysis/scripts/deployment/maintain.mjs'); writeFileSync(file, '');
  await assert.rejects(lockedCommand(runtime, ['--', 'bash', '-c', 'anything']));
  await assert.rejects(lockedCommand(runtime, ['--', 'node', '-e', 'anything']));
  await assert.rejects(lockedCommand(runtime, ['--', 'node', file]));
  assert.equal(state.calls.length, 0);
  writeFileSync(resolve(root, '../daily-stock-analysis/scripts/deployment/maintenance.json'), JSON.stringify({ commands: [{ path: 'scripts/deployment/maintain.mjs', idle: true }] }));
  await assert.rejects(lockedCommand(runtime, ['--', 'node', file]));
  state.intercept = (binary, args, options) => {
    if (binary === 'node') { assert(existsSync(runtime.lockPath)); assert(args.includes(runtime.lockPath)); assert.equal(options.env.INFRA_UPDATE_LOCK_PATH, runtime.lockPath); return ''; }
  };
  await lockedCommand(runtime, ['--idle', '--', 'node', file, '@update-lock']);
  assert(!existsSync(runtime.lockPath));
});
