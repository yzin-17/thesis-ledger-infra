import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalDocker, waitForHealth } from './runtime/docker.mjs';
import { switchedDataVolume } from './runtime/state-switch-layout.mjs';

const project = 'thesis-ledger-dev';
const phases = [['postgres', 'redis'], ['dsa'], ['thesis-ledger', 'backtest-worker']];
const volumes = { postgres: ['thesis-ledger-postgres-data', '/var/lib/postgresql/data'],
  redis: ['thesis-ledger-redis-data', '/data'], dsa: ['thesis-ledger-dsa-data', '/app/data'],
  'thesis-ledger': ['thesis-ledger-backtest-data', '/app/var/backtest'],
  'backtest-worker': ['thesis-ledger-backtest-data', '/app/var/backtest'] };

export function existingPlan(containers, layout = volumes) {
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
    const [name, destination] = layout[service];
    assert(item.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === name && mount.Destination === destination), `${service}持久卷不匹配`);
    const mounts = item.Mounts.map(({ Type, Name, Source, Destination }) => ({ Type, Name, Source, Destination }));
    // Docker inspect 的挂载集合顺序可能变化，身份仍按全部挂载字段精确核对。
    mounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { service, id: item.Id, image: item.Image, mounts };
  });
}

export async function resumePlan(plan, run, sleep = delay, { storageOnly = false, layout = volumes } = {}) {
  assert.equal(typeof run, 'function', '需要已固定 context 的 Docker 执行器');
  const inspect = () => existingPlan(JSON.parse(run('inspect', ...plan.map((item) => item.id))), layout);
  assert.deepEqual(inspect(), plan, '执行前容器身份变化');
  for (const phase of storageOnly ? [phases[0]] : phases) {
    for (const service of phase) {
      const item = plan.find((entry) => entry.service === service);
      const state = JSON.parse(run('inspect', item.id))[0].State;
      if (state.Status === 'exited') run('start', item.id);
      else assert.equal(state.Status, 'running');
    }
    await waitForHealth(async () => {
      const current = JSON.parse(run('inspect', ...phase.map(service => plan.find(item => item.service === service).id)));
      assert.equal(current.length, phase.length, '恢复中的容器缺失');
      return current.map(item => ({ status: item.State.Status, health: item.State.Health?.Status ?? 'none' }));
    }, { seconds: 90, failUnhealthy: true, requireContainer: true, sleep });
  }
  assert.deepEqual(inspect(), plan, '恢复后容器/镜像/卷身份变化');
  return { project, status: storageOnly ? 'storage_healthy' : 'healthy', containers: plan };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const storageOnly = args[1] === '--storage-only';
  assert.deepEqual(args, [`--confirm=${project}`, ...(storageOnly ? ['--storage-only'] : [])], '仅允许明确恢复既有开发目标');
  const runtime = await new LocalDocker(dependencies).connect();
  assert(!runtime.env.BUILDX_BUILDER); assert.equal(runtime.context, 'desktop-linux');
  const docker = (...args) => runtime.dockerSync(args).trim();
  return runtime.locked(async () => {
    const layout = Object.fromEntries(Object.entries(volumes).map(([service, [name, destination]]) =>
      [service, [switchedDataVolume(runtime.root, service, destination, name), destination]]));
    const plan = existingPlan(JSON.parse(docker('inspect', ...phases.flat().map((service) => `${project}-${service}-1`))), layout);
    return resumePlan(plan, docker, delay, { storageOnly, layout });
  });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await main()));
