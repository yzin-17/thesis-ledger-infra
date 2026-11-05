import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDsaTarget } from './dsa-target-contract.mjs';
import { digest, inspect } from './research-state-backup.mjs';

// 专用验收入口：只在已运行 DSA 的 /tmp 写合成 SQLite，不修改正式配置或数据。
const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [output] = process.argv.slice(2);
assert(output && resolve(output) === output && !existsSync(output), '报告必须为新的绝对路径');
assert(output.startsWith(join(infra, '.maintenance-backups') + sep), '报告必须位于私有维护目录');
const before = inspect('thesis-ledger-dev-dsa-1');
assertDsaTarget(before);
const program = readFileSync(join(infra, 'scripts/tushare-account-level-acceptance.py'), 'utf8');
const result = spawnSync('docker', ['exec', '-i', '--user', '1000:1000', '--workdir', '/app',
  before.Id, 'python', '-B', '-'], { input: program, encoding: 'utf8', timeout: 120000,
  maxBuffer: 2 * 1024 * 1024 });
let observed;
try { observed = JSON.parse(result.stdout); } catch { throw new Error('目标未返回有效验收报告'); }
assert.equal(result.status, 0, observed.reason ?? '目标隔离验收失败');
assert.equal(observed.passed, true);
assert.equal(observed.cleaned, true);
assert.equal(observed.realProviderRequests, 0);
const after = inspect('thesis-ledger-dev-dsa-1');
assertDsaTarget(after);
assert.equal(after.Id, before.Id, '验收期间容器被替换');
assert.equal(after.State.StartedAt, before.State.StartedAt, '验收期间容器重启');
assert.equal(after.Image, before.Image);
const report = { version: 'tushare-account-level-target-v1', checkedAt: new Date().toISOString(),
  image: before.Image, programSha256: digest(program), ...observed };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path: output, image: report.image, passed: true,
  restoredPoints: observed.phases[1].points, restoredInterfaces: observed.phases[1].states.length,
  restoreInterfaceCalls: observed.phases[1].calls.length, realProviderRequests: 0, cleaned: true }));
