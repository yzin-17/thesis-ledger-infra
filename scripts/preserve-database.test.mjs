import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseUpdate, initializeEmptyVolumes } from './runtime/database.mjs';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture } from './fixtures/node-runtime.mjs';

test('数据库默认只检查，升级和重建需要精确目标及数据丢失确认', async t => {
  for (const [mode, target, allow, confirm, accepted] of [
    ['check', 'dsa', '', '', true], ['upgrade', 'thesis-ledger', '', 'thesis-ledger-dev/thesis_ledger', true],
    ['upgrade', 'dsa', '', 'thesis-ledger-dev/thesis_ledger', false],
    ['rebuild', 'all', '', 'thesis-ledger-dev/thesis_ledger', false],
    ['rebuild', 'all', 'true', 'wrong', false], ['rebuild', 'all', 'true', 'thesis-ledger-dev/thesis_ledger', true],
  ]) {
    const { runtime } = fixture(t, { env: { DEV_DATABASE_MODE: mode, DEV_DATABASE_ALLOW_DATA_LOSS: allow, DEV_DATABASE_CONFIRM: confirm } });
    await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, target);
    if (accepted) await db.initialize(); else await assert.rejects(db.initialize());
  }
});

test('SQL 生成失败不连接数据库；check 失败不启动应用；消费者停止失败不执行升级', async t => {
  for (const failure of ['generate', 'execute', 'stop']) {
    const { runtime, state } = fixture(t, { sqlGenerationFailure: failure === 'generate', sqlFailure: failure === 'execute', stopFailure: failure === 'stop',
      env: { DEV_DATABASE_MODE: failure === 'stop' ? 'upgrade' : 'check', DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger' } });
    await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, 'thesis-ledger'); await db.initialize();
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'thesis-ledger' });
    try {
      await build.configuration(); await assert.rejects(db.prepare(build));
      if (failure === 'generate') assert(!state.calls.some(args => args.includes('exec') && args.includes('postgres')));
      if (failure === 'stop') assert(!state.calls.some(args => args.includes('pnpm')));
      assert(!state.calls.some(args => args.includes('up') && args.includes('backtest-worker')));
    } finally { db.cleanup(); await build.cleanup(); }
  }
});

test('显式不备份必须使用开发upgrade、精确目标及摘要，错误参数在停止消费者前拒绝', async t => {
  for (const [mode, flag, digest, accepted] of [
    ['upgrade', 'true', 'a'.repeat(64), true], ['check', 'true', 'a'.repeat(64), false],
    ['upgrade', 'true', '', false], ['upgrade', 'invalid', 'a'.repeat(64), false],
  ]) {
    const { runtime, state } = fixture(t, { env: { DEV_DATABASE_MODE: mode, DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger',
      DEV_DATABASE_UPGRADE_NO_BACKUP: flag, DEV_DATABASE_UPGRADE_MIGRATION_SHA256: digest } });
    state.config.services.postgres.environment.POSTGRES_USER = 'thesis_ledger';
    await runtime.connect(); runtime.configureCompose();
    const initialize = async () => { const db = new DatabaseUpdate(runtime, 'thesis-ledger'); await db.initialize(); };
    if (accepted) await initialize(); else await assert.rejects(initialize());
    assert(!state.calls.some(args => args.includes('stop')));
  }
});

test('不备份升级事务后必须核验摘要；核验失败不得启动消费者', async t => {
  for (const verificationFailure of [false, true]) {
    let preparations = 0;
    const { runtime, state, temporary } = fixture(t, { env: { DEV_DATABASE_MODE: 'upgrade',
      DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger', DEV_DATABASE_UPGRADE_NO_BACKUP: 'true',
      DEV_DATABASE_UPGRADE_MIGRATION_SHA256: 'a'.repeat(64) },
    intercept: (binary, args, options, fail) => {
      if (binary === 'pnpm' && ++preparations === 2 && verificationFailure) fail();
    } });
    state.config.services.postgres.environment.POSTGRES_USER = 'thesis_ledger';
    runtime.env.DATABASE_UPGRADE_BACKUP_ROOT = join(temporary, 'evidence');
    await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, 'thesis-ledger');
    await db.initialize(); const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'thesis-ledger' });
    try {
      await build.configuration();
      if (verificationFailure) await assert.rejects(db.prepare(build)); else await db.prepare(build);
      assert.equal(preparations, 2);
      const transactions = state.calls.filter(args => args.includes('exec') && args.includes('postgres'));
      assert.equal(transactions.length, verificationFailure ? 1 : 2);
      assert(!state.calls.some(args => args.includes('up') && args.includes('backtest-worker')));
    } finally { db.cleanup(); await build.cleanup(); }
  }
});

test('空卷初始化保持精确集合、确认与部分重试归属', async t => {
  const { runtime, state } = fixture(t, { env: { INITIALIZE_EMPTY_DEV_VOLUMES: 'true', EMPTY_DEV_CONFIRM: 'thesis-ledger-dev/thesis_ledger' } });
  await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, 'all'); await db.initialize();
  state.volumes.delete('thesis-ledger-backtest-data');
  await initializeEmptyVolumes(runtime, db);
  assert.equal(state.calls.filter(args => args.includes('volume') && args.includes('create')).length, 1);
  state.volumes.delete('thesis-ledger-backtest-data'); state.volumes.set('other-volume', 'true');
  await assert.rejects(initializeEmptyVolumes(runtime, db));
  assert.equal(state.calls.filter(args => args.includes('volume') && args.includes('create')).length, 1);
});

test('保留数据升级先准备私有证据再执行事务，准备和事务失败均不启动消费者', async t => {
  for (const failure of ['', 'prepare', 'transaction']) {
    const { runtime, state, temporary } = fixture(t, { upgradePrepareFailure: failure === 'prepare', sqlFailure: failure === 'transaction',
      env: { DEV_DATABASE_MODE: 'upgrade', DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger' } });
    runtime.env.DATABASE_UPGRADE_BACKUP_ROOT = join(temporary, 'backups');
    await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, 'all'); await db.initialize();
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'all' });
    try {
      await build.configuration();
      if (failure) await assert.rejects(db.prepare(build)); else await db.prepare(build);
      const prepared = state.calls.findIndex(args => args[0] === 'pnpm');
      const stopped = state.calls.findIndex(args => args.includes('stop'));
      const transactions = state.calls.filter(args => args.includes('exec') && args.includes('postgres'));
      assert(stopped >= 0 && prepared > stopped);
      assert.equal(transactions.length, failure === 'prepare' ? 0 : failure ? 1 : 2);
      assert(!state.calls.some(args => args.includes('up') && args.includes('backtest-worker')));
      const { readdirSync } = await import('node:fs');
      const directory = join(runtime.env.DATABASE_UPGRADE_BACKUP_ROOT, readdirSync(runtime.env.DATABASE_UPGRADE_BACKUP_ROOT)[0]);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, 'image-input.json')).mode & 0o777, 0o600);
      if (failure !== 'prepare') assert.match(readFileSync(join(directory, 'execute.log'), 'utf8'), failure ? /失败/ : /成功/);
    } finally { db.cleanup(); await build.cleanup(); }
  }
});
