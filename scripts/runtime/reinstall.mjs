import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function reinstall(build, reason = '实际 ENOSPC') {
  const { runtime, space } = build;
  if (!runtime.lockOwned || readFileSync(join(runtime.lockPath, 'pid'), 'utf8').trim() !== String(process.pid)) throw new Error('保卷恢复必须持有正式更新锁。');
  if (space.reinstalled) throw new Error('本轮已经执行保卷恢复，不再重复。');
  await runtime.idle(); space.reinstalled = true;
  // 扩大构建范围后，先准备应用输入；网络失败不能发生在主动停机之后。
  build.select('all'); await build.configuration(); await build.prepareInputs();
  const file = join(runtime.root, '.maintenance-backups/docker-space-recovery/compose.json');
  mkdirSync(dirname(file), { recursive: true });
  const input = await runtime.compose(['config', '--format', 'json']);
  const plan = await runtime.run(process.execPath, [join(runtime.root, 'scripts/docker-reinstall-plan.mjs')], { input, env: runtime.env });
  const volumes = JSON.parse(plan)['x-thesis-ledger-recovery']?.volumeNames;
  if (!Array.isArray(volumes) || volumes.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new Error('恢复计划缺少完整卷集合。');
  writeFileSync(file + '.pending', plan, { mode: 0o600 }); renameSync(file + '.pending', file);
  writeFileSync(join(dirname(file), 'incomplete'), '保卷恢复尚未完成\n', { mode: 0o600 });
  runtime.log(`${reason}：执行本开发项目保卷重装，保留全部卷及挂载。`);
  await runtime.idle(); await runtime.compose(['stop']); await runtime.idle(); await runtime.compose(['down']);
  for (const volume of volumes) await runtime.docker(['volume', 'inspect', volume]);
  await runtime.idle();
  await runtime.docker(['buildx', 'prune', '--builder', runtime.context, '--all', '--force'], { stream: true });
  await space.repairImages(true); await space.reclaim(); await space.measure();
  if (!space.positive()) throw new Error('保卷清理后仍无实际可用空间；保留卷和恢复文件。');
  runtime.addComposeFile(file);
  await build.prepareBaseImages();
}
