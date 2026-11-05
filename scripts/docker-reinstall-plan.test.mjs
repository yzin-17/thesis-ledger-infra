import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planReinstall } from './docker-reinstall-plan.mjs';

const config = { name: 'thesis-ledger-dev', services: { dsa: {}, postgres: {} } };
const container = (service, mounts = []) => ({ Config: { Labels: {
  'com.docker.compose.project': config.name, 'com.docker.compose.service': service,
} }, Mounts: mounts });
const volume = (name, target, rw = true) => ({ Type: 'volume', Name: name, Destination: target, RW: rw });

test('所有实际卷均恢复，包括匿名日志卷和只读卷；绑定目录由原配置保留', () => {
  const result = planReinstall(config, [container('dsa', [volume('anonymous-log', '/app/logs'),
    volume('data', '/app/data', false), { Type: 'bind', Source: '/host/config', Destination: '/config' }])],
  ['anonymous-log', 'data', 'other-project-volume']);
  assert.deepEqual(result.services.dsa.volumes, [
    { type: 'volume', source: 'recovery_0', target: '/app/logs', read_only: false },
    { type: 'volume', source: 'recovery_1', target: '/app/data', read_only: true },
  ]);
  assert.deepEqual(result.volumes.recovery_0, { external: true, name: 'anonymous-log' });
  assert.deepEqual(result['x-thesis-ledger-recovery'].volumeNames, ['anonymous-log', 'data', 'other-project-volume']);
});
test('没有容器时仍保留全部现存卷', () => {
  assert.deepEqual(planReinstall(config, [], ['data']).volumes, {});
});
test('容器已删除后再次恢复仍继承原配置中的匿名卷映射', () => {
  const interrupted = { ...config, services: { dsa: { volumes: [
    { type: 'volume', source: 'saved_logs', target: '/app/logs' },
  ] } }, volumes: { saved_logs: { external: true, name: 'anonymous-log' } } };
  const result = planReinstall(interrupted, [], ['anonymous-log']);
  assert.equal(result.volumes[result.services.dsa.volumes[0].source].name, 'anonymous-log');
  assert.equal(result.services.dsa.volumes[0].target, '/app/logs');
  assert.throws(() => planReinstall(interrupted, [], []), /无法确认/);
});
test('生产目标、未知服务、重复实例及不完整挂载均拒绝', () => {
  assert.throws(() => planReinstall({ ...config, name: 'production' }, [], []));
  assert.throws(() => planReinstall(config, [container('other')], []));
  assert.throws(() => planReinstall(config, [container('dsa'), container('dsa')], []));
  assert.throws(() => planReinstall(config, [container('dsa', [volume('missing', '/data')])], []));
  assert.throws(() => planReinstall(config, [container('dsa', [volume('data', 'bad')])], ['data']));
  assert.throws(() => planReinstall(config, [{ Config: container('dsa').Config }], []));
});

test('真实只读 Compose 合并接回全部现存卷，原绑定目录保持',
  { skip: process.env.DOCKER_READONLY_ACCEPTANCE !== 'true' }, () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const context = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
    const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8' });
    const compose = ['compose', '--env-file', join(root, '.env'), '-f', join(root, 'compose.yml'), '-f', join(root, 'compose.dev.yml')];
    const original = JSON.parse(docker(...compose, 'config', '--format', 'json'));
    const recovery = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/docker-reinstall-plan.mjs')],
      { input: JSON.stringify(original), encoding: 'utf8', env: { ...process.env, DOCKER_CONTEXT: context } }));
    const dir = mkdtempSync(join(tmpdir(), 'docker-reinstall-compose-'));
    try {
      const override = join(dir, 'recovery.json');
      writeFileSync(override, JSON.stringify(recovery));
      const merged = JSON.parse(docker(...compose, '-f', override, 'config', '--format', 'json'));
      for (const [service, value] of Object.entries(recovery.services)) {
        for (const mount of value.volumes) {
          const actual = merged.services[service].volumes.find((item) => item.target === mount.target);
          assert.equal(merged.volumes[actual.source].name, recovery.volumes[mount.source].name);
          assert.equal(actual.read_only ?? false, mount.read_only);
        }
        for (const mount of original.services[service].volumes ?? []) {
          if (mount.type === 'bind') assert.deepEqual(merged.services[service].volumes.find((item) => item.target === mount.target), mount);
        }
      }
      assert(recovery['x-thesis-ledger-recovery'].volumeNames.length >= Object.keys(original.volumes).length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
