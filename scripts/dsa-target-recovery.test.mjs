import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecoveryProbe } from './dsa-target-recovery.mjs';

const name = 'dsa-dg2c-12345678-1234-1234-1234-123456789abc';
const image = 'sha256:' + 'a'.repeat(64);
function probe() {
  return { Name: '/' + name, Image: image, Config: { User: '1000:1000',
    Labels: { 'org.openai.thesis-ledger.dg2c': name } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges'],
      Tmpfs: Object.fromEntries(['/tmp', '/app/data', '/app/logs', '/app/reports'].map(p => [p, 'uid=1000'])) },
    Mounts: ['tests', 'scripts/data_test_scope.py', 'docs/tasks/evidence'].map(path => ({
      Type: 'bind', Source: resolve(dirname(fileURLToPath(import.meta.url)), '../../daily-stock-analysis', path),
      Destination: '/app/' + path, RW: false })) };
}

test('故障容器只接受指定镜像、只读根、无网、临时状态和测试资料', () => {
  assertRecoveryProbe(probe(), name, image);
});

for (const [title, change] of [
  ['错误身份', v => { v.Config.Labels = {}; }],
  ['其他镜像', v => { v.Image = 'sha256:' + 'b'.repeat(64); }],
  ['宿主网络', v => { v.HostConfig.NetworkMode = 'host'; }],
  ['可写根目录', v => { v.HostConfig.ReadonlyRootfs = false; }],
  ['特权', v => { v.HostConfig.Privileged = true; }],
  ['业务卷', v => { v.Mounts.push({ Type: 'volume', Name: 'thesis-ledger-dsa-data', Destination: '/app/data' }); }],
  ['可写测试绑定', v => { v.Mounts[0].RW = true; }],
  ['扩大绑定路径', v => { v.Mounts[0].Source = '/'; }],
  ['缺少隔离目录', v => { delete v.HostConfig.Tmpfs['/app/data']; }],
]) {
  test(`拒绝误操作或扩大故障边界：${title}`, () => {
    const value = probe(); change(value); assert.throws(() => assertRecoveryProbe(value, name, image));
  });
}
