import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const activeStateSwitchPath = (root) => join(root, '.maintenance-backups/state-switch/active.compose.json');

export function switchedDataVolume(root, service, destination, fallback) {
  const path = activeStateSwitchPath(root);
  if (!existsSync(path)) return fallback;
  const layout = JSON.parse(readFileSync(path, 'utf8'));
  const mount = layout.services?.[service]?.volumes?.find((entry) => entry.type === 'volume' && entry.target === destination);
  const name = mount && layout.volumes?.[mount.source]?.name;
  if (typeof name !== 'string' || !name) throw new Error('已切换的持久卷配置缺失 ' + service);
  return name;
}
