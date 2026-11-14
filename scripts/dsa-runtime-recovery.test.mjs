import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { ownsUpdateLock } from './runtime/lock.mjs';

test('锁校验接受真实祖先，拒绝他人、循环及无法查询的进程链', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-lock-owner-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const owner = process.ppid + 100000;
  writeFileSync(join(root, 'pid'), String(process.ppid));
  assert.equal(ownsUpdateLock(root, () => { throw new Error('直接父进程无需额外查询'); }), true);
  writeFileSync(join(root, 'pid'), String(owner));
  assert.equal(ownsUpdateLock(root, () => String(owner)), true);
  assert.equal(ownsUpdateLock(root, () => '1'), false);
  assert.equal(ownsUpdateLock(root, () => String(process.ppid)), false);
  assert.equal(ownsUpdateLock(root, () => { throw new Error('进程查询不可用'); }), false);
  writeFileSync(join(root, 'pid'), 'invalid');
  assert.equal(ownsUpdateLock(root, () => String(owner)), false);
});
