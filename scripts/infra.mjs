import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalDocker } from './runtime/docker.mjs';
import { bootstrap, desktop, lockedCommand, removeFailedHistory, restore } from './runtime/maintenance.mjs';
import { extendDisk } from './docker-desktop-disk.mjs';
import { runCli } from './runtime/process.mjs';

export async function main([action, ...args], dependencies = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('infra 需要 Node.js 24 或更新版本。');
  const runtime = new LocalDocker(dependencies);
  if (action === 'update') return (await import('./runtime/update.mjs')).update(runtime, args);
  if (action === 'sync-code') return (await import('./runtime/sync.mjs')).syncCode(runtime, args);
  if (action === 'bootstrap') return bootstrap(runtime.run, runtime.root, runtime.env, runtime.log);
  if (action === 'docker-desktop') return desktop(runtime, args);
  if (action === 'restore-dsa') return restore(runtime, args);
  if (action === 'locked') return lockedCommand(runtime, args);
  if (action === 'failed-history') {
    if (!args.length || args.some(id => !/^[a-z0-9]{20,32}$/.test(id))) throw new Error('请显式提供合法失败构建记录 ID。');
    await runtime.connect(); await runtime.requireLocalBuilder();
    return runtime.locked(async () => { await runtime.idle(); await removeFailedHistory(runtime, args); });
  }
  if (action === 'docker-desktop-disk') {
    if (args.length !== 2 || args[0] !== 'extend' || !/^\d+$/.test(args[1])) throw new Error('用法：node scripts/infra.mjs docker-desktop-disk extend <容量MiB>');
    return extendDisk(runtime, Number(args[1]));
  }
  throw new Error('未知 infra 维护命令。');
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(main, process.argv.slice(2));
}
