import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { assertManifest, backup, payloads, sql } from './state-backup.mjs';
import { createSyncRunner } from './runtime/process.mjs';

test('备份格式由调用者声明，缺失或不匹配时先于 Docker 拒绝', async () => {
  const format = 'controlled-state-v1';
  const manifest = { format, target: 'thesis-ledger-dev', state: {},
    files: payloads.map(name => ({ name, bytes: 1, sha256: 'a'.repeat(64) })),
    images: Object.fromEntries(['dsa', 'postgres', 'server', 'worker'].map(name => [name, 'sha256:' + 'a'.repeat(64)])) };
  assertManifest(manifest, { format });
  assert.throws(() => assertManifest(manifest));
  assert.throws(() => assertManifest(manifest, { format: 'other' }));
  await assert.rejects(backup('/unused', { protectionSql: 'unused', assertState() {} }), /声明备份格式/);
  for (const target of [null, {}, { database: 'db' }]) assert.throws(() => sql('unused', 'unused', target));
});

test('调用方提供的数据库参数以独立 argv 传递', t => {
  const root = mkdtempSync(join(tmpdir(), 'infra-database-target-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'docker'), `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='context')process.stdout.write(a[1]==='show'?'local':'unix:///fixture.sock');
else{let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:a,input})));}`, { mode: 0o755 });
  const database = 'literal; $(must-not-run)';
  const code = `import{sql}from ${JSON.stringify(new URL('./state-backup.mjs', import.meta.url).href)};console.log(JSON.stringify(sql('controlled','SELECT 1;',{owner:'owner',database:process.argv[1]})));`;
  const result = createSyncRunner({ env: { ...process.env, PATH: root + ':' + dirname(process.execPath) + ':' + process.env.PATH, DOCKER_HOST: '' } })(process.execPath, ['--input-type=module', '-e', code, database]);
  const value = JSON.parse(result);
  assert.deepEqual(value.args, ['--context', 'local', 'exec', '-i', 'controlled', 'psql', '-U', 'owner', '-d', database, '-Atq']);
  assert.equal(value.input, 'SELECT 1;');
});
