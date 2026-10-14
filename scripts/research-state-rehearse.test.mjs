import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { archiveProgram, assertOwnedRestore, isolatedPostgresArgs } from './research-state-rehearse.mjs';

test('恢复资源只使用随机命名、隔离网络，无端口或源卷', () => {
  const args = isolatedPostgresArgs(`sha256:${'a'.repeat(64)}`, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert(args.includes('none')); assert(!args.includes('-p')); assert(!args.includes('-v'));
  assert(args.includes('f01-restore-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.throws(() => isolatedPostgresArgs('latest', 'production'));
});
test('归档目录越界和链接在解包前拒绝', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'f01-archive-test-'));
  try {
    for (const kind of ['traversal', 'symlink']) {
      const build = `import tarfile,sys,pathlib
p=pathlib.Path(sys.argv[1]); p.joinpath('out').mkdir(exist_ok=True)
with tarfile.open(p/'dsa-data.tar','w') as t:
    m=tarfile.TarInfo('../outside' if sys.argv[2]=='traversal' else 'link')
    if sys.argv[2]=='symlink': m.type=tarfile.SYMTYPE; m.linkname='/etc/passwd'
    t.addfile(m)`;
      assert.equal(spawnSync('python3', ['-c', build, root, kind]).status, 0);
      assert.notEqual(spawnSync('python3', ['-c', archiveProgram, root, resolve(root, 'out')]).status, 0);
      rmSync(resolve(root, 'out'), { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('保留副本的清理不能使用源环境或其他所有权', () => {
  const owner = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const owned = { Name: `/f01-restore-${owner}`, Config: { Labels: { 'io.thesisledger.f01': owner } } };
  assertOwnedRestore(owned, owner);
  assert.throws(() => assertOwnedRestore({ ...owned, Name: '/thesis-ledger-dev-postgres-1' }, owner));
  assert.throws(() => assertOwnedRestore({ ...owned, Config: { Labels: {} } }, owner));
});
