import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeTarget } from './test-market-period-runtime.mjs';

const target = () => ({ Config: { Labels: {
  'com.docker.compose.project': 'thesis-ledger-dev',
  'com.docker.compose.service': 'thesis-ledger',
} }, State: { Status: 'running', Health: { Status: 'healthy' } } });
test('仅接受明确项目的健康 Server', () => {
  assertRuntimeTarget(target(), 'thesis-ledger-dev');
  for (const change of ['project', 'service', 'stopped', 'unhealthy']) {
    const info = target();
    if (change === 'project') info.Config.Labels['com.docker.compose.project'] = 'other';
    if (change === 'service') info.Config.Labels['com.docker.compose.service'] = 'backtest-worker';
    if (change === 'stopped') info.State.Status = 'exited';
    if (change === 'unhealthy') info.State.Health.Status = 'unhealthy';
    assert.throws(() => assertRuntimeTarget(info, 'thesis-ledger-dev'));
  }
});
