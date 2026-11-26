import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksum } from '../state-backup.mjs';
import { imageIdPattern } from './options.mjs';

const runtimeFields = '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},'
  + '"user":{{json .Config.User}},"workdir":{{json .Config.WorkingDir}},'
  + '"manifest":{{json .ImageManifestDescriptor}}}';

/** 保护原镜像。Docker 已遗失可引用清单时，从绑定的原容器保存本地恢复镜像。 */
export async function pinStateSwitchImages(runtime, stateSwitch) {
  assert(runtime.lockOwned);
  const { plan, source } = stateSwitch;
  const directory = join(runtime.root, '.maintenance-backups/state-switch/source-images');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [service, item] of Object.entries(source)) {
    const name = `${plan.target}-state-recovery-${service}:${item.image.slice(7)}`;
    const image = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', item.image]).catch(() => '')).trim();
    const hasApplicationChanges = service !== 'postgres' && service !== 'redis' &&
      /^(?:A|C|D) \/app(?:\/|$)/mu.test(await runtime.docker(['container', 'diff', item.id]));
    if (image === item.image && !hasApplicationChanges) {
      await runtime.docker(['tag', item.image, name]);
    } else {
      const file = join(directory, service + '-' + item.id.slice(0, 16) + '-' + Date.now() + '.tar');
      const identity = (await runtime.docker(['inspect', '--format', '{{.Image}}', item.id])).trim();
      assert.equal(identity, item.image, '原容器镜像身份变化');
      const config = JSON.parse(await runtime.docker(['inspect', '--format', runtimeFields, item.id]));
      const platform = config.manifest?.platform;
      assert(platform?.os === 'linux' && /^(arm64|amd64)$/u.test(platform.architecture));
      assert(Array.isArray(config.entrypoint) && Array.isArray(config.command));
      assert(/^\/[\w/.-]+$/u.test(config.workdir));
      assert(!config.user || /^[a-zA-Z0-9_:-]+$/u.test(config.user));
      await runtime.docker(['container', 'export', '--output', file, item.id], { timeout: 180_000 });
      chmodSync(file, 0o600);
      const changes = [`WORKDIR ${config.workdir}`, 'ENTRYPOINT ' + JSON.stringify(config.entrypoint),
        'CMD ' + JSON.stringify(config.command), ...(config.user ? ['USER ' + config.user] : [])];
      const importId = (await runtime.docker(['image', 'import', '--platform', `linux/${platform.architecture}`,
        ...changes.flatMap((change) => ['--change', change]), file, name], { timeout: 180_000 })).trim();
      assert(imageIdPattern.test(importId));
      writeFileSync(file + '.json', JSON.stringify({ service, container: item.id, originalImage: item.image,
        sha256: await checksum(file), recoveryImage: importId, tag: name }), { flag: 'wx', mode: 0o600 });
      runtime.log(`已从原容器保存 ${service} 的完整运行文件和恢复镜像。`);
    }
    item.recovery = name;
  }
}
