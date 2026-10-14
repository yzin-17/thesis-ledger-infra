import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertManifest, checkOutputDirectory, digest, payloads, verifyBundle } from './research-state-backup.mjs';

const manifest = () => ({ format: 'thesis-ledger-research-state-v1', target: 'thesis-ledger-dev',
  files: payloads.map(name => ({ name, bytes: 1, sha256: digest('x') })),
  images: Object.fromEntries(['worker', 'server', 'postgres', 'dsa'].map(key => [key, `sha256:${'a'.repeat(64)}`])),
  state: { database: 'thesis_ledger', owner: 'thesis_ledger', activeBacktests: 0, head: '20261006030000_strategy_authoring_save', runs: [] } });
test('拒绝任意目录、目标、活动回测和载荷路径', () => {
  assert.throws(() => checkOutputDirectory('/private/tmp/arbitrary-backup'));
  assert.throws(() => checkOutputDirectory('relative'));
  for (const change of [m => m.target = 'production', m => m.state.activeBacktests = 1,
    m => m.files[0].name = '../secret', m => m.images.worker = 'latest']) {
    const m = manifest(); change(m); assert.throws(() => assertManifest(m));
  }
});
test('摘要变化和符号链接不能通过载荷校验', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'f01-backup-test-'));
  try {
    const m = manifest();
    for (const name of payloads) writeFileSync(resolve(root, name), 'x', { mode: 0o600 });
    writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(m), { mode: 0o600 });
    await verifyBundle(root);
    writeFileSync(resolve(root, payloads[0]), 'y');
    await assert.rejects(() => verifyBundle(root));
    rmSync(resolve(root, payloads[0])); symlinkSync(resolve(root, payloads[1]), resolve(root, payloads[0]));
    await assert.rejects(() => verifyBundle(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
