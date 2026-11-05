import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = 'thesis-ledger-dev';
const phases = [['postgres', 'redis'], ['dsa'], ['thesis-ledger', 'backtest-worker']];
const volumes = { postgres: ['thesis-ledger-postgres-data', '/var/lib/postgresql/data'],
  redis: ['thesis-ledger-redis-data', '/data'], dsa: ['thesis-ledger-dsa-data', '/app/data'],
  'thesis-ledger': ['thesis-ledger-backtest-data', '/app/var/backtest'],
  'backtest-worker': ['thesis-ledger-backtest-data', '/app/var/backtest'] };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 200_000 }).trim();

export function existingPlan(containers) {
  assert.equal(containers.length, 5, '需完整核对五个既有服务');
  return phases.flat().map((service) => {
    const matches = containers.filter((item) => item.Name === `/${project}-${service}-1`);
    assert.equal(matches.length, 1, `${service}容器缺失或身份重复`);
    const item = matches[0], labels = item.Config.Labels;
    assert.equal(labels['com.docker.compose.project'], project);
    assert.equal(labels['com.docker.compose.service'], service);
    assert(['exited', 'running'].includes(item.State.Status), `${service}状态不允许恢复`);
    assert.match(item.Id, /^[a-f0-9]{64}$/);
    assert.match(item.Image, /^sha256:[a-f0-9]{64}$/);
    const [name, destination] = volumes[service];
    assert(item.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === name && mount.Destination === destination), `${service}持久卷不匹配`);
    const mounts = item.Mounts.map(({ Type, Name, Source, Destination }) => ({ Type, Name, Source, Destination }));
    // Docker inspect 的挂载集合顺序可能变化，身份仍按全部挂载字段精确核对。
    mounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { service, id: item.Id, image: item.Image, mounts };
  });
}

export async function resumePlan(plan, run = docker, sleep = delay) {
  const inspect = () => existingPlan(JSON.parse(run('inspect', ...plan.map((item) => item.id))));
  assert.deepEqual(inspect(), plan, '执行前容器身份变化');
  for (const phase of phases) {
    for (const service of phase) {
      const item = plan.find((entry) => entry.service === service);
      const state = JSON.parse(run('inspect', item.id))[0].State;
      if (state.Status === 'exited') run('start', item.id);
      else assert.equal(state.Status, 'running');
    }
    const deadline = Date.now() + 90_000;
    while (true) {
      const current = JSON.parse(run('inspect', ...phase.map((service) => plan.find((item) => item.service === service).id)));
      assert(current.every((item) => item.State.Status === 'running'), '恢复中的服务退出，停止后续启动');
      if (current.every((item) => item.State.Health?.Status === 'healthy')) break;
      assert(current.every((item) => item.State.Health?.Status !== 'unhealthy'), '服务不健康，停止后续启动');
      assert(Date.now() < deadline, '等待原服务健康超时');
      await sleep(2000);
    }
  }
  assert.deepEqual(inspect(), plan, '恢复后容器/镜像/卷身份变化');
  return { project, status: 'healthy', containers: plan };
}

export async function main(args = process.argv.slice(2)) {
  assert.deepEqual(args, [`--confirm=${project}`], '仅允许明确恢复既有开发目标');
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  assert.equal(docker('context', 'show'), 'desktop-linux');
  const endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}');
  assert(endpoint.startsWith('unix://'));
  // 与既有更新入口使用同一锁，防止恢复与更新并发。
  const checksum = execFileSync('cksum', { input: endpoint, encoding: 'utf8' }).split(/\s+/)[0];
  const lock = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
  mkdirSync(lock);
  try {
    const plan = existingPlan(JSON.parse(docker('inspect', ...phases.flat().map((service) => `${project}-${service}-1`))));
    return await resumePlan(plan);
  } finally { rmdirSync(lock); }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await main()));
