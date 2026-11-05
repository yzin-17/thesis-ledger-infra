import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = 'thesis-ledger-dev-thesis-ledger-1';
export function restartPlan(args) {
  const values = new Map();
  for (const arg of args) {
    const pair = /^(--confirm|--image)=(.+)$/.exec(arg);
    const key = pair?.[1] ?? arg;
    assert(pair || arg === '--apply', '未知或缺值选项');
    assert(!values.has(key), '重复选项'); values.set(key, pair?.[2] ?? true);
  }
  assert.equal(values.get('--confirm'), 'thesis-ledger-dev/thesis-ledger', '须确认开发Server精确目标');
  assert.match(values.get('--image') ?? '', /^sha256:[a-f0-9]{64}$/, '须确认当前完整镜像ID');
  return { mode: values.has('--apply') ? 'apply' : 'plan', image: values.get('--image'), name };
}

export function serverIdentity(value, image) {
  assert.equal(value.Name, '/' + name);
  assert.equal(value.Config.Labels['com.docker.compose.project'], 'thesis-ledger-dev');
  assert.equal(value.Config.Labels['com.docker.compose.service'], 'thesis-ledger');
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Image, image, '当前镜像与确认不符');
  assert(value.Mounts.some(m => m.Type === 'volume' && m.Name === 'thesis-ledger-backtest-data' && m.Destination === '/app/var/backtest' && m.RW));
  return { id: value.Id, image: value.Image, mounts: value.Mounts.map(({ Type, Name, Source, Destination, RW }) =>
    ({ Type, Name, Source, Destination, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) };
}

export async function main(args = process.argv.slice(2)) {
  const plan = restartPlan(args);
  if (plan.mode === 'plan') return { ...plan, writes: false, action: '仅重启同一Server容器，保留镜像和挂载' };
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER, '不允许覆盖Docker端点');
  const run = (cmd, argv, input) => execFileSync(cmd, argv, { input, encoding: 'utf8', timeout: 45_000, maxBuffer: 200_000 }).trim();
  const docker = (...argv) => run('docker', argv);
  assert.equal(docker('context', 'show'), 'desktop-linux');
  const endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}');
  assert(endpoint.startsWith('unix://'), '仅允许原本地Unix端点');
  const checksum = run('cksum', [], endpoint).split(/\s+/)[0];
  const lock = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
  mkdirSync(lock);
  try {
    const inspect = () => JSON.parse(docker('inspect', name))[0];
    const before = inspect(), identity = serverIdentity(before, plan.image);
    assert(before.State.Running && before.State.Health?.Status === 'healthy', '重启前Server必须健康');
    assert.deepEqual(serverIdentity(inspect(), plan.image), identity, '执行前身份变化');
    docker('restart', '--time', '30', identity.id);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = inspect();
      assert.deepEqual(serverIdentity(current, plan.image), identity, '重启后镜像/容器/挂载变化');
      if (current.State.Running && current.State.Health?.Status === 'healthy' && current.State.StartedAt !== before.State.StartedAt) {
        return { status: 'healthy', ...identity, startedAt: current.State.StartedAt, restarted: true };
      }
      assert(current.State.Running, '重启后容器未运行；停止，不自动重试');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('重启后60秒内未就绪；停止，不自动重试');
  } finally { rmdirSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await main(), null, 2));
