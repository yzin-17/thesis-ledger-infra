import assert from 'node:assert/strict';
import { test } from 'vitest';
import { desktop } from './runtime/maintenance.mjs';
import { LocalDocker } from './runtime/docker.mjs';

test('Desktop start 幂等；不可用时启动并复查；严格拒绝其他操作', async () => {
  const calls = []; let available = true;
  const run = async (binary, args) => {
    if (binary === 'cksum') return '1 2';
    if (args[0] === 'context') return args[1] === 'show' ? 'local' : 'unix:///controlled.sock';
    assert.deepEqual(args.slice(0, 2), ['--context', 'local']);
    args = args.slice(2); calls.push(args);
    if (args[0] === 'info' && !available) throw new Error('offline'); available = true; return '';
  };
  const runtime = new LocalDocker({ run, env: {}, log() {} });
  await desktop(runtime, ['start']); assert.equal(calls.length, 1);
  calls.length = 0; available = false;
  await desktop(runtime, ['start']); assert.deepEqual(calls.map(args => args[0]), ['info', 'desktop', 'info']);
  await assert.rejects(desktop(runtime, ['recover']), error => error.code === 2);
  await assert.rejects(desktop(new LocalDocker({ run: async () => { throw new Error('failed'); } }), ['start']));
});
