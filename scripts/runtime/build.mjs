import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { imageIdPattern, imageReferences, selectedImages, selectTarget } from './options.mjs';

export function networkOptions(env) {
  const result = [], mirror = env.BUILD_ALPINE_MIRROR;
  if (mirror) {
    if (!/^https:\/\/[a-zA-Z0-9.-]+\/alpine$/.test(mirror)) throw new Error('BUILD_ALPINE_MIRROR 必须为无凭据的 HTTPS Alpine 根地址。');
    result.push('--set', `*.args.ALPINE_MIRROR=${mirror}`);
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const value = env[`BUILD_${key}`];
    if (!value) continue;
    if (/[\r\n]/.test(value) || (key !== 'NO_PROXY' && !/^https?:\/\/[^\s]+$/.test(value))) throw new Error(`BUILD_${key} 配置无效。`);
    result.push('--set', `*.args.${key}=${value}`);
  }
  return result;
}

export class BuildPlan {
  constructor(runtime, space, { target, pull = false }) {
    this.runtime = runtime; this.space = space; this.target = target; this.pull = pull;
    this.network = networkOptions(runtime.env); this.work = ''; this.inputsOwned = false; this.inputsPrepared = false; this.pulled = new Set();
  }
  select(target) { this.target = target; this.space.target = target; }
  async configuration() {
    const runtime = this.runtime;
    if (!this.work) this.work = mkdtempSync(join(runtime.env.TMPDIR || tmpdir(), 'thesis-ledger-local-build.'));
    this.logPath = join(this.work, 'build.log'); writeFileSync(this.logPath, '');
    const services = {};
    if (selectTarget(this.target).includes('dsa')) {
      const app = resolve(runtime.root, '../daily-stock-analysis/scripts/local-deployment.sh');
      const configuration = JSON.parse(await runtime.run('bash', [app, 'build-config', this.work], { env: runtime.env }));
      if (!configuration.services?.dsa?.build || Object.keys(configuration).some(key => key !== 'services')
          || Object.keys(configuration.services).some(key => key !== 'dsa')
          || Object.keys(configuration.services.dsa).some(key => key !== 'build')) throw new Error('应用构建配置超出声明接口。');
      const build = configuration.services.dsa.build;
      services.dsa = { build: { ...build, args: { ...build.args,
        RUST_IMAGE: 'thesis-ledger-local-rust:1.94.1-slim-bookworm', PYTHON_IMAGE: 'thesis-ledger-local-python:3.11-slim-bookworm' } } };
    }
    if (selectTarget(this.target).includes('thesis-ledger')) {
      for (const name of ['thesis-ledger', 'backtest-worker']) services[name] = { build: { args: { NODE_IMAGE: 'thesis-ledger-local-node:24-alpine' } } };
    }
    this.override = join(this.work, 'compose.override.json');
    writeFileSync(this.override, JSON.stringify({ services }, null, 2) + '\n'); runtime.addComposeFile(this.override);
  }
  async prepareInputs() {
    const runtime = this.runtime;
    if (!selectTarget(this.target).includes('dsa') || runtime.env.REUSE_DSA_IMAGE_ID || this.space.completed.has('dsa') || this.inputsPrepared) return;
    this.inputsOwned = true;
    await runtime.run('bash', [resolve(runtime.root, '../daily-stock-analysis/scripts/local-deployment.sh'),
      'prepare-build', this.work, join(runtime.root, '.maintenance-backups/build-inputs/dsa')], { env: runtime.env, stream: true });
    this.inputsPrepared = true;
  }
  async cleanup() {
    if (!this.work) return;
    if (this.inputsOwned) {
      await this.runtime.cleanupRun('bash', [resolve(this.runtime.root, '../daily-stock-analysis/scripts/local-deployment.sh'), 'cleanup-build', this.work], { env: this.runtime.env });
    }
    for (const path of [this.logPath, this.override]) if (path && existsSync(path)) unlinkSync(path);
    try { rmdirSync(this.work); } catch { /* 保留未知文件和诊断产物。 */ }
  }
  async prepareBaseImages() {
    const runtime = this.runtime, images = selectedImages(this.target);
    if (this.pull) for (const [source] of images) {
      if (!this.pulled.has(source)) { await runtime.docker(['pull', source], { stream: true }); this.pulled.add(source); }
    }
    for (const [source, alias] of images) {
      if (!this.pull) {
        try { await runtime.docker(['image', 'inspect', alias]); runtime.log(`复用本地基础镜像: ${alias}`); continue; } catch { /* 继续检查本机上游镜像。 */ }
        try { await runtime.docker(['image', 'inspect', source]); }
        catch { await runtime.docker(['pull', source], { stream: true }); }
      }
      await runtime.docker(['tag', source, alias]); await runtime.docker(['image', 'inspect', alias]);
    }
  }
  async validateReuse(service, expected) {
    if (!imageIdPattern.test(expected)) throw new Error('复用镜像必须为完整 SHA256 ID。');
    const runtime = this.runtime;
    const inspect = async format => (await runtime.docker(['image', 'inspect', '--format', format, expected])).trim();
    const actual = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', imageReferences[service]])).trim();
    if (actual !== expected || await inspect('{{index .Config.Labels "com.docker.compose.service"}}') !== service) throw new Error('复用镜像 ID 或服务不匹配。');
    if (service === 'dsa') {
      if (await inspect('{{index .Config.Labels "org.openai.thesis-ledger.contract"}}') !== '1'
          || await inspect('{{index .Config.Labels "org.openai.thesis-ledger.data-runtime"}}') !== 'dsa-data-runtime-v1') throw new Error('DSA 镜像契约不匹配。');
    } else {
      if (this.target !== 'thesis-ledger' || await inspect('{{index .Config.Labels "com.docker.compose.project"}}') !== 'thesis-ledger-dev') throw new Error('Server 镜像复用只接受本开发项目的最小目标。');
      const shape = [];
      for (const format of ['{{.Config.WorkingDir}}', '{{.Config.User}}', '{{json .Config.Cmd}}']) shape.push(await inspect(format));
      await runtime.run('bash', [resolve(runtime.root, '../thesis-ledger/scripts/local-deployment.sh'), 'validate-image'], { input: shape.join('\n') + '\n', env: runtime.env });
    }
  }
  async run() {
    const runtime = this.runtime;
    for (const service of selectTarget(this.target)) {
      const reference = imageReferences[service], completed = this.space.completed.get(service);
      if (completed) {
        if ((await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', reference])).trim() !== completed) throw Object.assign(new Error('本轮已完成构建镜像身份发生变化。'), { code: 75 });
        continue;
      }
      const reuse = runtime.env[service === 'dsa' ? 'REUSE_DSA_IMAGE_ID' : 'REUSE_THESIS_LEDGER_IMAGE_ID'];
      if (reuse) {
        try { await this.validateReuse(service, reuse); } catch (error) { error.code = 75; throw error; }
      } else {
        runtime.log(`构建服务: ${service}`);
        const bake = await runtime.compose(['build', '--print', service]);
        await runtime.docker(['buildx', 'bake', '--builder', runtime.context, '--file', '-', '--progress', 'plain',
          '--allow', `fs.read=${resolve(runtime.root, '..')}`, '--allow', `fs.read=${this.work}`, ...this.network, service], {
          input: bake, stream: true, onOutput: value => appendFileSync(this.logPath, value),
        });
      }
      try {
        const id = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', reference])).trim();
        if (!imageIdPattern.test(id)) throw new Error('本轮构建镜像身份无效。');
        this.space.completed.set(service, id); runtime.log(`本次已完成构建产物受保护: ${service} -> ${id}`);
        await this.space.releaseIntermediates(service);
      } catch (error) { error.code = 75; throw error; }
    }
  }
  async withRetry(reinstall) {
    let ordinaryRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      writeFileSync(this.logPath, '');
      try { await this.run(); return; }
      catch (error) {
        if (error.code === 75) throw error;
        const outOfSpace = /ENOSPC|no space left on device|not enough disk space|insufficient disk space/i.test(readFileSync(this.logPath, 'utf8') + (error.stderr ?? '') + error.message);
        if (outOfSpace) {
          if (!this.space.repair || this.space.reinstalled) throw error;
          await reinstall('实际 ENOSPC');
        } else {
          if (ordinaryRetried || this.space.reinstalled) throw error;
          ordinaryRetried = true; this.runtime.log('首次镜像构建失败，保留缓存后重试一次。');
        }
        if (attempt === 2) throw error;
      }
    }
  }
}
