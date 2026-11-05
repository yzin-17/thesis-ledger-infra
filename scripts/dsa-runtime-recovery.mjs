import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRecoveryConfig, assertRestoredRuntime, fingerprint, recoveryOverride,
  snapshotFromInspection, validateSnapshot } from './dsa-runtime-snapshot.mjs';

// 仅取恢复所需字段；不读取、输出或持久化 Config.Env。
const inspectFormat = '{"imageId":{{json .Image}},"command":{{json .Config.Cmd}},'
  + '"entrypoint":{{json .Config.Entrypoint}},"healthcheck":{{json .Config.Healthcheck}},'
  + '"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},'
  + '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
  + '"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';

function runDocker(...args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('Docker 运行态检查或操作失败；保留原错误边界，未执行自动补救'); }
}

export class DsaRuntimeRecovery {
  constructor(infraDir, envFile, run = runDocker) {
    this.infraDir = resolve(infraDir);
    this.envFile = resolve(envFile);
    this.run = run;
    this.context = run('context', 'show');
    this.endpoint = run('context', 'inspect', this.context, '--format', '{{.Endpoints.docker.Host}}');
    if (!this.endpoint.startsWith('unix://') || process.env.DOCKER_HOST) throw new Error('恢复仅支持已确认的本地 Docker context');
    this.docker = (...args) => run('--context', this.context, ...args);
    this.compose = ['compose', '--project-name', 'thesis-ledger-dev', '--env-file', this.envFile,
      '-f', join(this.infraDir, 'compose.yml'), '-f', join(this.infraDir, 'compose.dev.yml')];
    const recoveryFile = join(this.infraDir, '.maintenance-backups/docker-space-recovery/compose.json');
    if (existsSync(recoveryFile)) this.compose.push('-f', recoveryFile);
    this.mountFile = join(this.infraDir, '.maintenance-backups/dsa-runtime/mounts.compose.json');
    if (existsSync(this.mountFile)) this.compose.push('-f', this.mountFile);
  }

  containerId() {
    const ids = this.docker(...this.compose, 'ps', '--all', '-q', 'dsa').split('\n').filter(Boolean);
    if (ids.length > 1) throw new Error('DSA 存在多个容器，不能确定恢复目标');
    return ids[0] ?? null;
  }

  inspect(id) { return JSON.parse(this.docker('inspect', '--format', inspectFormat, id)); }

  snapshot() {
    const id = this.containerId();
    if (!id) return null;
    const snapshot = snapshotFromInspection(this.inspect(id), { dockerContext: this.context,
      dockerEndpoint: this.endpoint, envSha256: fingerprint(readFileSync(this.envFile)) });
    if (this.docker('image', 'inspect', '--format', '{{.Id}}', snapshot.imageId) !== snapshot.imageId) {
      throw new Error('DSA 原镜像不可用，停止更新');
    }
    const directory = join(this.infraDir, '.maintenance-backups/dsa-runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${Date.now()}-${snapshot.imageId.slice(7, 19)}.json`);
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    this.preserveMounts(snapshot);
    return { path, imageId: snapshot.imageId };
  }

  preserveMounts(snapshot) {
    const override = recoveryOverride(snapshot);
    const mounts = { services: { dsa: { volumes: override.services.dsa.volumes } }, volumes: override.volumes };
    mkdirSync(join(this.infraDir, '.maintenance-backups/dsa-runtime'), { recursive: true, mode: 0o700 });
    writeFileSync(this.mountFile + '.pending', JSON.stringify(mounts, null, 2) + '\n', { mode: 0o600 });
    renameSync(this.mountFile + '.pending', this.mountFile);
  }

  prepareRestore(path) {
    const snapshot = validateSnapshot(JSON.parse(readFileSync(path, 'utf8')));
    if (snapshot.dockerContext !== this.context || snapshot.dockerEndpoint !== this.endpoint
        || snapshot.envSha256 !== fingerprint(readFileSync(this.envFile))) {
      throw new Error('DSA 恢复 context 或环境文件已变化；尚未修改容器');
    }
    if (this.docker('image', 'inspect', '--format', '{{.Id}}', snapshot.imageId) !== snapshot.imageId) {
      throw new Error('DSA 恢复镜像已不可用；不会自动拉取或构建');
    }
    for (const mount of snapshot.mounts) {
      if (mount.Type === 'volume') this.docker('volume', 'inspect', mount.Name);
      else if (!existsSync(mount.Source) || !statSync(mount.Source)) throw new Error('DSA 原绑定路径缺失');
    }
    const overridePath = resolve(path) + '.compose.json';
    writeFileSync(overridePath, JSON.stringify(recoveryOverride(snapshot), null, 2) + '\n', { mode: 0o600 });
    const args = [...this.compose, '-f', overridePath];
    // 配置可能含运行环境值，仅在内存中核对，不写日志或文件。
    assertRecoveryConfig(JSON.parse(this.docker(...args, 'config', '--format', 'json')), snapshot);
    this.preserveMounts(snapshot);
    return { snapshot, args };
  }

  async restore(path, timeoutSeconds) {
    const { snapshot, args } = this.prepareRestore(path);
    this.docker(...args, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'dsa');
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      const id = this.containerId();
      if (!id) throw new Error('DSA 恢复后容器缺失');
      const state = JSON.parse(this.docker('inspect', '--format', '{{json .State}}', id));
      if (!state.Running || state.Health?.Status === 'unhealthy') throw new Error('DSA 恢复后未健康；保留容器及挂载供诊断');
      if (state.Health?.Status === 'healthy') {
        assertRestoredRuntime(this.inspect(id), snapshot);
        return snapshot;
      }
      if (Date.now() >= deadline) throw new Error('DSA 恢复健康检查超时；保留容器及挂载供诊断');
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
}

export function ownsUpdateLock(lockPath, parent = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'ppid='],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })) {
  try {
    const owner = readFileSync(join(lockPath, 'pid'), 'utf8').trim();
    if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(Number(owner))) return false;
    let pid = process.ppid;
    const visited = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (String(pid) === owner) return true;
      if (pid <= 1 || visited.has(pid)) return false;
      visited.add(pid);
      const next = parent(pid).trim();
      if (!/^[1-9][0-9]*$/.test(next) || !Number.isSafeInteger(Number(next))) return false;
      pid = Number(next);
    }
    return false;
  } catch { return false; }
}

async function main([mode, infraDir, envFile, lockPath, snapshotPath, timeout = '120']) {
  if (!['snapshot', 'restore'].includes(mode) || !infraDir || !envFile || !lockPath
      || !ownsUpdateLock(lockPath)) {
    throw new Error('DSA 运行态恢复必须由持有正式更新锁的脚本调用');
  }
  if (!/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > 3600) throw new Error('健康检查超时须为 1～3600 秒');
  const runtime = new DsaRuntimeRecovery(infraDir, envFile);
  if (mode === 'snapshot') {
    const result = runtime.snapshot();
    if (result) {
      process.stderr.write(`已记录 DSA 镜像基线与全部挂载：${result.path}\n`);
      process.stdout.write(result.imageId + '\n');
    }
  } else {
    if (!snapshotPath) throw new Error('缺少 DSA 恢复快照路径');
    const result = await runtime.restore(snapshotPath, Number(timeout));
    process.stdout.write(`DSA 已恢复并通过镜像、命令、挂载和健康核对：${result.imageId}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // runDocker 已隔离可能含环境内容的原始 stderr。
    process.stderr.write(`DSA 运行态快照或恢复失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
