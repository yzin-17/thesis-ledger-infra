import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertUpgradeInput, cleanupObservationResources, compatibleServerArgs, retentionArguments, retentionSql, retentionStructureSql }
  from './research-observation-retention-guards.mjs';
import { observationSeedProgram, seedObservationVersions } from './research-observation-retention-probe.mjs';
import { labelKey } from './research-dual-read-runtime.mjs';

const token = '75000000-0000-4000-8000-000000000001', postgres = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
const owned = () => ({ Name: `/research-dual-read-${token}-server`, Mounts: [],
  HostConfig: { Privileged: false, Binds: [], NetworkMode: `container:${postgres}`, ReadonlyRootfs: true },
  Config: { Labels: { [labelKey]: token, [`${labelKey}.role`]: 'server' }, Env: [
    'NODE_ENV=test', 'PORT=3000', 'DATABASE_URL=postgresql://research_reader@127.0.0.1:5432/restore_db',
    'REDIS_URL=redis://127.0.0.1:6379', 'DSA_BASE_URL=http://127.0.0.1:19876',
    'THESIS_LEDGER_DSA_TOKEN=controlled-test', 'CREDENTIAL_ENCRYPTION_KEY=controlled-test',
    'AI_RESEARCH_EXECUTION_ENABLED=false', 'AI_RESEARCH_V2_WRITES_ENABLED=false',
    'STRATEGY_AI_OPTIMIZATION_ENABLED=false', 'STRATEGY_RISK_APPLICATIONS_ENABLED=false' ] } });

test('命令必须固定目标并明确升级回执、兼容基线和输出；拒绝多余参数', () => {
  const args = ['--target', 'thesis-ledger-dev', '--upgrade-receipt', '/receipt', '--compatible-baseline', '/baseline', '--output', '/output'];
  assert.deepEqual(retentionArguments(args), { upgrade: '/receipt', compatible: '/baseline', output: '/output' });
  assert.throws(() => retentionArguments([...args, '--database', 'production']));
  assert.throws(() => retentionArguments(['--target', 'production', ...args.slice(2)]));
});

test('兼容镜像只能接自有无卷隔离库，只读服务且全部研究执行关闭', () => {
  const args = compatibleServerArgs(owned(), image, postgres, token);
  assert(args.includes('container:' + postgres)); assert(args.includes('--read-only'));
  assert(!args.includes('--publish')); assert(!args.includes('--volume'));
  for (const mutate of [value => { value.Name = '/thesis-ledger-dev-thesis-ledger-1'; },
    value => { value.Config.Env[2] = 'DATABASE_URL=postgresql://owner@target/thesis_ledger'; },
    value => { value.Config.Env[8] = 'AI_RESEARCH_EXECUTION_ENABLED=true'; },
    value => { value.HostConfig.ReadonlyRootfs = false; },
    value => { value.HostConfig.NetworkMode = 'bridge'; },
    value => { value.Mounts = [{ Type: 'volume' }]; }]) {
    const value = owned(); mutate(value);
    assert.throws(() => compatibleServerArgs(value, image, postgres, token));
  }
});

test('摘要包含三张观察表、报告、审计、Journal、默认及凭证配置；结构名称禁止 SQL 注入', () => {
  for (const name of ['ResearchObservation', 'ResearchObservationVersion', 'ResearchObservationSubmission',
    'AiRun', 'AiToolCall', 'JournalEntry', 'JournalReviewSnapshot', 'ProviderConfig', 'AiRoutingSettings'])
    assert(retentionSql.includes('"' + name + '"'));
  assert(retentionStructureSql(['ResearchObservationVersion']).includes('thesis_ledger_app'));
  assert.throws(() => retentionStructureSql(["x'); DROP TABLE x; --"]));
});

test('受控种子只接受登记样本；错误数据库在任何业务写入前拒绝并断开连接', async () => {
  let selected = false, disconnected = false;
  class WrongDatabase {
    async $queryRawUnsafe() { return [{ name: 'thesis_ledger', owner: 'thesis_ledger' }]; }
    aiRun = { findUniqueOrThrow() { selected = true; } };
    async $disconnect() { disconnected = true; }
  }
  await assert.rejects(() => seedObservationVersions({ assert, PrismaClient: WrongDatabase }, token));
  assert.equal(selected, false); assert.equal(disconnected, true);
  assert.throws(() => observationSeedProgram({ format: 'other' }));
  assert.throws(() => observationSeedProgram({ format: 'research-dual-read-fixtures-v1', cases: { shadow: { id: 'target-run' } } }));
  const script = observationSeedProgram({ format: 'research-dual-read-fixtures-v1', cases: { shadow: { id: token } } });
  assert(script.includes('restore_db')); assert(!script.includes('fetch('));
});

test('复用升级证据前核对源码 SQL、完整迁移清单及镜像回执，任一变化均拒绝', () => {
  const directory = mkdtempSync(join(tmpdir(), 'observation-upgrade-input-'));
  const name = '20261019020000_research_observation_versions';
  const migrations = join(directory, 'apps/server/prisma/migrations');
  mkdirSync(join(migrations, name), { recursive: true });
  const path = join(migrations, name, 'migration.sql'); writeFileSync(path, 'SELECT 1;');
  const imageInput = { migrations: [{ name, sql: 'SELECT 1;' }], currentHead: name,
    expectedTables: ['ResearchObservationVersion'] };
  try {
    assertUpgradeInput(imageInput, structuredClone(imageInput), directory);
    assert.throws(() => assertUpgradeInput(imageInput, { ...imageInput, currentHead: 'other' }, directory));
    writeFileSync(path, 'SELECT 2;'); assert.throws(() => assertUpgradeInput(imageInput, imageInput, directory));
    writeFileSync(path, 'SELECT 1;'); mkdirSync(join(migrations, '20261020000000_extra'));
    assert.throws(() => assertUpgradeInput(imageInput, imageInput, directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('清理查询失败不能冒充资源不存在；归属不符时禁止删除，仍检查其他自有角色', () => {
  const queries = [], removed = [];
  const run = args => {
    if (args[0] === 'ps') { queries.push(args.at(-1)); return Buffer.from(postgres); }
    if (args[0] === 'inspect') return Buffer.from(JSON.stringify([owned()]));
    removed.push(args); return Buffer.from('');
  };
  assert.throws(() => cleanupObservationResources({ token }, run));
  assert.equal(queries.length, 3); assert.equal(removed.length, 1); // 仅 server 的名称和角色匹配。
  assert.throws(() => cleanupObservationResources({ token }, () => { throw new Error('daemon unavailable'); }));
  assert.doesNotThrow(() => cleanupObservationResources({ token }, () => Buffer.from('')));
});
