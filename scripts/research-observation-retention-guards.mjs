import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertOwned, labelKey } from './research-dual-read-runtime.mjs';
import { target } from './research-state-backup.mjs';

export const retentionTables = ['AiRun', 'AiToolCall', 'ResearchObservation', 'ResearchObservationVersion',
  'ResearchObservationSubmission', 'JournalEntry', 'JournalReviewSnapshot',
  'ProviderConfig', 'AiRoutingSettings', 'AiInvocation', 'AiInvocationFact'];
export const retentionSql = `SELECT json_build_object('tables',json_build_object(${retentionTables.map(name =>
  `'${name}',json_build_object('count',(SELECT count(*) FROM "${name}"),'md5',
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "${name}" t))`).join(',')}));`;

export function retentionArguments(args) {
  assert.equal(args.length, 8);
  const [targetFlag, selected, upgradeFlag, upgrade, compatibleFlag, compatible, outputFlag, output] = args;
  assert.equal(targetFlag, '--target'); assert.equal(selected, target);
  assert.equal(upgradeFlag, '--upgrade-receipt'); assert.equal(compatibleFlag, '--compatible-baseline');
  assert.equal(outputFlag, '--output'); assert(upgrade && compatible && output);
  return { upgrade, compatible, output };
}

export function assertUpgradeInput(image, recorded, main) {
  assert.deepEqual(image, recorded, '当前镜像结构输入与正式升级回执不一致');
  const directory = resolve(main, 'apps/server/prisma/migrations');
  assert.deepEqual(readdirSync(directory).filter(name => /^\d{14}_/.test(name)).sort(),
    image.migrations.map(item => item.name), '现行 migration 清单已变化，必须重新走正式更新');
  for (const migration of image.migrations) {
    assert(/^\d{14}_[a-z0-9_]+$/.test(migration.name));
    assert.equal(readFileSync(resolve(main, 'apps/server/prisma/migrations', migration.name, 'migration.sql'), 'utf8'),
      migration.sql, '现行源码 migration 已变化，必须重新走正式更新');
  }
  assert.equal(image.currentHead, image.migrations.at(-1).name);
  assert(image.expectedTables.includes('ResearchObservationVersion'));
}

export function retentionStructureSql(expectedTables) {
  assert(expectedTables.length > 0 && expectedTables.every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)));
  const names = expectedTables.map(name => `('${name}')`).join(',');
  return `WITH expected(name) AS (VALUES ${names}) SELECT json_build_object(
    'missing',(SELECT coalesce(json_agg(name ORDER BY name),'[]'::json) FROM expected WHERE to_regclass(format('public.%I',name)) IS NULL),
    'unreadable',(SELECT coalesce(json_agg(name ORDER BY name),'[]'::json) FROM expected WHERE
      NOT has_table_privilege('thesis_ledger_app',format('public.%I',name),'SELECT')),
    'observationInsert',(SELECT bool_and(has_table_privilege('thesis_ledger_app',format('public.%I',name),'INSERT'))
      FROM expected WHERE name IN ('ResearchObservation','ResearchObservationVersion','ResearchObservationSubmission')));`;
}

export function compatibleServerArgs(value, image, postgres, token) {
  assertOwned(value, token, 'server');
  assert(/^sha256:[a-f0-9]{64}$/.test(image) && /^[a-f0-9]{64}$/.test(postgres));
  const environment = Object.fromEntries(value.Config.Env.map(item => {
    const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)];
  }));
  assert.equal(environment.NODE_ENV, 'test');
  for (const key of ['AI_RESEARCH_EXECUTION_ENABLED', 'AI_RESEARCH_V2_WRITES_ENABLED', 'STRATEGY_AI_OPTIMIZATION_ENABLED'])
    assert.equal(environment[key], 'false');
  assert.equal(environment.DATABASE_URL, 'postgresql://research_reader@127.0.0.1:5432/restore_db');
  assert.equal(value.HostConfig.NetworkMode, `container:${postgres}`);
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  const keys = ['NODE_ENV', 'PORT', 'DATABASE_URL', 'REDIS_URL', 'DSA_BASE_URL', 'THESIS_LEDGER_DSA_TOKEN',
    'CREDENTIAL_ENCRYPTION_KEY', 'AI_RESEARCH_EXECUTION_ENABLED', 'AI_RESEARCH_V2_WRITES_ENABLED',
    'STRATEGY_AI_OPTIMIZATION_ENABLED', 'STRATEGY_RISK_APPLICATIONS_ENABLED'];
  return ['run', '-d', '--name', `research-dual-read-${token}-server`, '--label', `${labelKey}=${token}`,
    '--label', `${labelKey}.role=server`, '--network', `container:${postgres}`, '--read-only', '--tmpfs', '/tmp:rw',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    ...keys.flatMap(key => { assert.equal(typeof environment[key], 'string'); return ['-e', `${key}=${environment[key]}`]; }),
    '--entrypoint', 'node', image, 'apps/server/dist/src/main.js'];
}

export function cleanupObservationResources(receipt, run) {
  assert(/^[a-f0-9-]{36}$/.test(receipt.token));
  const failures = [];
  for (const role of ['server', 'redis', 'postgres']) {
    try {
      const name = `research-dual-read-${receipt.token}-${role}`;
      const found = run(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`]).toString().trim();
      if (!found) continue; // 只有成功查询后确认不存在，才可跳过。
      assert(/^[a-f0-9]{64}$/.test(found));
      assertOwned(JSON.parse(run(['inspect', found]))[0], receipt.token, role);
      run(['rm', '-f', found]);
    } catch { failures.push(role); }
  }
  assert.equal(failures.length, 0, `自有副本清理未完成：${failures.join(',')}`);
}
