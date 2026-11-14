import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { callApplicationContract } from './application-contract.mjs';
import { LocalDocker, waitForHealth } from './runtime/docker.mjs';
import { createSyncRunner } from './runtime/process.mjs';
import { ownsUpdateLock } from './runtime/lock.mjs';
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

// 仅取恢复所需字段；不读取、输出或持久化 Config.Env。
const inspectFormat = '{"imageId":{{json .Image}},"command":{{json .Config.Cmd}},'
  + '"entrypoint":{{json .Config.Entrypoint}},"healthcheck":{{json .Config.Healthcheck}},'
  + '"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},'
  + '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
  + '"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';

export class DsaRuntimeRecovery {
  constructor(infraDir, envFile, run) {
    this.infraDir = resolve(infraDir);
    this.envFile = resolve(envFile);
    const sync = createSyncRunner();
    this.runtime = new LocalDocker({ root: this.infraDir, env: { ...process.env, ENV_FILE: this.envFile },
      runSync: run && ((binary, args, options) => binary === 'docker' ? run(...args) : sync(binary, args, options)) }).connectSync();
    const application = process.env.DSA_SOURCE_DIR ?? fileURLToPath(new URL('../../daily-stock-analysis/', import.meta.url));
    this.contract = (operation, ...args) => callApplicationContract(application, operation, ...args);
    this.context = this.runtime.context; this.endpoint = this.runtime.endpoint;
    this.docker = (...args) => {
      try { return this.runtime.dockerSync(args, { maxBuffer: 4 * 1024 * 1024 }).trim(); }
      catch { throw new Error('Docker 运行态检查或操作失败；保留原错误边界，未执行自动补救'); }
    };
    this.runtime.configureCompose(); this.compose = this.runtime.composeArguments([]);
    this.mountFile = join(this.infraDir, '.maintenance-backups/dsa-runtime/mounts.compose.json');
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
    const snapshot = this.contract('snapshot', this.inspect(id), { dockerContext: this.context,
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
    const override = this.contract('override', snapshot);
    const mounts = { services: { dsa: { volumes: override.services.dsa.volumes } }, volumes: override.volumes };
    mkdirSync(join(this.infraDir, '.maintenance-backups/dsa-runtime'), { recursive: true, mode: 0o700 });
    writeFileSync(this.mountFile + '.pending', JSON.stringify(mounts, null, 2) + '\n', { mode: 0o600 });
    renameSync(this.mountFile + '.pending', this.mountFile);
  }

  prepareRestore(path) {
    const snapshot = this.contract('validate', JSON.parse(readFileSync(path, 'utf8')));
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
    writeFileSync(overridePath, JSON.stringify(this.contract('override', snapshot), null, 2) + '\n', { mode: 0o600 });
    const args = [...this.compose, '-f', overridePath];
    // 配置可能含运行环境值，仅在内存中核对，不写日志或文件。
    this.contract('config', JSON.parse(this.docker(...args, 'config', '--format', 'json')), snapshot);
    this.preserveMounts(snapshot);
    return { snapshot, args };
  }

  async restore(path, timeoutSeconds) {
    const { snapshot, args } = this.prepareRestore(path);
    this.docker(...args, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'dsa');
    await waitForHealth(async () => {
      const id = this.containerId();
      if (!id) return [];
      const state = JSON.parse(this.docker('inspect', '--format', '{{json .State}}', id));
      return [{ status: state.Status ?? (state.Running ? 'running' : 'exited'), health: state.Health?.Status ?? 'none' }];
    }, { seconds: timeoutSeconds, interval: 1000, failUnhealthy: true, requireContainer: true });
    this.contract('restored', this.inspect(this.containerId()), snapshot);
    return snapshot;
  }
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

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // runDocker 已隔离可能含环境内容的原始 stderr。
    process.stderr.write(`DSA 运行态快照或恢复失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
