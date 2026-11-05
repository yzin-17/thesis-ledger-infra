import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reportTargetIdentity } from './report-metadata-admission.mjs';

export function routePlan(args) {
  const values = new Map();
  for (const arg of args) {
    const pair = /^--(mode|output|plan|confirm|owned-plan)=(.+)$/u.exec(arg);
    assert(pair && !values.has(pair[1]), '未知或重复参数');
    values.set(pair[1], pair[2]);
  }
  const mode = values.get('mode') ?? 'plan';
  assert(['plan', 'apply'].includes(mode));
  const output = values.get('output');
  assert(output && isAbsolute(output), '需要绝对证据路径');
  if (mode === 'apply') {
    assert(values.has('plan') && isAbsolute(values.get('plan')));
    assert.equal(values.get('confirm'), 'thesis-ledger-dev/reference-routes/append-only');
  } else assert(!values.has('plan') && !values.has('confirm'));
  if (values.has('owned-plan')) assert(mode === 'apply' && isAbsolute(values.get('owned-plan')));
  return { mode, output: resolve(output), plan: values.get('plan') ?? null, ownedPlan: values.get('owned-plan') ?? null };
}

export function withServerPlan(dsa, server) {
  assert(server.contractVersion === 3 && server.enabled && server.syncState === 'applied' && server.effectiveStale === false, 'Server 原策略尚未稳定应用');
  assert.equal(server.revision, dsa.previousRevision, 'Server 与 DSA 原策略修订不同');
  assert.deepEqual(server.routes, dsa.previousRoutes, 'Server 与 DSA 原策略路由不同');
  return { dsa, serverRevision: server.revision, serverRoutes: server.routes, enabled: server.enabled };
}

export function mergedReferenceRoutes(current, ownedPlan) {
  const retired = current.dsa.retirements ?? [];
  for (const route of retired) {
    assert(ownedPlan?.dsa.additions.some((item) => isDeepStrictEqual(item, route)), '只能撤销首次计划实际创建的路由');
    assert(!ownedPlan.serverRoutes.some((item) => isDeepStrictEqual(item.key, route.key)), '不能撤销原有路由');
  }
  return [...current.serverRoutes.filter((route) => !retired.some((item) => isDeepStrictEqual(item, route))), ...current.dsa.additions];
}

export async function main(args) {
  const plan = routePlan(args);
  const run = (cmd, argv, input) => execFileSync(cmd, argv, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 }).trim();
  const docker = (...argv) => run('docker', argv);
  assert(!process.env.DOCKER_HOST && !process.env.BUILDX_BUILDER);
  assert.equal(docker('context', 'show'), 'desktop-linux');
  const endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}');
  assert(endpoint.startsWith('unix://'));
  const lock = join(tmpdir(), `thesis-ledger-update-${process.getuid()}-${run('cksum', [], endpoint).split(/\s/u)[0]}.lock`);
  mkdirSync(lock);
  try {
    const identity = reportTargetIdentity(JSON.parse(docker('inspect', 'thesis-ledger-dev-dsa-1'))[0]);
    const worker = readFileSync(new URL('./market-reference-routes.py', import.meta.url), 'utf8');
    const readDsa = () => JSON.parse(run('docker', ['exec', '-i', '--user', 'dsa:dsa', identity.id, 'python', '-B', '-c', worker], JSON.stringify({ mode: 'plan', expected: null })));
    const api = async (method = 'GET', body) => {
      const response = await fetch('http://127.0.0.1:3000/api/market-data/policy', { method,
        headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, 'Server 策略请求失败；不自动重试');
      return response.json();
    };
    const current = withServerPlan(readDsa(), await api());
    writeFileSync(plan.output + '.permit', JSON.stringify({ mode: plan.mode, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    let receipt = current;
    if (plan.mode === 'apply') {
      const expected = JSON.parse(readFileSync(plan.plan, 'utf8'));
      assert.deepEqual(current, expected, '计划后控制或来源绑定变化，拒绝陈旧应用');
      if (current.dsa.additions.length || current.dsa.retirements.length) {
        const revision = current.serverRevision + 1;
        const ownedPlan = plan.ownedPlan ? JSON.parse(readFileSync(plan.ownedPlan, 'utf8')) : null;
        const routes = mergedReferenceRoutes(current, ownedPlan);
        const applied = await api('PUT', { contractVersion: 3, consumer: 'thesis-ledger', requestId: randomUUID(),
          revision, expectedRevision: current.serverRevision, enabled: current.enabled, routes });
        assert.equal(applied.revision, revision);
        const after = withServerPlan(readDsa(), await api());
        assert.deepEqual(after.serverRoutes, routes, '应用后路由与增量计划不符');
        assert.deepEqual(after.dsa.protected, current.dsa.protected, '原 Provider／准入保护未通过');
        receipt = { revision, added: current.dsa.additions.length, retired: current.dsa.retirements.length,
          preservedRoutes: current.serverRoutes.length - current.dsa.retirements.length,
          protectionPassed: true, changed: true, effective: applied.effectiveProjection };
      } else receipt = { revision: current.serverRevision, changed: false, protectionPassed: true };
    }
    assert.deepEqual(reportTargetIdentity(JSON.parse(docker('inspect', 'thesis-ledger-dev-dsa-1'))[0]), identity);
    writeFileSync(plan.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { mode: plan.mode, path: plan.output, ...(plan.mode === 'plan' ? { additions: receipt.dsa.additions.length, retirements: receipt.dsa.retirements.length } : { revision: receipt.revision, changed: receipt.changed, protectionPassed: receipt.protectionPassed, added: receipt.added ?? 0, retired: receipt.retired ?? 0 }) };
  } finally { rmdirSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await main(process.argv.slice(2))));
