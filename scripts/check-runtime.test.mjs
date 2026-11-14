import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkRuntime } from './check-runtime.mjs';

test('入口只透传 argv 到现有 Node 模块，拒绝 Shell 编排和 Python 文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'infra-runtime-gate-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); mkdirSync(scripts);
  writeFileSync(join(scripts, 'infra.mjs'), '');
  writeFileSync(join(scripts, 'update.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/infra.mjs" update "$@"\n');
  assert.deepEqual(checkRuntime(root), []);
  for (const source of ['#!/bin/sh\npython3 helper.py\n', '#!/bin/sh\nexec node "$(dirname "$0")/missing.mjs" "$@"\n', '#!/bin/sh\nexec node "$(dirname "$0")/infra.mjs" "$@"\necho done\n']) {
    writeFileSync(join(scripts, 'update.sh'), source);
    assert.equal(checkRuntime(root).length, 1);
  }
  writeFileSync(join(scripts, 'legacy.py'), '');
  assert.equal(checkRuntime(root).length, 2);
});

test('测试由 Vitest 收集，拒绝为测试新增 Shell 入口', t => {
  const root = mkdtempSync(join(tmpdir(), 'infra-test-entry-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); mkdirSync(scripts);
  writeFileSync(join(scripts, 'flow.test.mjs'), '');
  writeFileSync(join(scripts, 'flow.test.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/flow.test.mjs" "$@"\n');
  assert.deepEqual(checkRuntime(root), ['scripts/flow.test.sh 的测试应由 Vitest 直接运行']);
});
