import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { inspect } from 'node:util';
import { CommandFailure, createRunner, createSyncRunner } from './runtime/process.mjs';
import { LocalDocker } from './runtime/docker.mjs';
import { booleanOption, positiveInteger, selectTarget } from './runtime/options.mjs';

test('受控参数与原目标保持，拒绝无效布尔值和超范围整数', () => {
  assert.deepEqual(selectTarget('all'), ['dsa', 'thesis-ledger']);
  assert.throws(() => selectTarget('other'));
  assert.equal(booleanOption({ OPTION: 'yes' }, 'OPTION'), true);
  assert.throws(() => booleanOption({ OPTION: 'invalid' }, 'OPTION'));
  for (const value of ['0', 'x', '9007199254740993']) assert.throws(() => positiveInteger(value, 'timeout'));
});

test('进程参数不经 Shell，保留标准输入与失败退出码', async () => {
  const run = createRunner();
  const argument = '$(echo must-not-run); literal';
  const result = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  assert.equal(result, argument);
  assert.equal(await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'original bytes' }), 'original bytes');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(17)']), error => error.code === 17);
  const unicode = await run(process.execPath, ['-e', 'for(const byte of Buffer.from("中文")){process.stdout.write(Buffer.from([byte]));await new Promise(done=>setTimeout(done,2));}', '--input-type=module']);
  assert.equal(unicode, '中文');
});

test('同步执行保留二进制、文件流和错误码，输入不经 Shell', t => {
  const directory = mkdtempSync(join(tmpdir(), 'infra-binary-runner-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const run = createSyncRunner(), bytes = Buffer.from([0, 255, 128, 10]);
  assert.deepEqual(run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { encoding: null, input: bytes }), bytes);
  const fd = openSync(join(directory, 'stream'), 'wx');
  try { run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: bytes, stdio: ['pipe', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  assert.deepEqual(readFileSync(join(directory, 'stream')), bytes);
  const literal = '$(must-not-run); literal';
  assert.equal(run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]), literal);
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(17)']), error => error.code === 17);
  assert.throws(() => run(join(directory, 'missing'), []), error => error.code === 127);
});

test('错误输出保留给受控诊断，默认异常打印不暴露备份内容', () => {
  const failure = new CommandFailure('docker', 17, 'private-backup-bytes', 'private-diagnostic');
  assert.equal(failure.stdout, 'private-backup-bytes');
  assert.equal(failure.stderr, 'private-diagnostic');
  assert(!inspect(failure).includes('private-backup-bytes'));
  assert(!inspect(failure).includes('private-diagnostic'));
});

test('取消运行同时终止应用派生进程，关闭输出后才完成失败', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'infra-cancel-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'unexpected-write'), controller = new AbortController();
  const descendant = `process.stdout.write('ready');setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'written'),250);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000);`;
  await assert.rejects(createRunner({ signal: controller.signal })(process.execPath, ['-e', parent, descendant, marker], {
    onOutput: value => { if (value.includes('ready')) controller.abort(); },
  }), error => error.code === 130);
  assert(!existsSync(marker));
});

test('从标准输入导入公开模块不会误执行 CLI 或解析虚拟文件名', async () => {
  const modules = ['infra.mjs', 'check-runtime.mjs', 'dsa-runtime-recovery.mjs', 'docker-desktop-disk.mjs']
    .map(name => new URL('./' + name, import.meta.url).href);
  const result = await createRunner()(process.execPath, ['--input-type=module', '-'], {
    input: `for(const url of ${JSON.stringify(modules)})await import(url);process.stdout.write('imported');`,
  });
  assert.equal(result, 'imported');
});

function fixture(t, override = {}) {
  const root = mkdtempSync(join(tmpdir(), 'node-infra-runtime-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'ps') return '1';
    if (binary === 'cksum') return '123 20';
    if (args[0] === 'context') return args[1] === 'show' ? 'local' : (override.endpoint ?? 'unix:///controlled.sock');
    if (args.includes('history')) return override.status ?? 'Completed';
    if (args.includes('inspect')) return 'Driver: docker\nEndpoint: local';
    throw new Error('未声明操作');
  };
  return { root, calls, runtime: new LocalDocker({ root, env: { TMPDIR: root, ...override.env }, run, log() {} }) };
}

test('固定本地 context，拒绝远端、覆盖和活动构建', async t => {
  for (const override of [{ endpoint: 'tcp://remote' }, { env: { DOCKER_HOST: 'unix:///other' } }]) {
    await assert.rejects(fixture(t, override).runtime.connect());
  }
  const { runtime, calls } = fixture(t, { status: 'Running' });
  await runtime.connect(); await runtime.requireLocalBuilder();
  await assert.rejects(runtime.idle());
  assert(calls.some(args => args.slice(0, 3).join(' ') === 'docker --context local'));
});

test('异步操作结束前保持互斥，失败后释放，既有锁不删除', async t => {
  const { runtime } = fixture(t); await runtime.connect();
  let release;
  const pending = runtime.locked(() => new Promise(done => { release = done; }));
  await new Promise(done => setImmediate(done));
  assert.equal(readFileSync(join(runtime.lockPath, 'pid'), 'utf8').trim(), String(process.pid));
  assert(existsSync(runtime.lockPath)); release(); await pending;
  assert(!existsSync(runtime.lockPath));
  await assert.rejects(runtime.locked(async () => { throw new Error('controlled'); }));
  assert(!existsSync(runtime.lockPath));
  mkdirSync(runtime.lockPath);
  await assert.rejects(runtime.locked(() => assert.fail()));
  assert(existsSync(runtime.lockPath));
});
