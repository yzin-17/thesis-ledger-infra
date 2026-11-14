import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { createSyncRunner } from './runtime/process.mjs';

test('备份输出保留原始字节且所有操作固定首次验证的本地 context', t => {
  const root = mkdtempSync(join(tmpdir(), 'infra-binary-context-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
if(a[0]==='context')process.stdout.write(a[1]==='show'?'local':process.env.ENDPOINT);
else process.stdout.write(Buffer.from([0,255,128,10]));`, { mode: 0o755 });
  const script = `import {docker} from ${JSON.stringify(new URL('./runtime-io.mjs', import.meta.url).href)};
const first=docker(['version']);process.env.DOCKER_CONTEXT='other';const second=docker(['version']);
if(!first.equals(second))throw new Error('bytes');process.stdout.write(first);`;
  const env = { ...process.env, PATH: root + ':' + dirname(process.execPath) + ':' + process.env.PATH,
    CALLS: join(root, 'calls'), ENDPOINT: 'unix:///controlled.sock', DOCKER_HOST: '' };
  const run = createSyncRunner({ env });
  assert.deepEqual(run(process.execPath, ['--input-type=module', '-e', script], { encoding: null }), Buffer.from([0, 255, 128, 10]));
  const calls = readFileSync(env.CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.filter(args => args.includes('version')).every(args => args[0] === '--context' && args[1] === 'local'));
  assert.throws(() => run(process.execPath, ['--input-type=module', '-e', script], { env: { ENDPOINT: 'tcp://remote:2375' } }));
});
