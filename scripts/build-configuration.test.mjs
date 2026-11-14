import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { LocalDocker } from './runtime/docker.mjs';
import { BuildSpace } from './runtime/space.mjs';
import { BuildPlan } from './runtime/build.mjs';

test('正式构建使用应用原始 Dockerfile，结构化合并参数与应用上下文', async () => {
  const runtime = new LocalDocker({ env: { ...process.env, ENV_FILE: '.env.example' } });
  runtime.configureCompose(); await runtime.connect();
  const build = new BuildPlan(runtime, new BuildSpace(runtime), { target: 'all' });
  try {
    await build.configuration();
    const declared = JSON.parse(readFileSync(build.override, 'utf8')).services.dsa.build;
    const config = JSON.parse(await runtime.compose(['config', '--format', 'json']));
    const dsa = config.services.dsa.build, server = config.services['thesis-ledger'].build;
    assert.equal(dsa.dockerfile, 'docker/Dockerfile');
    assert.equal(server.dockerfile, 'infra/docker/server.Dockerfile');
    assert.equal(dsa.args.PYTHON_IMAGE, 'thesis-ledger-local-python:3.11-slim-bookworm');
    assert.equal(server.args.NODE_IMAGE, 'thesis-ledger-local-node:24-alpine');
    assert.equal(server.args.NPM_REGISTRY, 'https://registry.npmmirror.com');
    assert.equal(server.args.NODE_DIST_URL, 'https://npmmirror.com/mirrors/node');
    assert.deepEqual(dsa.additional_contexts, declared.additional_contexts);
    assert.deepEqual(config.services['backtest-worker'].build, server);
    const bake = JSON.parse(await runtime.compose(['build', '--print', 'dsa', 'thesis-ledger']));
    assert.equal(resolve(bake.target.dsa.context, bake.target.dsa.dockerfile), resolve(runtime.root, '../daily-stock-analysis/docker/Dockerfile'));
    assert.equal(resolve(bake.target['thesis-ledger'].context, bake.target['thesis-ledger'].dockerfile), resolve(runtime.root, '../thesis-ledger/infra/docker/server.Dockerfile'));
    assert.deepEqual(bake.target.dsa.contexts, declared.additional_contexts);
  } finally { await build.cleanup(); }
});
