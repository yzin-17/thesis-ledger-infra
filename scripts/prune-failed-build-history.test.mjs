import assert from 'node:assert/strict';
import { test } from 'vitest';
import { removeFailedHistory } from './runtime/maintenance.mjs';

test('失败记录清理先核对全部目标，再逐项重查；不删除成功或漂移记录', async () => {
  const id = 'a'.repeat(20), calls = []; let status = 'failed';
  const runtime = { context: 'local', log() {}, idle: async () => {}, docker: async args => { calls.push(args); return status; } };
  await assert.rejects(removeFailedHistory(runtime, []));
  await assert.rejects(removeFailedHistory(runtime, ['invalid']));
  status = 'completed'; await assert.rejects(removeFailedHistory(runtime, [id]));
  assert(!calls.some(args => args.includes('rm')));
  calls.length = 0; status = 'failed'; runtime.idle = async () => { status = 'running'; };
  await assert.rejects(removeFailedHistory(runtime, [id])); assert(!calls.some(args => args.includes('rm')));
  calls.length = 0; status = 'failed'; runtime.idle = async () => {};
  await removeFailedHistory(runtime, [id]); assert.equal(calls.filter(args => args.includes('rm')).length, 1);
});
