import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCopyArguments, providerCopyBootstrap } from './ai-provider-copy-acceptance.mjs';

test('只接受固定目标与明确的基线、输出参数', () => {
  const args = ['--target', 'thesis-ledger-dev', '--baseline', '/tmp/baseline', '--output', '/tmp/output'];
  assert.deepEqual(providerCopyArguments(args), { baseline: '/tmp/baseline', output: '/tmp/output' });
  assert.throws(() => providerCopyArguments(['--target', 'other', ...args.slice(2)]));
  assert.throws(() => providerCopyArguments([...args, '--database', 'production']));
});

test('待执行源文本作为单个文件内容封装，不能突破写入边界', () => {
  assert.throws(() => providerCopyBootstrap(null));
  const source = '`;process.exit(99);//\n${unsafe}';
  assert(providerCopyBootstrap(source).includes(JSON.stringify(source)));
});
