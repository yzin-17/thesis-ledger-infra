import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRunner, createSyncRunner } from './process.mjs';
import { ownsUpdateLock, UpdateLock, updateLockPath } from './lock.mjs';
import { environmentFile, infraRoot, positiveInteger } from './options.mjs';

export async function waitForHealth(readStates, { seconds = 120, allowNoHealth = false, failUnhealthy = false,
  requireContainer = false, sleep = ms => new Promise(done => setTimeout(done, ms)), interval = 2000, signal } = {}) {
  positiveInteger(seconds, '健康检查超时');
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const states = await readStates();
    if (requireContainer && !states.length) throw new Error('容器缺失。');
    if (states.some(state => ['exited', 'dead'].includes(state.status))) throw new Error('服务未能运行。');
    if (failUnhealthy && states.some(state => state.health === 'unhealthy')) throw new Error('服务不健康。');
    if (!allowNoHealth && states.some(state => state.health === 'none')) throw new Error('服务缺少健康检查。');
    if (states.length && states.every(state => state.status === 'running' && (state.health === 'healthy' || allowNoHealth && state.health === 'none'))) return states;
    await sleep(interval);
  }
  throw new Error(`等待服务健康检查超时 (${seconds}s)。`);
}

export class LocalDocker {
  constructor({ root = infraRoot, env = process.env, signal, run, runSync, log = console.log, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
    this.root = root; this.env = { ...env }; this.run = run ?? createRunner({ env, signal }); this.log = log; this.sleep = sleep;
    this.cleanupRun = run ?? createRunner({ env });
    this.syncRun = runSync ?? createSyncRunner({ env });
    this.signal = signal; this.files = []; this.context = ''; this.lockPath = '';
  }
  validateContext(context, endpoint) {
    if (!context || !endpoint.startsWith('unix://') || this.env.DOCKER_HOST) throw new Error('仅支持当前本地 Unix Docker context；禁止 DOCKER_HOST 覆盖。');
  }
  setConnection(context, endpoint, checksum) {
    this.context = context; this.endpoint = endpoint;
    this.lockPath = updateLockPath(checksum.trim().split(/\s+/)[0], this.env);
    this.lock = new UpdateLock(this.lockPath); this.env.DOCKER_CONTEXT = context;
    return this;
  }
  async connect() {
    this.context = (await this.run('docker', ['context', 'show'])).trim();
    const endpoint = (await this.run('docker', ['context', 'inspect', this.context, '--format', '{{.Endpoints.docker.Host}}'])).trim();
    this.validateContext(this.context, endpoint);
    return this.setConnection(this.context, endpoint, await this.run('cksum', [], { input: endpoint }));
  }
  connectSync() {
    const context = this.syncRun('docker', ['context', 'show']).trim();
    const endpoint = this.syncRun('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
    this.validateContext(context, endpoint);
    return this.setConnection(context, endpoint, this.syncRun('cksum', [], { input: endpoint }));
  }
  dockerSync(args, options = {}) {
    if (!this.context) throw new Error('Docker context 尚未确认。');
    return this.syncRun('docker', ['--context', this.context, ...args], { ...options, env: { ...this.env, ...options.env } });
  }
  docker(args, { cleanup = false, ...options } = {}) {
    if (!this.context) throw new Error('Docker context 尚未确认。');
    return (cleanup ? this.cleanupRun : this.run)('docker', ['--context', this.context, ...args], { ...options, env: { ...this.env, ...options.env } });
  }
  configureCompose() {
    this.envFile = environmentFile(this.root, this.env);
    this.files = [join(this.root, 'compose.yml'), join(this.root, 'compose.dev.yml')];
    for (const name of ['docker-space-recovery/compose.json', 'dsa-runtime/mounts.compose.json', 'state-switch/active.compose.json']) {
      const file = join(this.root, '.maintenance-backups', name);
      if (existsSync(file)) this.addComposeFile(file);
    }
  }
  addComposeFile(file) { if (!this.files.includes(file)) this.files.push(file); }
  compose(args, options = {}) {
    return this.docker(this.composeArguments(args), options);
  }
  composeArguments(args) {
    return ['compose', '--env-file', this.envFile, ...this.files.flatMap(file => ['-f', file]), ...args];
  }
  idleSync() {
    if (/running|pending/i.test(this.dockerSync(['buildx', '--builder', this.context, 'history', 'ls', '--format', '{{.Status}}']))) throw new Error('存在活动构建，停止维护。');
  }
  async idle() {
    if (/running|pending/i.test(await this.docker(['buildx', '--builder', this.context, 'history', 'ls', '--format', '{{.Status}}']))) {
      throw new Error('存在活动构建；停止清理或重复构建。');
    }
  }
  async requireLocalBuilder() {
    if (this.env.BUILDX_BUILDER && this.env.BUILDX_BUILDER !== this.context) throw new Error('不支持自定义 BUILDX_BUILDER。');
    const info = await this.docker(['buildx', 'inspect', this.context]);
    const drivers = [...info.matchAll(/^Driver:\s+(\S+)/gm)].map(match => match[1]);
    const endpoints = [...info.matchAll(/^Endpoint:\s+(\S+)/gm)].map(match => match[1]);
    if (drivers.length !== 1 || drivers[0] !== 'docker' || endpoints.length !== 1 || endpoints[0] !== this.context) {
      throw new Error('不支持当前 builder 的驱动或节点布局。');
    }
  }
  async acquire() {
    if (!this.lockPath) throw new Error('更新锁尚未初始化。');
    await this.run('ps', ['-p', String(process.pid), '-o', 'ppid='], { timeout: 5000 });
    this.lock.acquire();
  }
  get lockOwned() { return this.lock?.owned ?? false; }
  release() { this.lock?.release(); }
  lockedSync(action, owner) {
    if (owner !== undefined) {
      if (!ownsUpdateLock(this.lockPath, pid => this.syncRun('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 5000 }), owner)) throw new Error('不能借用其他进程的更新锁。');
      return action();
    }
    this.syncRun('ps', ['-p', String(process.pid), '-o', 'ppid='], { timeout: 5000 });
    this.lock.acquire(); return this.lock.run(action);
  }
  async locked(action) {
    await this.acquire();
    return this.lock.run(action);
  }
  async wait(service, { strictHealth = false, cleanup = false } = {}) {
    const seconds = positiveInteger(this.env.HEALTH_TIMEOUT_SECONDS ?? '120', 'HEALTH_TIMEOUT_SECONDS');
    try {
      const states = await waitForHealth(async () => {
        try {
          const id = (await this.compose(['ps', '-aq', service], { cleanup })).trim().split('\n')[0];
          if (!id) return [];
          const status = (await this.docker(['inspect', '--format', '{{.State.Status}}', id], { cleanup })).trim();
          const health = (await this.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', id], { cleanup })).trim();
          return [{ status, health }];
        } catch { return []; }
      }, { seconds, allowNoHealth: !strictHealth, sleep: this.sleep, signal: cleanup ? undefined : this.signal });
      this.log(`服务已就绪: ${service} (${states[0].health})`);
    } catch (error) { throw new Error(`${service}: ${error.message}`, { cause: error }); }
  }
}
