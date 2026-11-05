import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker } from './research-state-backup.mjs';

function jsManifest(root, fsApi, pathApi, cryptoApi) {
  const files = [];
  function visit(directory) {
    for (const entry of fsApi.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = pathApi.join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.js')) files.push({ path: pathApi.relative(root, path),
        sha256: cryptoApi.createHash('sha256').update(fsApi.readFileSync(path)).digest('hex') });
    }
  }
  visit(root); return files;
}

export function auditDualReadInputs(container, main) {
  const fsApi = { readFileSync, readdirSync }, pathApi = { join, relative }, cryptoApi = { createHash };
  const host = jsManifest(resolve(main, 'packages/schemas/dist'), fsApi, pathApi, cryptoApi);
  const active = host.filter(file => existsSync(resolve(main, 'packages/schemas/src', file.path.replace(/\.js$/, '.ts'))));
  const stale = host.filter(file => !active.includes(file));
  // tsc 不清理已删源码的旧输出；它们必须没有源码，也没有任何有效模块的引用。
  for (const file of active) {
    const source = readFileSync(resolve(main, 'packages/schemas/dist', file.path), 'utf8');
    for (const orphan of stale) {
      const importPath = './' + relative(dirname(file.path), orphan.path).replaceAll('\\', '/');
      assert(!source.includes(importPath), `有效 Schema 仍引用无源码产物：${orphan.path}`);
    }
  }
  const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const manifest=${jsManifest.toString()};
    console.log(JSON.stringify(manifest(path.dirname(require.resolve('@thesis-ledger/schemas')),fs,path,crypto)));`;
  const image = JSON.parse(docker(['exec', container, 'node', '-e', program]));
  const imageByPath = new Map(image.map(file => [file.path, file.sha256]));
  const mismatch = active.filter(file => imageByPath.get(file.path) !== file.sha256).map(file => file.path);
  assert(active.length === image.length && mismatch.length === 0,
    `宿主 SDK 有效 Schema 与镜像不一致：${mismatch.slice(0, 8).join(',') || '文件集合不同'}`);
  const sdk = jsManifest(resolve(main, 'packages/api-client/dist'), fsApi, pathApi, cryptoApi);
  const infraScripts = dirname(fileURLToPath(import.meta.url));
  const scripts = [
    resolve(main, 'scripts/research-dual-read-fixtures.mjs'),
    resolve(main, 'scripts/research-dual-read-sdk.mjs'),
    resolve(main, 'packages/schemas/fixtures/research-v2.samples.json'),
    ...['research-dual-read.mjs', 'research-dual-read-runtime.mjs', 'research-dual-read-inputs.mjs']
      .map(name => resolve(infraScripts, name)),
  ];
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { schemaJsFiles: image.length, schemaSha256: hash(image), unreferencedStaleSchemaJsFiles: stale.length,
    sdkJsFiles: sdk.length, sdkSha256: hash(sdk),
    acceptanceSha256: hash(scripts.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))) };
}
