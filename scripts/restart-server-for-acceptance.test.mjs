import assert from 'node:assert/strict';
import test from 'node:test';
import { main, restartPlan, serverIdentity } from './restart-server-for-acceptance.mjs';

const image = 'sha256:' + 'a'.repeat(64);
const args = ['--confirm=thesis-ledger-dev/thesis-ledger', '--image=' + image];
test('默认计划无Docker操作，应用需明确精确服务和镜像', async () => {
  assert.equal((await main(args)).writes, false);
  assert.equal(restartPlan([...args, '--apply']).mode, 'apply');
  for (const invalid of [[], ['--confirm=another-project', args[1]], [args[0]], [...args, '--apply', '--apply'], [...args, '--force']]) {
    assert.throws(() => restartPlan(invalid));
  }
});
test('拒绝其他服务、镜像或数据卷，身份包含所有挂载', () => {
  const value = { Name: '/thesis-ledger-dev-thesis-ledger-1', Id: 'b'.repeat(64), Image: image,
    Config: { Labels: { 'com.docker.compose.project': 'thesis-ledger-dev', 'com.docker.compose.service': 'thesis-ledger' } },
    Mounts: [{ Type: 'volume', Name: 'thesis-ledger-backtest-data', Destination: '/app/var/backtest', RW: true }] };
  assert.equal(serverIdentity(value, image).mounts.length, 1);
  assert.throws(() => serverIdentity({ ...value, Name: '/thesis-ledger-dev-backtest-worker-1' }, image));
  assert.throws(() => serverIdentity({ ...value, Image: 'sha256:' + 'c'.repeat(64) }, image));
  assert.throws(() => serverIdentity({ ...value, Mounts: [] }, image));
});
