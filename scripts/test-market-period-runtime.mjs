import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertRuntimeTarget(info, project) {
  assert.equal(info.Config.Labels['com.docker.compose.project'], project);
  assert.equal(info.Config.Labels['com.docker.compose.service'], 'thesis-ledger');
  assert.equal(info.State.Status, 'running');
  assert.equal(info.State.Health.Status, 'healthy');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const project = process.env.COMPOSE_PROJECT_NAME ?? 'thesis-ledger-dev';
  const container = process.env.MARKET_PERIOD_CONTAINER ?? `${project}-thesis-ledger-1`;
  const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  assertRuntimeTarget(info, project);
  const source = fileURLToPath(new URL('../../thesis-ledger/scripts/market-period-runtime-probe.mjs', import.meta.url));
  // 只写唯一测试缓存命名空间；探针 finally 精确清理，不停止服务或修改业务表。
  execFileSync('docker', ['exec', '-i', '-e', 'TL_SERVER_RUNTIME_ROOT=/app/apps/server/dist/src',
    info.Id, 'node', '--input-type=module'], { input: readFileSync(source), stdio: ['pipe', 'inherit', 'inherit'], timeout: 120000 });
}
