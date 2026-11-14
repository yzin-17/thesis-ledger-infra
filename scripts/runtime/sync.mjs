import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { positiveInteger, selectedServices, selectTarget } from './options.mjs';

export const syncUsage = `用法: ./scripts/sync-code.sh [all|dsa|thesis-ledger]

只同步当前源码构建产物到已运行容器的可写层，不构建、拉取或修改镜像。
默认 all；ENV_FILE 指定 Compose 配置，HEALTH_TIMEOUT_SECONDS 默认120秒。
依赖、数据库结构或原生输入变化时拒绝快更，必须使用完整 update.sh。
更新会重启目标容器；容器重建后，本次同步会消失。
`;

async function oneContainer(runtime, service) {
  const ids = (await runtime.compose(['ps', '-q', service])).trim().split('\n').filter(Boolean);
  if (ids.length !== 1) throw new Error(`目标服务缺少唯一运行容器: ${service}；请使用完整 update.sh。`);
  return ids[0];
}

export async function syncCode(runtime, args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { runtime.log(syncUsage); return; }
  if (args.length > 1) throw new Error(syncUsage);
  const target = args[0] ?? 'all', services = selectedServices(target), applications = selectTarget(target);
  positiveInteger(runtime.env.HEALTH_TIMEOUT_SECONDS ?? '120', 'HEALTH_TIMEOUT_SECONDS');
  const roots = {
    'thesis-ledger': runtime.env.THESIS_LEDGER_SOURCE_DIR ?? resolve(runtime.root, '../thesis-ledger'),
    dsa: runtime.env.DSA_SOURCE_DIR ?? resolve(runtime.root, '../daily-stock-analysis'),
  };
  for (const application of applications) if (!existsSync(join(roots[application], 'scripts/local-deployment.sh'))) throw new Error(`${application} 缺少部署准备命令。`);
  runtime.configureCompose(); await runtime.connect(); await runtime.docker(['info']);
  const containers = new Map(), images = new Map(), modified = [];
  const work = mkdtempSync(join(runtime.env.TMPDIR || tmpdir(), 'thesis-ledger-code-sync.'));
  const stage = `/tmp/${basename(work)}`;
  let staging = false;
  try {
    await runtime.locked(async () => {
      try {
        for (const service of services) {
          const id = await oneContainer(runtime, service);
          if ((await runtime.docker(['inspect', '--format', '{{.State.Status}}', id])).trim() !== 'running') throw new Error(`目标服务未运行: ${service}`);
          if (service === 'dsa' && (await runtime.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', id])).trim() !== 'healthy') throw new Error('DSA 当前容器未通过健康检查。');
          const image = (await runtime.docker(['inspect', '--format', '{{.Image}}', id])).trim();
          const reference = (await runtime.docker(['inspect', '--format', '{{.Config.Image}}', id])).trim();
          const actual = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', reference])).trim();
          if (!image || image !== actual) throw new Error(`Compose 镜像引用已漂移: ${service}；快更已拒绝。`);
          containers.set(service, id); images.set(service, image);
        }
        // 应用负责内部兼容条件；全部预检先于任何容器写入。
        for (const application of applications) await runtime.run('bash', [join(roots[application], 'scripts/local-deployment.sh'),
          'sync-preflight', containers.get(application), work], { env: runtime.env, stream: true });
        for (const application of applications) await runtime.run('bash', [join(roots[application], 'scripts/local-deployment.sh'),
          'sync-payload', join(work, `${application}-payload`)], { env: runtime.env, stream: true });
        for (const service of services) {
          const application = service === 'backtest-worker' ? 'thesis-ledger' : service, id = containers.get(service);
          modified.push(service); staging = true;
          await runtime.docker(['exec', '-u', '0', id, 'mkdir', '-p', stage]);
          await runtime.docker(['cp', join(work, `${application}-payload`) + '/.', `${id}:${stage}/`]);
          await runtime.docker(['exec', '-i', '-u', '0', id, 'sh', '-s', stage], {
            input: readFileSync(join(roots[application], 'scripts/deployment/apply-code.sh')), stream: true,
          });
        }
        await runtime.compose(['restart', ...services]);
        for (const service of services) await runtime.wait(service, { strictHealth: service === 'dsa' });
        for (const service of services) {
          const id = await oneContainer(runtime, service);
          if ((await runtime.docker(['inspect', '--format', '{{.Image}}', id])).trim() !== images.get(service)) throw new Error(`目标容器镜像 ID 发生变化: ${service}`);
          runtime.log(`镜像保持不变: ${service}`);
        }
      } catch (error) {
        if (modified.length) {
          runtime.log('代码同步未完成，使用同一镜像重建已修改目标容器...');
          try {
            await runtime.compose(['up', '-d', '--no-build', '--no-deps', '--pull', 'never', '--force-recreate', ...modified], { cleanup: true });
            for (const service of modified) await runtime.wait(service, { strictHealth: service === 'dsa', cleanup: true });
            runtime.log('目标容器已恢复为镜像内代码；未执行数据库结构或外部卷操作。');
          } catch { runtime.log('同镜像恢复未完成，保留现场并使用完整 update.sh 处理。'); }
        }
        throw error;
      } finally {
        if (staging) for (const id of containers.values()) {
          try { await runtime.docker(['exec', '-u', '0', id, 'rm', '-rf', '--', stage], { cleanup: true }); } catch { /* 回退后旧容器可能已移除。 */ }
        }
      }
    });
    runtime.log('仅代码更新完成：镜像 ID 保持不变；脚本未执行数据库结构或外部卷变更。');
    runtime.log('本次更新位于容器可写层；容器重建后将恢复为镜像内代码。');
  } finally { rmSync(work, { recursive: true, force: true }); }
}
