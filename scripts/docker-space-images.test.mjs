import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { planSpaceImages, runSpaceImageMaintenance } from './docker-space-images.mjs';

const id = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
const image = (n, tags = []) => ({ Id: id(n), RepoTags: tags });
const historical = (n) => image(n, [`thesis-ledger:rollback-${id(n).slice(7)}`]);
const reference = 'daily-stock-analysis:thesisledger-dev';

test('清理无引用开发产物和无标签镜像，保留全部容器及其他标签', () => {
  const plan = planSpaceImages({ images: [image(1, [reference]), image(2), image(3, ['node:24-alpine']),
    image(4, [reference, 'other:pin']), image(5, null), image(6)],
  containers: [{ Image: id(5) }], protectedIds: [id(6)] });
  assert.deepEqual(plan.remove.map((x) => x.imageId).sort(), [id(1), id(2)]);
});
test('最小更新目标不删其他应用开发标签', () => {
  const plan = planSpaceImages({ images: [image(1, [reference]), image(2, ['thesis-ledger:dev'])],
    containers: [], target: 'thesis-ledger' });
  assert.deepEqual(plan.remove.map((x) => x.imageId), [id(2)]);
});
test('普通清理保留任意数量的历史标签，不依赖创建时间', () => {
  const plan = planSpaceImages({ images: Array.from({ length: 7 }, (_, i) => historical(i + 1)), containers: [] });
  assert.deepEqual(plan.remove, []);
});
test('全部未引用模式允许删除基础镜像的多个别名及旧标签，保留容器和明确保护', () => {
  const plan = planSpaceImages({ images: [image(1, ['node:24-alpine', 'local-node:24-alpine']), historical(2),
    image(3, ['redis:8-alpine']), image(4, [reference])], containers: [{ Image: id(3) }],
  protectedIds: [id(4)], allUnused: true });
  assert.deepEqual(plan.remove.map((x) => x.imageId), [id(1), id(1), id(2)]);
  assert(plan.remove.every((x) => x.kind === 'unused'));
});
test('错误库存和目标拒绝', () => {
  for (const bad of [image(1, 'bad'), { ...image(1), Id: 'bad' }, image(1, [''])]) {
    assert.throws(() => planSpaceImages({ images: [bad], containers: [] }));
  }
  assert.throws(() => planSpaceImages({ images: [], containers: [], target: 'other' }));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'docker-space-images-test-'));
  const state = { commands: [], images: [image(1, [reference])], containers: [], snapshots: 0,
    active: false, drift: null, inventoryFailure: false };
  const run = (binary, args, input) => {
    const command = args.join(' ');
    state.commands.push([binary, ...args]);
    if (binary === 'ps') return '1';
    if (binary === 'cksum') return '775 1\n';
    if (command === 'context show') return 'desktop-linux\n';
    if (command.startsWith('context inspect')) return 'unix:///fixture.sock\n';
    if (command.includes('history ls')) return state.active ? 'Running\n' : 'Completed\n';
    if (command.includes('image ls')) {
      if (state.inventoryFailure) throw new Error('库存不可读');
      state.snapshots += 1;
      if (state.snapshots === 2 && state.drift === 'container') state.containers = [{ Id: 'stopped', Image: id(1) }];
      if (state.snapshots === 2 && state.drift === 'tag') state.images[0].RepoTags.push('user:pin');
      if (state.snapshots === 2 && state.drift === 'identity') state.images = [image(2, [reference])];
      return state.images.map((x) => x.Id).join('\n');
    }
    if (command.includes('image inspect')) return state.images.map((x) => JSON.stringify(x)).join('\n');
    if (command.includes('ps -aq')) return state.containers.map((x) => x.Id).join('\n');
    if (command.includes('container inspect')) return state.containers.map((x) => JSON.stringify(x)).join('\n');
    if (command.includes('image rm')) {
      const ref = args.at(-1);
      state.images = state.images.flatMap((item) => {
        if (item.Id === ref) return [];
        const tags = item.RepoTags.filter((tag) => tag !== ref);
        return tags.length ? [{ ...item, RepoTags: tags }] : [];
      });
      return '';
    }
    throw new Error(`未声明命令 ${binary} ${command} ${input ?? ''}`);
  };
  return { state, run, env: { TMPDIR: dir }, log: () => {}, close: () => rmSync(dir, { recursive: true, force: true }) };
}
test('预览不删除且不创建更新锁', () => {
  const f = fixture(); try {
    const result = runSpaceImageMaintenance({}, f);
    assert.equal(result.remove.length, 1);
    assert(!f.state.commands.some((x) => x.includes('rm')));
  } finally { f.close(); }
});
test('精确非强制删除，不涉及容器或卷', () => {
  const f = fixture(); try {
    const result = runSpaceImageMaintenance({ apply: true }, f);
    assert.equal(result.removed.length, 1);
    assert.deepEqual(f.state.commands.filter((x) => x.includes('rm')),
      [['docker', '--context', 'desktop-linux', 'image', 'rm', '--no-prune', reference]]);
  } finally { f.close(); }
});
test('全部未引用模式逐个删除多标签镜像，后续运行引用出现则跳过', () => {
  for (const drift of [null, 'container']) {
    const f = fixture(); try {
      f.state.images = [image(1, ['node:24-alpine', 'local-node:24-alpine'])];
      f.state.drift = drift;
      const result = runSpaceImageMaintenance({ apply: true, allUnused: true }, f);
      assert.equal(result.removed.length, drift ? 0 : 2);
      assert(f.state.commands.filter((x) => x.includes('rm')).every((x) => !x.includes('--force')));
    } finally { f.close(); }
  }
});
for (const drift of ['container', 'tag']) test(`新保护出现时跳过：${drift}`, () => {
  const f = fixture(); try {
    f.state.drift = drift;
    const result = runSpaceImageMaintenance({ apply: true }, f);
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 1);
  } finally { f.close(); }
});
test('候选ID漂移拒绝', () => {
  const f = fixture(); try {
    f.state.drift = 'identity';
    assert.throws(() => runSpaceImageMaintenance({ apply: true }, f), /身份发生变化/);
    assert(!f.state.commands.some((x) => x.includes('rm')));
  } finally { f.close(); }
});
for (const fault of ['active', 'inventoryFailure']) test(`异常不删除：${fault}`, () => {
  const f = fixture(); try {
    f.state[fault] = true;
    assert.throws(() => runSpaceImageMaintenance({ apply: true }, f));
    assert(!f.state.commands.some((x) => x.includes('rm')));
  } finally { f.close(); }
});
test('不能借用其他更新锁', () => {
  const f = fixture(); try {
    assert.throws(() => runSpaceImageMaintenance({ apply: true, lockOwner: '123' }, f));
    assert(!f.state.commands.some((x) => x.includes('rm')));
  } finally { f.close(); }
});
