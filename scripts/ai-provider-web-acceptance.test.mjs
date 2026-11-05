import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureInput, stalePriorityInput, webAcceptanceArguments } from './ai-provider-web-acceptance.mjs';

test('固定专属配置不会启用、携带凭证或配置业务用途', () => {
  assert.equal(fixtureInput.enabled, false); assert.equal(fixtureInput.authMode, 'none');
  assert.equal(fixtureInput.apiKey, undefined); assert.equal(fixtureInput.credentialsRef, undefined);
  assert.deepEqual(fixtureInput.executionRoutes, []);
  assert.equal(new URL(fixtureInput.baseUrl).hostname, '127.0.0.1');
});

test('拒绝非登记目标和未知模式', () => {
  const args = ['plan', '--target', 'thesis-ledger-dev', '--output', '/tmp/web-receipt'];
  assert.equal(webAcceptanceArguments(args).mode, 'plan');
  assert.equal(webAcceptanceArguments(['verify-conflict', ...args.slice(1)]).mode, 'verify-conflict');
  assert.throws(() => webAcceptanceArguments(['prepare', '--target', 'other', ...args.slice(3)]));
  assert.throws(() => webAcceptanceArguments(['wipe', ...args.slice(1)]));
});

test('过期提交只允许同一停用无凭证专属配置的原优先级及明确旧版本', () => {
  const revision = '2026-10-20T09:00:00.000Z';
  assert.deepEqual(stalePriorityInput(revision), { ...fixtureInput, expectedRevision: revision });
  assert.throws(() => stalePriorityInput(undefined)); assert.throws(() => stalePriorityInput('invalid'));
  assert.equal(stalePriorityInput(revision).enabled, false);
  assert.deepEqual(stalePriorityInput(revision).executionRoutes, []);
});
