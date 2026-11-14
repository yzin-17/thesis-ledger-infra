import assert from 'node:assert/strict';
import { test } from 'vitest';
import { LocalDocker } from './runtime/docker.mjs';

test('授权回调端口仅绑定本机，监听地址和持久卷保持', async () => {
  const runtime = new LocalDocker({ env: { ...process.env, ENV_FILE: '.env.example' } });
  runtime.configureCompose(); await runtime.connect();
  const { services } = JSON.parse(await runtime.compose(['config', '--format', 'json']));
  const dsa = services.dsa;
  const callback = dsa.ports.filter(port => port.target === 60355);
  assert.equal(callback.length, 1); assert.equal(callback[0].host_ip, '127.0.0.1'); assert.equal(String(callback[0].published), '60355');
  for (const [name, service] of Object.entries(services)) if (name !== 'dsa') assert((service.ports ?? []).every(port => port.target !== 60355));
  assert.equal(dsa.environment.THESIS_LEDGER_OAUTH_CALLBACK_HOST, '0.0.0.0');
  assert(dsa.volumes.some(mount => mount.target === '/app/data'));
});
