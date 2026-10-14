import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { planRollbackImages, readConfiguration, runMaintenance } from './rollback-image-policy.mjs';

const server = 'thesis-ledger';
const dsa = 'daily-stock-analysis';
const id = (digit) => `sha256:${digit.repeat(64)}`;
const tag = (digit, repository = server) => `${repository}:rollback-${digit.repeat(64)}`;
const image = (digit, day, repository = server, extraTags = []) => ({
  Id: id(digit), Created: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000000001Z`,
  RepoTags: [tag(digit, repository), ...extraTags],
});
const plan = (images, overrides = {}) => planRollbackImages({
  images, containers: [], repositories: [server], keepCount: 2, ...overrides,
});

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rollback-image-policy-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = {
    images: [image('a', 1), image('b', 2), image('c', 3), image('d', 4)],
    containers: [], calls: [], logs: [], snapshots: 0, statuses: 'completed', ...overrides,
  };
  const run = (binary, args) => {
    state.calls.push([binary, ...args]);
    if (binary === 'cksum') return '123 20\n';
    if (binary === 'ps') {
      if (state.failAncestry) throw new Error('ancestor query unavailable');
      return state.ancestorParent ?? '1\n';
    }
    if (binary !== 'docker') throw new Error('unexpected command');
    if (args[0] === 'context') {
      if (args[1] === 'show') return 'desktop-linux\n';
      return state.endpoint ?? 'unix:///test.sock\n';
    }
    assert.deepEqual(args.slice(0, 2), ['--context', 'desktop-linux']);
    const command = args.slice(2);
    if (command[0] === 'buildx') return state.statuses;
    if (command[0] === 'ps') {
      assert.deepEqual(command, ['ps', '-aq']);
      state.snapshots += 1;
      state.onSnapshot?.(state);
      if (state.failContainers) throw new Error('container query unavailable');
      return state.containers.map((container) => container.Id).join('\n');
    }
    if (command[0] === 'image' && command[1] === 'ls') {
      state.onImageList?.(state);
      if (state.failImages) throw new Error('image query unavailable');
      const prefix = command[command.indexOf('--filter') + 1].replace(/^reference=/, '').replace(/\*$/, '');
      return state.images.flatMap((entry) => entry.RepoTags.filter((reference) => reference.startsWith(prefix))).join('\n');
    }
    if (command[1] === 'inspect') {
      if (state.failInspect) throw new Error('inspect unavailable');
      const sources = command[0] === 'image' ? state.images : state.containers;
      const references = command.slice(4);
      return references.map((reference) => {
        const found = sources.find((entry) => entry.Id === reference || entry.RepoTags?.includes(reference));
        if (!found) throw new Error('reference missing');
        return JSON.stringify(found);
      }).join('\n');
    }
    if (command[0] === 'image' && command[1] === 'rm') {
      assert.equal(command.length, 4);
      assert.equal(command[2], '--no-prune');
      if (state.failRemoval === command[3]) throw new Error('image removal failed');
      state.images = state.images.filter((entry) => !entry.RepoTags.includes(command[3]));
      state.afterRemoval?.(state);
      return 'deleted';
    }
    throw new Error(`unexpected Docker command ${command.join(' ')}`);
  };
  state.dependencies = { run, env: { TMPDIR: directory, ...overrides.env }, log: (message) => state.logs.push(message) };
  state.lockPath = join(directory, `thesis-ledger-update-${process.getuid()}-123.lock`);
  state.removeCalls = () => state.calls.filter((call) => call.includes('rm'));
  return state;
}

test('保留最新两个历史版本，按最旧顺序淘汰', () => {
  const result = plan([image('a', 1), image('b', 2), image('c', 3), image('d', 4)]);
  assert.deepEqual(result.remove.map((entry) => entry.reference), [tag('a'), tag('b')]);
  assert.deepEqual(result.retained.map((entry) => entry.reference), [tag('d'), tag('c')]);
});

test('两个仓库分别计算名额，创建时间相同按完整 ID 稳定排序', () => {
  const result = plan([image('a', 1), image('b', 1), image('c', 1), image('d', 1, dsa), image('e', 2, dsa)],
    { keepCount: 1, repositories: [server, dsa] });
  assert.deepEqual(result.retained.map((entry) => entry.reference), [tag('a'), tag('e', dsa)]);
});

test('当前及额外标签镜像受保护，不占历史名额；共享 ID 去重', () => {
  const current = image('a', 1, server, [`${server}:dev`]);
  const result = plan([current, current, image('b', 2), image('c', 3), image('d', 4)]);
  assert.deepEqual(result.remove.map((entry) => entry.reference), [tag('b')]);
  assert.equal(result.retained.length, 3);
});

test('停止容器、不同 Worker 和本次更新前基线全部优先保护', () => {
  const result = plan([image('a', 1), image('b', 2), image('c', 3), image('d', 4)], {
    containers: [{ Image: id('a'), State: 'exited' }, { Image: id('b') }], protectedIds: [id('c')],
  });
  assert.deepEqual(result.remove.map((entry) => entry.reference), [tag('d')]);
  assert.equal(result.retained.length, 3);
});

test('保留数量不足时不移除；无关仓库不参与计划', () => {
  assert.equal(plan([image('a', 1), image('b', 2, dsa)]).remove.length, 0);
});

test('拒绝零、负数、小数、前导零、空值及不安全的数量', () => {
  for (const value of ['0', '-1', '1.5', '02', '', '9007199254740992']) {
    assert.throws(() => readConfiguration({ ROLLBACK_IMAGE_KEEP_COUNT: value }), /大于零/);
  }
  assert.equal(readConfiguration({ ROLLBACK_IMAGE_KEEP_COUNT: '3' }).keepCount, 3);
  assert.equal(readConfiguration({}).keepCount, 2);
});

test('配置保护引用去重并拒绝任意标签或命令参数', () => {
  const result = readConfiguration({ ROLLBACK_PROTECTED_IMAGES: `${id('a')}\n${tag('b')} ${id('a')}` });
  assert.equal(result.protectedReferences.length, 2);
  assert.throws(() => readConfiguration({ ROLLBACK_PROTECTED_IMAGES: '--force' }));
});

test('紧张期零目标保留全部容器、指定基线和额外标签', () => {
  const result = plan([image('a', 1), image('b', 2), image('c', 3),
    image('d', 4, server, [`${server}:recovery`]), image('e', 5)], {
    keepCount: 0, containers: [{ Image: id('b'), State: 'exited' }], protectedIds: [id('c')],
  });
  assert.deepEqual(result.remove.map((entry) => entry.reference), [tag('a'), tag('e')]);
  assert.deepEqual(new Set(result.retained.map((entry) => entry.imageId)), new Set([id('b'), id('c'), id('d')]));
});

test('只有专属容量恢复允许零目标，执行必须借用更新锁', (t) => {
  const state = fixture(t, { env: { ROLLBACK_IMAGE_KEEP_COUNT: '0' } });
  assert.throws(() => runMaintenance({ validateConfig: true }, state.dependencies));
  assert.deepEqual(runMaintenance({ validateConfig: true, spaceRecovery: true }, state.dependencies), { validated: true });
  assert.throws(() => runMaintenance({ apply: true, spaceRecovery: true }, state.dependencies), /更新锁/);
  assert.equal(state.calls.length, 0);
  for (const raw of ['-1', '1.5', '00', '9007199254740992']) {
    assert.throws(() => readConfiguration({ ROLLBACK_IMAGE_KEEP_COUNT: raw }, [], true));
  }
});

test('紧张期每次只退役一个最旧候选，无候选保持幂等', (t) => {
  const state = fixture(t, { env: { ROLLBACK_IMAGE_KEEP_COUNT: '0' },
    containers: [{ Id: 'running', Image: id('d') }] });
  mkdirSync(state.lockPath);
  writeFileSync(join(state.lockPath, 'pid'), `${process.ppid}\n`);
  const options = { target: 'all', apply: true, spaceRecovery: true, lockOwner: String(process.ppid) };
  for (const digit of ['a', 'b', 'c']) {
    const result = runMaintenance(options, state.dependencies);
    assert.deepEqual(result.removed, [tag(digit)]);
  }
  assert.deepEqual(runMaintenance(options, state.dependencies), { removed: [], skipped: [] });
  assert.equal(state.removeCalls().length, 3);
  assert.equal(state.images[0].Id, id('d'));
  assert.equal(existsSync(state.lockPath), true);
});

test('紧张期候选刚被容器引用时不删除，也不继续清下一候选', (t) => {
  const state = fixture(t, { env: { ROLLBACK_IMAGE_KEEP_COUNT: '0' }, onSnapshot(current) {
    if (current.snapshots === 2) current.containers.push({ Id: 'new-container', Image: id('a') });
  } });
  mkdirSync(state.lockPath);
  writeFileSync(join(state.lockPath, 'pid'), `${process.ppid}\n`);
  const result = runMaintenance({ apply: true, spaceRecovery: true, lockOwner: String(process.ppid) }, state.dependencies);
  assert.deepEqual(result, { removed: [], skipped: [tag('a')] });
  assert.equal(state.removeCalls().length, 0);
});

test('标签身份冲突、缺失时间、非法引用或容器身份停止规划', () => {
  assert.throws(() => plan([{ ...image('a', 1), RepoTags: [tag('b')] }]), /不一致/);
  assert.throws(() => plan([{ ...image('a', 1), Created: 'invalid' }]), /时间/);
  assert.throws(() => plan([image('a', 1)], { containers: [{ Image: '' }] }), /SHA256/);
});

test('默认入口只读，实际命令绑定同一 context', (t) => {
  const state = fixture(t);
  const result = runMaintenance({ target: 'thesis-ledger' }, state.dependencies);
  assert.equal(result.remove.length, 2);
  assert.equal(state.removeCalls().length, 0);
  assert.equal(existsSync(state.lockPath), false);
});

test('配置预检不调用 Docker；错误目标与配置也不产生副作用', (t) => {
  const state = fixture(t);
  assert.deepEqual(runMaintenance({ validateConfig: true }, state.dependencies), { validated: true });
  assert.throws(() => runMaintenance({ target: 'other', apply: true }, state.dependencies));
  assert.equal(state.calls.length, 0);
});

test('应用精确非强制标签移除并释放更新锁，第二次幂等', (t) => {
  const state = fixture(t);
  const result = runMaintenance({ target: 'thesis-ledger', apply: true }, state.dependencies);
  assert.deepEqual(result.removed, [tag('a'), tag('b')]);
  assert.equal(state.removeCalls().length, 2);
  assert.equal(state.calls.some((call) => call.includes('--force') || call.includes('prune')), false);
  assert.equal(existsSync(state.lockPath), false);
  assert.equal(runMaintenance({ target: 'thesis-ledger', apply: true }, state.dependencies).removed.length, 0);
});

test('新出现的容器引用使计划候选跳过', (t) => {
  const state = fixture(t, { onSnapshot(current) {
    if (current.snapshots === 2) current.containers.push({ Id: 'container-1', Image: id('a') });
  } });
  const result = runMaintenance({ target: 'thesis-ledger', apply: true }, state.dependencies);
  assert.ok(result.skipped.includes(tag('a')));
  assert.equal(state.removeCalls().some((call) => call.includes(tag('a'))), false);
});

test('新出现的额外标签使候选跳过', (t) => {
  let lists = 0;
  const state = fixture(t, { onImageList(current) {
    lists += 1;
    if (lists === 2) current.images[0].RepoTags.push(`${server}:recovery`);
  } });
  const result = runMaintenance({ target: 'thesis-ledger', apply: true }, state.dependencies);
  assert.ok(result.skipped.includes(tag('a')));
});

test('指定完整 ID 和回滚标签均保护且计入历史名额', (t) => {
  const state = fixture(t, { env: { ROLLBACK_PROTECTED_IMAGES: `${id('a')} ${tag('b')}` } });
  const result = runMaintenance({ target: 'thesis-ledger', apply: true }, state.dependencies);
  assert.deepEqual(result.removed, [tag('c'), tag('d')]);
});

test('保护引用消失时停止清退，查询失败不等于缺失', (t) => {
  const state = fixture(t, { env: { ROLLBACK_PROTECTED_IMAGES: id('f') } });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /reference missing/);
  assert.equal(state.removeCalls().length, 0);
});

test('Docker 列表或 inspect 失败时不移除镜像', (t) => {
  for (const failure of ['failImages', 'failContainers', 'failInspect']) {
    const state = fixture(t, { [failure]: true });
    assert.throws(() => runMaintenance({ apply: true }, state.dependencies));
    assert.equal(state.removeCalls().length, 0);
    assert.equal(existsSync(state.lockPath), false);
  }
});

test('活动构建阻止清退并释放锁', (t) => {
  const state = fixture(t, { statuses: 'running' });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /活动构建/);
  assert.equal(state.removeCalls().length, 0);
  assert.equal(existsSync(state.lockPath), false);
});

test('计划复核期间出现活动构建时在移除之前停止', (t) => {
  const state = fixture(t, { onSnapshot(current) {
    if (current.snapshots === 2) current.statuses = 'pending';
  } });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /活动构建/);
  assert.equal(state.removeCalls().length, 0);
});

test('首项移除后出现活动构建时停止后续移除', (t) => {
  const state = fixture(t, { afterRemoval(current) { current.statuses = 'running'; } });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /活动构建/);
  assert.equal(state.removeCalls().length, 1);
});

test('候选标签身份变化停止清退', (t) => {
  let lists = 0;
  const state = fixture(t, { onImageList(current) {
    lists += 1;
    if (lists === 2) current.images[0].Id = id('f');
  } });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /不一致/);
  assert.equal(state.removeCalls().length, 0);
});

test('部分删除失败保留已执行记录并停止后续移除', (t) => {
  const state = fixture(t, { failRemoval: tag('b') });
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /removal failed/);
  assert.equal(state.removeCalls().length, 2);
  assert.ok(state.logs.some((message) => message.includes(`已移除回滚标签: ${tag('a')}`)));
  assert.equal(existsSync(state.lockPath), false);
});

test('独立维护不能抢占更新锁；借用锁核对父进程身份且不释放原锁', (t) => {
  const state = fixture(t);
  mkdirSync(state.lockPath);
  const pidPath = join(state.lockPath, 'pid');
  writeFileSync(pidPath, '999999\n');
  assert.throws(() => runMaintenance({ apply: true }, state.dependencies), /更新锁/);
  assert.throws(() => runMaintenance({ apply: true, lockOwner: '999999' }, state.dependencies), /其他进程/);
  assert.equal(state.removeCalls().length, 0);
  writeFileSync(pidPath, `${process.ppid}\n`);
  runMaintenance({ target: 'thesis-ledger', apply: true, lockOwner: String(process.ppid) }, state.dependencies);
  assert.equal(readFileSync(pidPath, 'utf8').trim(), String(process.ppid));
});

test('拒绝远端 context 和 DOCKER_HOST 覆盖', (t) => {
  for (const overrides of [{ endpoint: 'tcp://remote:2375' }, { env: { DOCKER_HOST: 'unix:///other.sock' } }]) {
    const state = fixture(t, overrides);
    assert.throws(() => runMaintenance({ apply: true }, state.dependencies));
    assert.equal(state.removeCalls().length, 0);
  }
});

test('非祖先进程、祖先查询失败或循环不能借锁', (t) => {
  for (const overrides of [{}, { failAncestry: true }, { ancestorParent: `${process.ppid}\n` }]) {
    const state = fixture(t, overrides);
    mkdirSync(state.lockPath);
    writeFileSync(join(state.lockPath, 'pid'), '999999\n');
    assert.throws(() => runMaintenance({ apply: true, lockOwner: '999999' }, state.dependencies));
    assert.equal(state.removeCalls().length, 0);
    assert.equal(existsSync(state.lockPath), true);
  }
});

test('真实 Bash 条件函数与临时环境变量产生中间父进程时仍可借锁', (t) => {
  const state = fixture(t);
  mkdirSync(state.lockPath);
  const moduleUrl = pathToFileURL(join(import.meta.dirname, 'rollback-image-policy.mjs')).href;
  const code = `
    import { execFileSync } from 'node:child_process';
    import { runMaintenance } from ${JSON.stringify(moduleUrl)};
    const context = 'desktop-linux';
    const run = (binary, args) => {
      if (binary === 'ps') return execFileSync(binary, args, { encoding: 'utf8' });
      if (binary === 'cksum') return '123 20';
      if (binary !== 'docker') throw new Error('unexpected command');
      if (args[0] === 'context' && args[1] === 'show') return context;
      if (args[0] === 'context' && args[1] === 'inspect') return 'unix:///test.sock';
      const command = args.slice(2);
      if (command[0] === 'buildx') return 'Completed';
      if (command[0] === 'ps' || command[0] === 'image' && command[1] === 'ls') return '';
      throw new Error('unexpected Docker mutation');
    };
    runMaintenance({ target: 'thesis-ledger', apply: true, lockOwner: process.argv[2] }, {
      run, env: { TMPDIR: process.argv[1] }, log: () => {},
    });
    console.log('borrowed');
  `;
  const shell = `
    printf '%s\\n' "$$" > "$3/pid"
    maintain() { DOCKER_CONTEXT=desktop-linux node --input-type=module -e "$2" "$1" "$3"; }
    if ! maintain "$1" "$2" "$$"; then exit 1; fi
    cat "$3/pid"
  `;
  const output = execFileSync('bash', ['-euc', shell, 'rollback-lock-test', state.dependencies.env.TMPDIR, code, state.lockPath], { encoding: 'utf8' });
  assert.ok(output.includes('borrowed'));
  assert.equal(readFileSync(join(state.lockPath, 'pid'), 'utf8').trim(), output.trim().split('\n').at(-1));
});
