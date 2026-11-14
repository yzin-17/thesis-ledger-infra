import assert from 'node:assert/strict';
import { test } from 'vitest';
import { LocalDocker } from './runtime/docker.mjs';
import { DatabaseUpdate } from './runtime/database.mjs';
import { BuildPlan } from './runtime/build.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { fixture } from './fixtures/node-runtime.mjs';

test('真实只读 Compose 配置保留服务、共享卷、健康和最小权限', async () => {
  const runtime = new LocalDocker({ env: { ...process.env, ENV_FILE: '.env.example' } });
  runtime.configureCompose(); await runtime.connect();
  const config = JSON.parse(await runtime.compose(['config', '--format', 'json']));
  assert.deepEqual(Object.keys(config.services).sort(), ['backtest-worker', 'dsa', 'postgres', 'redis', 'thesis-ledger']);
  const server = config.services['thesis-ledger'], worker = config.services['backtest-worker'];
  assert.equal((worker.ports ?? []).length, 0); assert(worker.healthcheck.test.length > 0);
  assert(config.services.postgres.healthcheck.test.some(value => value.includes('pg_isready')));
  const shared = server.volumes.find(mount => mount.target === '/app/var/backtest');
  assert(shared && worker.volumes.some(mount => mount.target === shared.target
    && config.volumes[mount.source].name === config.volumes[shared.source].name));
  assert.equal(config.volumes[shared.source].external, true);
  assert.equal(server.environment.POSTGRES_OWNER_USER, undefined);
  assert.notEqual(new URL(server.environment.DATABASE_URL).username, config.services.postgres.environment.POSTGRES_USER);
});

test('PostgreSQL 启动或就绪失败时不停止消费者，不执行结构 SQL', async t => {
  for (const options of [{ startFailure: true }, { pgExited: true }]) {
    const { runtime, state } = fixture(t, { ...options, env: { DEV_DATABASE_MODE: 'rebuild', DEV_DATABASE_ALLOW_DATA_LOSS: 'true', DEV_DATABASE_CONFIRM: 'thesis-ledger-dev/thesis_ledger' } });
    await runtime.connect(); runtime.configureCompose(); const db = new DatabaseUpdate(runtime, 'all'); await db.initialize();
    const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'all' });
    try {
      await build.configuration(); await assert.rejects(db.prepare(build));
      assert(!state.calls.some(args => args.includes('stop') || args.some(value => value.startsWith('DEV_DATABASE_MODE='))));
    } finally { db.cleanup(); await build.cleanup(); }
  }
});
