import { pathToFileURL } from 'node:url';
import { LocalDocker } from './runtime/docker.mjs';

const services = new Set(['dsa', 'thesis-ledger', 'backtest-worker', 'postgres', 'redis']);

/** 重装必须把匿名卷也显式接回去；只输出恢复配置，不读写卷内数据。 */
export function planReinstall(config, containers, volumeNames) {
  if (config.name !== 'thesis-ledger-dev') throw new Error('仅允许本项目开发环境保卷重装');
  const knownVolumes = new Set(volumeNames);
  const result = { services: {}, volumes: {}, 'x-thesis-ledger-recovery': { volumeNames } };
  const seen = new Set();
  let index = 0;
  const restoreMount = (name, target, readOnly) => {
    if (!knownVolumes.has(name) || typeof target !== 'string' || !target.startsWith('/') ||
        typeof readOnly !== 'boolean') throw new Error('无法确认现存卷挂载');
    const key = `recovery_${index++}`;
    result.volumes[key] = { external: true, name };
    return { type: 'volume', source: key, target, read_only: readOnly };
  };
  // 上一次已 down 后可能没有容器；原恢复配置中的匿名卷映射仍必须保留。
  for (const [service, definition] of Object.entries(config.services ?? {})) {
    if (!services.has(service)) throw new Error('配置包含未知开发服务');
    const mounts = (definition.volumes ?? []).filter((mount) => mount.type === 'volume').map((mount) =>
      restoreMount(config.volumes?.[mount.source]?.name, mount.target, mount.read_only ?? false));
    if (mounts.length) result.services[service] = { volumes: mounts };
  }
  for (const container of containers) {
    const labels = container.Config?.Labels ?? {};
    const service = labels['com.docker.compose.service'];
    if (labels['com.docker.compose.project'] !== config.name || !services.has(service) || !config.services?.[service]) {
      throw new Error('容器不属于已知开发服务');
    }
    if (seen.has(service)) throw new Error('存在同服务多个容器，不能确定恢复挂载');
    seen.add(service);
    if (!Array.isArray(container.Mounts)) throw new Error('挂载信息缺失');
    const mounts = [];
    for (const mount of container.Mounts) {
      if (mount.Type !== 'volume') continue;
      if (typeof mount.RW !== 'boolean') throw new Error('无法确认现存卷挂载');
      mounts.push(restoreMount(mount.Name, mount.Destination, !mount.RW));
    }
    result.services[service] = { volumes: mounts };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const config = JSON.parse(input);
    const context = process.env.DOCKER_CONTEXT;
    if (!context) throw new Error('缺少已验证 Docker context');
    const runtime = new LocalDocker().connectSync();
    if (runtime.context !== context) throw new Error('Docker context 发生变化');
    const docker = (...args) => runtime.dockerSync(args, { maxBuffer: 16 * 1024 * 1024 }).trim();
    const ids = docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${config.name}`).split('\n').filter(Boolean);
    const containers = ids.length ? JSON.parse(docker('container', 'inspect', ...ids)) : [];
    const volumes = docker('volume', 'ls', '-q').split('\n').filter(Boolean);
    console.log(JSON.stringify(planReinstall(config, containers, volumes), null, 2));
  } catch (error) { console.error(`保卷恢复计划失败: ${error.message}`); process.exitCode = 1; }
}
