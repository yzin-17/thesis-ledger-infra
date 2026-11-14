import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { imageIdPattern, selectedImages } from './options.mjs';

export function sizeKiB(value) {
  if (!/^[0-9]+(?:\.[0-9]+)?(?:[bBkKmMgGtT]|[kKmMgGtT][bB])?$/.test(value)) throw new Error(`非法容量参数: ${value}`);
  const [, amount, suffix] = value.match(/^([0-9.]+)(.*)$/);
  const factor = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[suffix.toLowerCase().charAt(0)];
  const result = Math.round(Number(amount) * factor / 1024);
  if (!Number.isSafeInteger(result)) throw new Error('容量参数超出范围。');
  return result;
}
export function availableKiB(text) {
  const rows = text.trim().split('\n').slice(1).filter(line => line.trim());
  const values = rows.map(line => line.trim().split(/\s+/)[3]);
  if (!values.length || values.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('无法读取实际空闲空间。');
  return Math.min(...values.map(Number));
}

export class BuildSpace {
  constructor(runtime, { target = 'all', repair = true, platform = process.platform } = {}) {
    this.runtime = runtime; this.target = target; this.repair = repair; this.platform = platform;
    const env = runtime.env;
    this.max = env.BUILD_CACHE_MAX_USED_SPACE ?? '8gb'; this.reserved = env.BUILD_CACHE_RESERVED_SPACE ?? '4gb';
    this.min = env.BUILD_CACHE_MIN_FREE_SPACE ?? '18gb';
    this.minimum = sizeKiB(this.min); this.hostMinimum = sizeKiB(env.BUILD_HOST_MIN_FREE_SPACE ?? '20gb');
    sizeKiB(this.max); sizeKiB(this.reserved);
    if (this.minimum < 1 || this.hostMinimum < 1) throw new Error('宿主机和 Docker 清理参考目标必须大于零。');
    const desktopData = join(env.HOME || homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data');
    this.hostPath = env.BUILD_SPACE_HOST_PATH ? resolve(runtime.root, env.BUILD_SPACE_HOST_PATH) : (existsSync(desktopData) ? desktopData : runtime.root);
    if (!existsSync(this.hostPath)) throw new Error('宿主机空间检查路径不存在。');
    this.completed = new Map(); this.probe = ''; this.reinstalled = false;
  }
  async initialize() {
    await this.runtime.requireLocalBuilder();
    const candidates = [...selectedImages(this.target).map(([, alias]) => alias), 'node:24-alpine', 'postgres:17-alpine'];
    for (const reference of candidates) {
      try {
        const id = (await this.runtime.docker(['image', 'inspect', '--format', '{{.Id}}', reference])).trim();
        if (imageIdPattern.test(id)) { this.probe = id; break; }
      } catch { /* 只选择已有镜像，不能在测量前隐式下载。 */ }
    }
    if (!this.probe && this.runtime.env.BOOTSTRAP_SPACE_PROBE !== 'true') throw new Error('空间探针没有可用本地基础镜像。');
  }
  async prepareProbe() {
    if (this.probe) return;
    const runtime = this.runtime;
    await runtime.idle();
    const inventory = (await runtime.docker(['info', '--format', '{{.Containers}} {{.Images}}'])).trim();
    const volumes = (await runtime.docker(['volume', 'ls', '-q'])).trim();
    if (runtime.env.BOOTSTRAP_SPACE_PROBE !== 'true' || inventory !== '0 0' || volumes) throw new Error('首次探针初始化仅允许没有容器、镜像和卷的空环境。');
    if (availableKiB(await runtime.run('df', ['-Pk', runtime.root, this.hostPath], { env: { ...runtime.env, LC_ALL: 'C' } })) <= 0) throw new Error('首次探针下载前宿主机无可用空间。');
    await runtime.docker(['pull', 'node:24-alpine'], { stream: true });
    this.probe = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', 'node:24-alpine'])).trim();
    if (!imageIdPattern.test(this.probe)) throw new Error('空间探针身份无效。');
  }
  async measure() {
    const runtime = this.runtime;
    this.hostAvailable = availableKiB(await runtime.run('df', ['-Pk', runtime.root, this.hostPath], { env: { ...runtime.env, LC_ALL: 'C' } }));
    this.dockerAvailable = availableKiB(await runtime.docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--entrypoint', 'df', this.probe, '-Pk', '/']));
    runtime.log(`空间实测：宿主机 ${Math.floor(this.hostAvailable / 1024)} MiB，Docker ${Math.floor(this.dockerAvailable / 1024)} MiB；参考 ${Math.floor(this.hostMinimum / 1024)}/${Math.floor(this.minimum / 1024)} MiB。`);
  }
  sufficient() { return this.hostAvailable >= this.hostMinimum && this.dockerAvailable >= this.minimum; }
  positive() { return this.hostAvailable > 0 && this.dockerAvailable > 0; }
  async maintain(phase) {
    if (!this.repair) return;
    await this.runtime.idle();
    this.runtime.log(`${phase}：维护 BuildKit cache（最大 ${this.max}，保留底线 ${this.reserved}）...`);
    await this.runtime.docker(['buildx', 'prune', '--builder', this.runtime.context, '--all', '--force',
      '--max-used-space', this.max, '--min-free-space', this.min, '--reserved-space', this.reserved], { stream: true });
  }
  async releaseIntermediates(service) {
    if (!this.repair) return;
    await this.runtime.idle();
    this.runtime.log(`${service} 已构建：回收普通中间层，保留依赖缓存。`);
    await this.runtime.docker(['buildx', 'prune', '--builder', this.runtime.context, '--all', '--force', '--filter', 'type!=exec.cachemount'], { stream: true });
  }
  async repairImages(allUnused = false) {
    const runtime = this.runtime, args = [join(runtime.root, 'scripts/docker-space-images.mjs'), allUnused ? 'all' : this.target, '--apply', '--lock-owner', String(process.pid), '--protect', this.probe];
    for (const id of [runtime.env.REUSE_DSA_IMAGE_ID, runtime.env.REUSE_THESIS_LEDGER_IMAGE_ID, ...this.completed.values()].filter(Boolean)) args.push('--protect', id);
    if (allUnused) args.push('--all-unused');
    await runtime.run(process.execPath, args, { env: runtime.env, stream: true });
  }
  async reclaim() {
    const runtime = this.runtime;
    if (this.platform !== 'darwin' || !existsSync(join(this.hostPath, 'Docker.raw'))) return;
    if (!(await runtime.docker(['info', '--format', '{{.OperatingSystem}}'])).startsWith('Docker Desktop')) return;
    const image = 'docker/desktop-reclaim-space@sha256:8b26e45c51632fd78131f3bddca76122bebc1dd8376f16dd26f769c7f33121fd';
    await runtime.idle();
    try { await runtime.docker(['image', 'inspect', image]); }
    catch { await runtime.docker(['pull', image], { stream: true }); }
    await runtime.idle();
    await runtime.docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--privileged', '--pid=host', '--platform', 'linux/amd64', image], { stream: true });
  }
  async ensure(phase) {
    await this.runtime.idle(); await this.maintain(phase); await this.measure();
    if (this.sufficient()) return;
    if (this.repair) {
      await this.repairImages(); await this.measure();
      if (this.sufficient()) return;
      await this.reclaim(); await this.measure();
      if (this.sufficient()) return;
    }
    if (this.positive()) { this.runtime.log('未达到参考目标，实测仍有余量；继续构建。'); return; }
    throw Object.assign(new Error('实际可用空间为零，需要保卷恢复。'), { code: 76 });
  }
  async finalize() {
    if (!this.repair) return;
    await this.maintain('健康后占用收敛'); await this.measure();
    if (!this.sufficient()) { await this.reclaim(); await this.measure(); }
    this.runtime.log('本轮更新完成；未达参考目标不会重建健康服务。');
  }
}
