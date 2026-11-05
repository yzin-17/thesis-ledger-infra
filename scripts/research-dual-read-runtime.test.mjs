import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedGet, assertOwned, baselineFiles, controlledAccountId, fixtureSql, labelKey, verifyBaseline } from './research-dual-read-runtime.mjs';

const token = '75000000-0000-4000-8000-000000000001';
const owned = () => ({ Name: `/research-dual-read-${token}-postgres`,
  Config: { Labels: { [labelKey]: token, [`${labelKey}.role`]: 'postgres' } },
  HostConfig: { Privileged: false, Binds: [], NetworkMode: 'none' }, Mounts: [] });

test('清理与写入只接受自己的无卷、无宿主挂载、无外网副本', () => {
  assert.doesNotThrow(() => assertOwned(owned(), token, 'postgres'));
  for (const mutate of [value => { value.Name = '/thesis-ledger-dev-postgres-1'; },
    value => { value.Config.Labels[labelKey] = 'other'; },
    value => { value.HostConfig.NetworkMode = 'bridge'; },
    value => { value.HostConfig.Binds = ['/business:/data']; },
    value => { value.Mounts = [{ Type: 'volume' }]; }]) {
    const value = owned(); mutate(value); assert.throws(() => assertOwned(value, token, 'postgres'));
  }
});

test('HTTP 桥只允许限定研究 GET 路径，拒绝跨源及写入口', () => {
  assert(allowedGet('/research/capabilities'));
  assert(allowedGet('/research/reports?view=legacy'));
  assert(allowedGet('/api/v1/research/reports?view=legacy'));
  assert(allowedGet(`/journal/explanations/${token}?accountId=${token}`));
  assert(allowedGet(`/backtests/runs/${token}`));
  assert(allowedGet(`/research/reports/${token}/evidence/${token}?view=scoped&mode=actual`));
  assert(allowedGet(`/research/reports/${token}/observations?view=scoped&mode=shadow`));
  assert(allowedGet(`/research/reports/${token}/observations/${token}/versions?view=scoped&mode=shadow`));
  for (const path of ['//example.com/research/reports', 'https://example.com/research/reports',
    '/research/submissions', '/research/reports/../submissions', '/research/reports\\evil',
    '/ai/runs', `/backtests/runs/${token}/cancel`, '/journal/explanations',
    `/research/reports/${token}/observations/not-a-uuid/versions`,
    `/research/reports/${token}/observations/${token}/versions/extra`,
    '/research/reports\r\nHost: example.com']) assert(!allowedGet(path));
});

test('保存样本 SQL 使用固定表与允许字段，正文单引号被安全编码', () => {
  const sample = { format: 'research-dual-read-fixtures-v1', runs: [{ id: token, question: "受控'; SELECT 1; --" }], calls: [] };
  assert(fixtureSql(sample).includes("'受控''; SELECT 1; --'"));
  sample.runs[0].unexpectedColumn = 'x'; assert.throws(() => fixtureSql(sample));
});

test('受控账户插入只接受固定样本身份，不允许重用原有账户标识', () => {
  const sample = { format: 'research-dual-read-fixtures-v1', runs: [], calls: [],
    account: { id: controlledAccountId, name: '受控双读复盘账户', type: 'securities', mode: 'actual', active: true } };
  assert(fixtureSql(sample).includes('INSERT INTO "Account"'));
  sample.account.id = token; assert.throws(() => fixtureSql(sample));
});

test('恢复前拒绝载荷被篡改或文件路径越界的基线', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-baseline-check-'));
  try {
    const sha256 = createHash('sha256').update('controlled').digest('hex');
    for (const name of baselineFiles) writeFileSync(join(directory, name), 'controlled', { mode: 0o600 });
    const manifest = { format: 'research-dual-read-baseline-v1', target: 'thesis-ledger-dev', database: 'restore_db',
      images: { postgres: 'sha256:' + 'a'.repeat(64), redis: 'sha256:' + 'b'.repeat(64), server: 'sha256:' + 'c'.repeat(64) },
      protection: { database: 'restore_db', owner: 'restore_owner', head: '20261019020000_research_observation_versions' },
      schemaHead: '20261019020000_research_observation_versions', controlledAccountId, counters: { runs: 10 },
      files: baselineFiles.map(name => ({ name, bytes: 10, sha256 })) };
    const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    save(); await verifyBaseline(directory);
    writeFileSync(join(directory, 'postgres.dump'), 'tampered!!', { mode: 0o600 });
    await assert.rejects(() => verifyBaseline(directory));
    writeFileSync(join(directory, 'postgres.dump'), 'controlled', { mode: 0o600 });
    manifest.files[0].name = '../postgres.dump'; save();
    await assert.rejects(() => verifyBaseline(directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
