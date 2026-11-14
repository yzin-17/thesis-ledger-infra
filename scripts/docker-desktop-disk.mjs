import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export function readSettings(path, target) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('设置文件不能是符号链接。');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const current = data.DiskSizeMiB;
  if (!Number.isSafeInteger(current) || current <= 0) throw new Error('现有 DiskSizeMiB 缺失或非法。');
  if (!Number.isSafeInteger(target) || target % 1024 !== 0 || target < current) throw new Error('容量必须为整 GiB，且禁止缩小现有虚拟盘。');
  return { data, current };
}

export function extendSettings(path, target, expected, backupDirectory) {
  const { data, current } = readSettings(path, target);
  if (!isDeepStrictEqual(data, expected)) throw new Error('停止期间设置已变化，未覆盖并发修改。');
  mkdirSync(backupDirectory, { recursive: true });
  const metadata = statSync(path);
  const temporary = mkdtempSync(join(dirname(path), '.docker-capacity-'));
  const backup = join(backupDirectory, `docker-desktop-settings-${Date.now()}-${temporary.split('-').at(-1)}.json`);
  copyFileSync(path, backup); chmodSync(backup, 0o600); utimesSync(backup, metadata.atime, metadata.mtime);
  const replacement = join(temporary, 'settings.json');
  let descriptor;
  try {
    descriptor = openSync(replacement, 'wx', metadata.mode & 0o777);
    writeFileSync(descriptor, JSON.stringify({ ...data, DiskSizeMiB: target }, null, 2) + '\n');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    chmodSync(replacement, metadata.mode & 0o777);
    renameSync(replacement, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
  return { current, target, backup };
}

async function inventory(runtime) {
  const commands = {
    images: ['image', 'ls', '-aq', '--no-trunc'], containers: ['container', 'ls', '-aq', '--no-trunc'],
    volumes: ['volume', 'ls', '--format', '{{.Name}}'],
  };
  const result = {};
  for (const [key, args] of Object.entries(commands)) result[key] = [...new Set((await runtime.docker(args)).trim().split('\n').filter(Boolean))].sort();
  return result;
}

export async function extendDisk(runtime, target, home = homedir()) {
  const settings = join(home, 'Library/Group Containers/group.com.docker/settings-store.json');
  const raw = join(home, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
  const { data, current } = readSettings(settings, target);
  if (target === current) { runtime.log('容量已经符合目标，无需停止 Docker Desktop。'); return; }
  if (runtime.env.DOCKER_HOST || runtime.env.BUILDX_BUILDER) throw new Error('移除 DOCKER_HOST/BUILDX_BUILDER 后再扩展本地 Desktop。');
  await runtime.connect();
  if (runtime.context !== 'desktop-linux') throw new Error('只允许当前本地 desktop-linux context。');
  return runtime.locked(async () => {
    await runtime.idle();
    const before = await inventory(runtime), original = statSync(raw);
    await runtime.docker(['desktop', 'stop', '--timeout', '45']);
    let result;
    try { result = extendSettings(settings, target, data, join(runtime.root, '.maintenance-backups/docker-desktop')); }
    finally { await runtime.docker(['desktop', 'start', '--timeout', '45'], { cleanup: true }); }
    await runtime.docker(['info']);
    const final = statSync(raw);
    if (final.ino !== original.ino || final.size < target * 1024 ** 2) throw new Error('虚拟盘身份或容量未通过检查；禁止自动缩盘。');
    if (!isDeepStrictEqual(await inventory(runtime), before)) throw new Error('资源清单变化，停止后续部署。');
    runtime.log(`容量配置：${current} → ${target} MiB；备份：${result.backup}`);
    runtime.log(`扩展验收通过：虚拟盘 ${target / 1024} GiB；镜像、容器、卷全部保留。`);
    return result;
  });
}
