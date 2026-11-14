import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export async function bootstrap(run, root, env, log = console.log) {
  const workspace = resolve(root, '..');
  for (const [name, url] of [
    ['thesis-ledger', env.THESIS_LEDGER_REPO_URL ?? 'https://github.com/yzin-17/thesis-ledger.git'],
    ['daily-stock-analysis', env.DSA_REPO_URL ?? 'https://github.com/yzin-17/daily_stock_analysis.git'],
  ]) {
    const path = join(workspace, name);
    if (existsSync(join(path, '.git'))) { log(`已存在，保留当前工作树: ${path}`); continue; }
    if (existsSync(path)) throw new Error(`目标路径已存在但不是 Git 仓库: ${path}`);
    await run('git', ['clone', '--', url, path], { stream: true });
  }
  log(`工作区准备完成: ${workspace}`);
}

export async function desktop(runtime, args, log = runtime.log) {
  if (args.length !== 1 || !['start', 'status'].includes(args[0])) {
    throw Object.assign(new Error('用法: bash scripts/docker-desktop.sh [start|status]'), { code: 2 });
  }
  await runtime.connect();
  if (args[0] === 'status') { await runtime.docker(['info']); return; }
  try { await runtime.docker(['info']); log('Docker daemon 已可用，无需启动。'); return; } catch { /* 仅启动已安装的 Desktop。 */ }
  await runtime.docker(['desktop', 'start', '--timeout', '45'], { stream: true });
  await runtime.docker(['info']); log('Docker daemon 启动后检查通过。');
}

export async function removeFailedHistory(runtime, ids) {
  if (!ids.length || ids.some(id => !/^[a-z0-9]{20,32}$/.test(id))) throw new Error('请显式提供合法失败构建记录 ID；不支持全量删除。');
  const status = async id => (await runtime.docker(['buildx', 'history', 'inspect', '--builder', runtime.context, id, '--format', '{{.Status}}'])).trim();
  for (const id of ids) if (await status(id) !== 'failed') throw new Error(`记录不是失败状态，保留: ${id}`);
  for (const id of ids) {
    await runtime.idle();
    if (await status(id) !== 'failed') throw new Error('失败记录状态发生变化，停止清理。');
    await runtime.docker(['buildx', 'history', 'rm', '--builder', runtime.context, id]);
    runtime.log(`已移除失败构建记录: ${id}`);
  }
}

export async function lockedCommand(runtime, args) {
  const idle = args[0] === '--idle';
  const command = args.slice(idle ? 1 : 0);
  if (command[0] !== '--' || !command[1]) throw new Error('持锁命令用法：locked [--idle] -- <程序> <参数>');
  const binary = command[1], script = command[2];
  if (binary !== 'node' && (!isAbsolute(binary) || !existsSync(binary) || realpathSync(binary) !== realpathSync(process.execPath))) throw new Error('持锁入口只接受已登记的 Node 维护脚本。');
  if (!script || script.startsWith('-') || !existsSync(script) || lstatSync(script).isSymbolicLink()) throw new Error('维护脚本路径无效。');
  const actual = realpathSync(script);
  const owned = join(runtime.root, 'scripts/dsa-runtime-recovery.mjs');
  let registered = existsSync(owned) && actual === realpathSync(owned);
  for (const name of ['thesis-ledger', 'daily-stock-analysis']) {
    const application = resolve(runtime.root, '..', name), manifest = join(application, 'scripts/deployment/maintenance.json');
    if (!existsSync(manifest)) continue;
    const root = realpathSync(application), entries = JSON.parse(readFileSync(manifest, 'utf8')).commands;
    if (!Array.isArray(entries)) throw new Error('应用维护命令清单无效。');
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || isAbsolute(entry.path) || entry.path.split('/').includes('..') || !entry.path.endsWith('.mjs')
          || (entry.idle !== undefined && typeof entry.idle !== 'boolean')) throw new Error('应用维护路径或空闲检查声明无效。');
      const path = join(root, entry.path);
      if (!existsSync(path)) continue;
      const resolved = realpathSync(path);
      if (!resolved.startsWith(root + sep)) throw new Error('应用维护脚本链接越界。');
      if (resolved === actual) {
        if (entry.idle === true && !idle) throw new Error('该维护命令必须检查空闲 builder。');
        registered = true;
      }
    }
  }
  if (!registered) throw new Error('维护脚本未在所属应用登记；不能使用通用持锁入口执行临时命令。');
  await runtime.connect();
  if (idle) await runtime.requireLocalBuilder();
  return runtime.locked(async () => {
    if (idle) await runtime.idle();
    const values = command.slice(2);
    const index = values.indexOf('@update-lock');
    if (index !== -1) values[index] = runtime.lockPath;
    await runtime.run(command[1], values, {
      env: { ...runtime.env, INFRA_UPDATE_LOCK_PATH: runtime.lockPath }, stream: true,
    });
  });
}

export async function restore(runtime, args) {
  if (args.length !== 1 || ['--help', '-h'].includes(args[0])) throw new Error('用法：bash ./scripts/restore-dsa.sh <更新前的 DSA 运行态快照.json>');
  if (!existsSync(args[0])) throw new Error('恢复快照不存在。');
  runtime.configureCompose();
  await runtime.connect();
  return runtime.locked(() => runtime.run(process.execPath, [join(runtime.root, 'scripts/dsa-runtime-recovery.mjs'),
    'restore', runtime.root, runtime.envFile, runtime.lockPath, args[0], runtime.env.HEALTH_TIMEOUT_SECONDS ?? '120'], {
    env: runtime.env, stream: true,
  }));
}
