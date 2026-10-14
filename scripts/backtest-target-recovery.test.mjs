import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertContainer, assertOwnedRun } from './backtest-target-runtime.mjs';
import { assertPrivateCompose } from './backtest-production-compose-smoke.mjs';

test('目标身份、验收 Run 所有权与运行状态必须匹配', () => {
  const container = { Config: { Labels: { 'com.docker.compose.project': 'thesis-ledger-dev', 'com.docker.compose.service': 'backtest-worker' } }, State: { Running: true } };
  assertContainer(container, 'backtest-worker');
  assert.throws(() => assertContainer(container, 'redis'));
  assert.throws(() => assertContainer({ ...container, State: { Running: false } }, 'backtest-worker'));
  const row = { id: 'b272444b-e837-4c90-a097-084f64408c99', mode: 'V3', idempotencyKey: 't4-test' };
  assertOwnedRun(row, 't4-');
  assert.throws(() => assertOwnedRun({ ...row, idempotencyKey: 'existing' }, 't4-'));
  assert.throws(() => assertOwnedRun({ ...row, mode: 'V2' }, 't4-'));
  assert.throws(() => assertOwnedRun({ ...row, idempotencyKey: null }, 't4-'));
  assert.throws(() => assertContainer({ ...container, Config: { Labels: { ...container.Config.Labels, 'com.docker.compose.project': 'other' } } }, 'backtest-worker'));
});

test('隔离生产配置拒绝共享卷、固定端口和其他项目名称', () => {
  const project='thesis-ledger-t4-production-1234abcd';
  const config={volumes:{data:{name:`${project}-data`,external:false}},services:{'thesis-ledger':{ports:[{host_ip:'127.0.0.1',target:3000}]},'backtest-worker':{}}};
  assertPrivateCompose(config,project);
  assert.throws(()=>assertPrivateCompose({...config,volumes:{data:{name:'thesis-ledger-postgres-data',external:true}}},project));
  assert.throws(()=>assertPrivateCompose(config,'thesis-ledger-dev'));
  assert.throws(()=>assertPrivateCompose({...config,services:{...config.services,'thesis-ledger':{ports:[{host_ip:'127.0.0.1',target:3000,published:'3000'}]}}},project));
});

test('基础生产与开发 Compose 保持 Worker、同源镜像、快照及健康合同', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const image = `ghcr.io/yzin-17/thesis-ledger@sha256:${'0'.repeat(64)}`;
  for (const development of [false, true]) {
    const args = ['compose', '--env-file', '.env.example', '-f', 'compose.yml'];
    if (development) args.push('-f', 'compose.dev.yml');
    args.push('config', '--format', 'json');
    const config = JSON.parse(execFileSync('docker', args, {
      cwd, encoding: 'utf8', env: { ...process.env, THESIS_LEDGER_IMAGE: image },
    }));
    const server = config.services['thesis-ledger'], worker = config.services['backtest-worker'];
    assert.equal(worker.image, server.image);
    if (!development) assert.equal(worker.image, image);
    else assert.deepEqual(worker.build, server.build);
    assert.equal(worker.environment.NODE_ENV, 'production');
    assert.equal(server.environment.SERVER_BIND_HOST, '0.0.0.0');
    assert.equal(server.ports[0].host_ip, '127.0.0.1');
    assert.equal(worker.environment.BACKTEST_WORKER_CONCURRENCY, '1');
    assert.equal(worker.environment.DATABASE_URL, server.environment.DATABASE_URL);
    assert.equal(worker.environment.REDIS_URL, server.environment.REDIS_URL);
    assert.equal(worker.ports, undefined);
    assert.deepEqual(worker.command, ['node', 'apps/server/dist/src/backtest/backtest-worker.main.js']);
    assert.deepEqual(worker.healthcheck.test, ['CMD', 'node', 'apps/server/dist/src/backtest/backtest-worker-health.js']);
    assert.equal(worker.healthcheck.interval, '15s');
    const workerVolume = worker.volumes.find(v => v.target === '/app/var/backtest');
    assert.equal(workerVolume.source, server.volumes.find(v => v.target === '/app/var/backtest').source);
    assert.equal(config.volumes[workerVolume.source].external, true);
  }
});
