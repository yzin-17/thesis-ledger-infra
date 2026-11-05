import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkOutputDirectory, sql, target } from './research-state-backup.mjs';
import { sourceState } from './research-dual-read.mjs';

export const fixtureName = 'controlled-web-save-20261020';
export const fixtureInput = Object.freeze({ name: fixtureName, baseUrl: 'http://127.0.0.1:19877/v1',
  models: ['controlled-no-generation'], authMode: 'none', upstreamFormat: 'chat-completions',
  chatImplementation: 'compatible', enabled: false, priority: 991, capabilities: ['chat'],
  executionRoutes: [], modelPricing: {} });
const format = 'ai-provider-web-acceptance-v1';
const fingerprintSql = excludeFixture => `SELECT json_build_object(
 'configs',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "ProviderConfig" t${excludeFixture ? ` WHERE name<>'${fixtureName}'` : ''}),
 'routing',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "AiRoutingSettings" t));`;
const snapshot = (excludeFixture = false) => { const s = sourceState(); return { ...s.state,
  configuration: sql(s.containers.postgres.Id, fingerprintSql(excludeFixture)) }; };

export function stalePriorityInput(revision) {
  assert.equal(typeof revision, 'string'); assert(Number.isFinite(Date.parse(revision)));
  return { ...fixtureInput, expectedRevision: revision };
}

export function webAcceptanceArguments(args) {
  assert.equal(args.length, 5);
  const [mode, flag, selected, outputFlag, output] = args;
  assert(['plan', 'prepare', 'verify-conflict', 'finish'].includes(mode));
  assert.equal(flag, '--target'); assert.equal(selected, target);
  assert.equal(outputFlag, '--output'); assert(output);
  return { mode, output };
}

async function api(method = 'GET', body, expectedStatus) {
  assert(['GET', 'POST', 'DELETE'].includes(method));
  if (method === 'POST') assert.deepEqual(body, expectedStatus === 409 ? stalePriorityInput(body.expectedRevision) : fixtureInput);
  const path = method === 'DELETE' ? '/' + encodeURIComponent(fixtureName) : '';
  const response = await fetch('http://127.0.0.1:3000/api/v1/ai/providers' + path, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
  });
  let successStatus = 200;
  if (expectedStatus !== undefined) successStatus = expectedStatus;
  else if (method === 'POST') successStatus = 201;
  assert.equal(response.status, successStatus, '专属配置请求失败');
  return response.json();
}

export async function providerWebAcceptance({ mode, output }) {
  if (mode === 'plan') {
    const before = snapshot(), list = await api();
    assert(!list.some(row => row.name === fixtureName), '专属名称已经存在，禁止接管');
    const plan = { format, target, fixture: fixtureInput, edit: { priority: 992 },
      completion: '删除本轮专属配置，原配置/默认/保护表/调用事实逐项相等',
      existingProviders: list.length, researchV2WritesEnabled: before.pauseFlags.AI_RESEARCH_V2_WRITES_ENABLED === 'true',
      requiresExplicitAuthorization: true, targetWritten: false };
    console.log(JSON.stringify(plan)); return plan;
  }
  if (mode === 'prepare') {
    checkOutputDirectory(output);
    const before = snapshot(), list = await api();
    assert(!list.some(row => row.name === fixtureName), '专属名称已经存在，禁止接管');
    mkdirSync(output, { mode: 0o700 });
    // 先落保护回执，创建失败时也能沿同一入口核对和清理。
    writeFileSync(resolve(output, 'receipt.json'), JSON.stringify({ format, target, output: realpathSync(output), before }),
      { mode: 0o600, flag: 'wx' });
    const saved = await api('POST', fixtureInput);
    assert.equal(saved.enabled, false); assert.equal(saved.credentialConfigured, false);
    writeFileSync(resolve(output, 'prepared.json'), JSON.stringify({ name: fixtureName, revision: saved.updatedAt }),
      { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, name: fixtureName, priority: saved.priority,
      enabled: false, credentialConfigured: false, realModelRequests: 0 }));
    return;
  }
  assert.equal(realpathSync(output), resolve(output), '不接受回执路径符号链接');
  const receipt = JSON.parse(readFileSync(resolve(output, 'receipt.json')));
  assert.equal(receipt.format, format); assert.equal(receipt.target, target); assert.equal(receipt.output, resolve(output));
  const current = snapshot();
  assert.deepEqual(current.identities, receipt.before.identities, '目标容器身份改变，禁止清理未知配置');
  const list = await api(), row = list.find(value => value.name === fixtureName);
  assert(row, '未找到本轮专属配置');
  assert.equal(row.enabled, false); assert.equal(row.credentialConfigured, false);
  assert.equal(row.authMode, 'none'); assert.equal(row.baseUrl, fixtureInput.baseUrl);
  assert.deepEqual(row.models, fixtureInput.models);
  assert([991, 992].includes(row.priority), '专属配置发生范围外变更');
  assert.equal((row.executionRouteConfigs ?? []).length, 0);
  if (mode === 'verify-conflict') {
    assert.equal(row.priority, 992, '先由实际 Web 完成专属优先级保存');
    const prepared = JSON.parse(readFileSync(resolve(output, 'prepared.json')));
    assert.equal(prepared.name, fixtureName); assert.notEqual(prepared.revision, row.updatedAt);
    assert.deepEqual(snapshot(true), receipt.before, '原配置、默认或业务状态在检查前已变化');
    await api('POST', stalePriorityInput(prepared.revision), 409);
    const after = (await api()).find(value => value.name === fixtureName);
    assert.equal(after.priority, 992); assert.equal(after.updatedAt, row.updatedAt);
    assert.deepEqual(snapshot(true), receipt.before, '冲突拒绝改变原配置、默认或业务状态');
    const result = { passed: true, staleSaveStatus: 409, priorityPreserved: true,
      revisionPreserved: true, originalConfigurationPreserved: true, realModelRequests: 0 };
    writeFileSync(resolve(output, 'conflict.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(result)); return result;
  }
  assert.equal(mode, 'finish');
  const removed = await api('DELETE', { expectedRevision: row.updatedAt });
  assert.equal(removed.deleted, true);
  assert.deepEqual(snapshot(), receipt.before, '清理后原配置、路由或业务保护状态有差异');
  const result = { format, passed: row.priority === 992, createdAt: new Date().toISOString(), fixtureRemoved: true,
    webSavedPriority: row.priority, existingConfigurationPreserved: true, protectedDataPreserved: true,
    realModelRequests: 0, boundary: '目标 Web 普通保存停用且无凭证/无用途的专属配置；真实连接与生成继续暂停。' };
  if (existsSync(resolve(output, 'conflict.json')))
    result.providerVersionConflict = JSON.parse(readFileSync(resolve(output, 'conflict.json')));
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result)); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await providerWebAcceptance(webAcceptanceArguments(process.argv.slice(2)));
