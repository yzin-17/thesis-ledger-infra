import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutputDirectory, checksum, verifyBundle, docker, inspect, sql, protectionSql, target,
  digest } from './research-state-backup.mjs';
import { assertOwned, fixtureSql, labelKey, loadReceipt, openReadBridge, receiptFormat, verifyBaseline } from './research-dual-read-runtime.mjs';
import { auditDualReadInputs } from './research-dual-read-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = resolve(root, '../thesis-ledger');
export const counterSql = `SELECT json_build_object('runs',(SELECT count(*) FROM "AiRun"),
  'tools',(SELECT count(*) FROM "AiToolCall"),'observations',(SELECT count(*) FROM "ResearchObservation"),
  'invocations',(SELECT count(*) FROM "AiInvocation"),
  'invocationFacts',(SELECT count(*) FROM "AiInvocationFact"));`;
const pauseKeys = ['AI_RESEARCH_EXECUTION_ENABLED', 'AI_RESEARCH_V2_WRITES_ENABLED', 'STRATEGY_AI_OPTIMIZATION_ENABLED'];
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const selectedEnv = container => Object.fromEntries(container.Config.Env.map(value => {
  const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)];
}));

export function sourceState() {
  const containers = Object.fromEntries(['postgres', 'redis', 'thesis-ledger', 'backtest-worker', 'dsa']
    .map(role => [role, inspect(`${target}-${role}-1`)]));
  for (const value of Object.values(containers)) assert(value.State.Running && value.State.Health?.Status === 'healthy');
  const environment = selectedEnv(containers['thesis-ledger']);
  const state = { protection: sql(containers.postgres.Id, protectionSql),
    counters: sql(containers.postgres.Id, counterSql),
    identities: Object.fromEntries(Object.entries(containers).map(([role, value]) => [role, [value.Id, value.Image]])),
    pauseFlags: Object.fromEntries(pauseKeys.map(key => [key, environment[key] ?? null])) };
  assert.equal(state.protection.activeBacktests, 0);
  assert.notEqual(environment.AI_RESEARCH_V2_WRITES_ENABLED, 'true');
  return { state, containers, environment };
}

export function ownedSql(container, token, query) {
  assertOwned(inspect(container), token, 'postgres');
  return docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'restore_owner', '-d', 'restore_db', '-Atq'], { input: query });
}

export async function runDualRead({ bundle, baseline, output, retain = false }) {
  const { verifyDualReadSdk } = await import(pathToFileURL(resolve(main, 'scripts/research-dual-read-sdk.mjs')));
  checkOutputDirectory(output);
  assert(Boolean(bundle) !== Boolean(baseline), '必须明确选择正式备份或已封存双读基线');
  const manifest = baseline ? await verifyBaseline(baseline) : await verifyBundle(bundle), before = sourceState();
  const expected = baseline ? manifest.protection : manifest.state;
  const original = baseline ? manifest.originalProtection : manifest.state;
  assert.equal(manifest.images.server, before.containers['thesis-ledger'].Image, '必须使用同一目标 Server 镜像');
  assert.equal(manifest.images.postgres, before.containers.postgres.Image);
  assert.equal(expected.head, before.state.protection.head);
  assert.deepEqual(original.tables, before.state.protection.tables, '目标保护表已偏离备份，须重新备份');
  const token = randomUUID(), containers = {}, created = [];
  const images = { postgres: manifest.images.postgres, server: manifest.images.server, redis: before.containers.redis.Image };
  if (baseline) assert.equal(images.redis, manifest.images.redis);
  const pgUser = docker(['exec', before.containers.postgres.Id, 'id', '-u', 'postgres']).toString().trim();
  const pgGroup = docker(['exec', before.containers.postgres.Id, 'id', '-g', 'postgres']).toString().trim();
  assert(/^\d+$/.test(pgUser) && /^\d+$/.test(pgGroup));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const receipt = { format: receiptFormat, target, token, output: resolve(output), images, containers };
  const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  function create(role, args) {
    const name = `research-dual-read-${token}-${role}`;
    const result = docker(['run', '-d', '--name', name, '--label', `${labelKey}=${token}`,
      '--label', `${labelKey}.role=${role}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', ...args]);
    const container = result.toString().trim();
    created.push({ container, role }); containers[role] = container;
    assertOwned(inspect(container), token, role);
    return container;
  }
  let bridge, success = false;
  try {
    console.log('阶段：登记的备份/基线已校验，准备隔离 PostgreSQL');
    const pg = create('postgres', ['--network', 'none', '--user', `${pgUser}:${pgGroup}`,
      '--tmpfs', `/var/lib/postgresql/data:rw,size=1g,uid=${pgUser},gid=${pgGroup}`,
      '--tmpfs', `/var/run/postgresql:rw,uid=${pgUser},gid=${pgGroup}`, '-e', 'POSTGRES_USER=restore_owner',
      '-e', 'POSTGRES_DB=restore_db', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', images.postgres]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { sql(pg, 'SELECT 1;', 'restore_db'); ready = true; break; } catch { await sleep(500); }
    }
    assert(ready, '隔离 PostgreSQL 未就绪');
    assertOwned(inspect(pg), token, 'postgres');
    docker(['exec', '-i', pg, 'pg_restore', '--single-transaction', '--no-owner', '--no-acl',
      '-U', 'restore_owner', '-d', 'restore_db'], { input: readFileSync(resolve(baseline ?? bundle, 'postgres.dump')) });
    const restored = sql(pg, protectionSql, 'restore_db');
    assert.deepEqual(restored.tables, expected.tables);
    assert.deepEqual(restored.runs, expected.runs);
    assert.equal(restored.head, expected.head);
    assert.deepEqual(sql(pg, counterSql, 'restore_db'), baseline ? manifest.counters : before.state.counters);
    assert.equal(before.state.counters.runs, 0, '本版本验收入口要求尚无研究历史的已核对目标');

    const factory = readFileSync(resolve(main, 'scripts/research-dual-read-fixtures.mjs'), 'utf8');
    const sample = JSON.parse(readFileSync(resolve(main, 'packages/schemas/fixtures/research-v2.samples.json')));
    const program = factory + `\nimport {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const schemas=require('@thesis-ledger/schemas');
const integrity=require('/app/apps/server/dist/src/ai/ai-research-frozen-integrity-v2.js');
const identity=require('/app/apps/server/dist/src/ai/ai-research-submission-identity-v2.js');
const numeric=require('/app/apps/server/dist/src/ai/ai-research-numeric-evidence-v2.js');
console.log(JSON.stringify(buildDualReadFixtures(${JSON.stringify(sample)}, {...schemas,...integrity,...identity,...numeric})));`;
    const builder = create('fixture', ['--network', 'none', '--read-only', '--tmpfs', '/tmp:rw',
      '--entrypoint', 'sleep', images.server, 'infinity']);
    const inputs = auditDualReadInputs(builder, main);
    if (baseline) {
      assert.equal(inputs.schemaSha256, manifest.inputs.schemaSha256);
      assert.equal(inputs.sdkSha256, manifest.inputs.sdkSha256);
    }
    const fixtures = baseline ? JSON.parse(readFileSync(resolve(baseline, 'research-fixtures.json')))
      : JSON.parse(docker(['exec', '-i', builder, 'node', '--input-type=module'], { input: program }));
    save('fixtures.json', fixtures);
    if (!baseline) ownedSql(pg, token, fixtureSql(fixtures));
    ownedSql(pg, token, `CREATE ROLE research_reader LOGIN; GRANT CONNECT ON DATABASE restore_db TO research_reader;
      GRANT USAGE ON SCHEMA public TO research_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO research_reader;
      ALTER ROLE research_reader SET default_transaction_read_only=on;`);
    const permissions = JSON.parse(ownedSql(pg, token, `SELECT json_build_object('writableTables', (SELECT count(*) FROM pg_tables
      WHERE schemaname='public' AND (has_table_privilege('research_reader',format('%I.%I',schemaname,tablename),'INSERT')
      OR has_table_privilege('research_reader',format('%I.%I',schemaname,tablename),'UPDATE')
      OR has_table_privilege('research_reader',format('%I.%I',schemaname,tablename),'DELETE'))),
      'readOnly',(SELECT rolconfig @> ARRAY['default_transaction_read_only=on'] FROM pg_roles WHERE rolname='research_reader'));`));
    assert.deepEqual(permissions, { writableTables: 0, readOnly: true });
    const seeded = sql(pg, counterSql, 'restore_db');
    assert.equal(seeded.runs, baseline ? manifest.counters.runs : fixtures.runs.length);
    assert.equal(seeded.tools, baseline ? manifest.counters.tools : fixtures.calls.length);
    assert.equal(seeded.invocations, before.state.counters.invocations);
    const copyBefore = sql(pg, protectionSql, 'restore_db');
    create('redis', ['--network', `container:${pg}`, '--read-only', '--user', 'redis',
      '--tmpfs', '/data:rw,mode=1777', '--entrypoint', 'redis-server',
      images.redis, '--save', '', '--appendonly', 'no']);
    const env = { NODE_ENV: 'test', PORT: '3000',
      DATABASE_URL: 'postgresql://research_reader@127.0.0.1:5432/restore_db',
      REDIS_URL: 'redis://127.0.0.1:6379', DSA_BASE_URL: 'http://127.0.0.1:19876',
      THESIS_LEDGER_DSA_TOKEN: 'controlled-isolated-reader',
      CREDENTIAL_ENCRYPTION_KEY: before.environment.CREDENTIAL_ENCRYPTION_KEY,
      AI_RESEARCH_EXECUTION_ENABLED: 'false', AI_RESEARCH_V2_WRITES_ENABLED: 'false',
      STRATEGY_AI_OPTIMIZATION_ENABLED: 'false', STRATEGY_RISK_APPLICATIONS_ENABLED: 'false' };
    assert(env.CREDENTIAL_ENCRYPTION_KEY?.length >= 16, '目标加密配置缺失');
    const server = create('server', ['--network', `container:${pg}`, '--read-only', '--tmpfs', '/tmp:rw',
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '--entrypoint', 'node', images.server, 'apps/server/dist/src/main.js']);
    let started = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const status = docker(['exec', server, 'node', '-e',
          "fetch('http://127.0.0.1:3000/api/v1/research/capabilities').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]);
        void status; started = true; break;
      } catch { if (!inspect(server).State.Running) break; await sleep(500); }
    }
    assert(started, '实际 Server 未就绪；请仅提取脱敏失败日志');
    Object.assign(receipt, { before: before.state, copyBefore, seeded, inputs });
    save('runtime.json', receipt);
    loadReceipt(output);
    console.log('阶段：实际 Server 已启动，执行真实 HTTP 与 SDK 双读');
    bridge = await openReadBridge(server);
    const sdk = await verifyDualReadSdk(bridge.baseUrl, fixtures);
    let journal = null;
    if (baseline) {
      const { verifyConsumerReads } = await import(pathToFileURL(resolve(main, 'scripts/research-dual-read-consumers.mjs')));
      journal = await verifyConsumerReads(bridge.baseUrl,
        JSON.parse(readFileSync(resolve(baseline, 'journal-fixtures.json'))), []);
    }
    assert.deepEqual(sql(pg, counterSql, 'restore_db'), seeded, '读取改变副本任务/审计数量');
    assert.deepEqual(sql(pg, protectionSql, 'restore_db'), copyBefore, '读取改变副本保护状态');
    assert.deepEqual(sourceState().state, before.state, '验收改变目标状态');
    const report = { format: receiptFormat, createdAt: new Date().toISOString(), passed: true,
      images, schemaHead: restored.head, database: { restoredProtectedTables: Object.keys(restored.tables).length,
        existingSuccessfulRuns: restored.runs.length, ...permissions, seededRuns: seeded.runs, seededTools: seeded.tools },
      sdk, journal, inputs, inputSha256: baseline ? await checksum(resolve(baseline, 'manifest.json'))
        : digest(Buffer.from(factory + JSON.stringify(sample))), restoredBaseline: Boolean(baseline),
      targetPreserved: true, copyReadOnly: true, modelInvocationsAdded: 0,
      targetV2WritesEnabled: false, isolatedEnvironment: 'test', externalNetwork: false,
      boundary: '同一目标镜像及正式备份副本的保存产物读取；目标升级启动另见 G2a-B，未执行模型或数据获取。' };
    save('report.json', report); success = true;
    console.log(JSON.stringify(report));
    return report;
  } finally {
    if (bridge) await bridge.close();
    if (!retain || !success) {
      for (const { container, role } of [...created].reverse()) {
        assertOwned(inspect(container), token, role); docker(['rm', '-f', container]);
      }
    } else {
      const builder = created.find(value => value.role === 'fixture');
      assertOwned(inspect(builder.container), token, 'fixture'); docker(['rm', '-f', builder.container]);
      console.log(`隔离副本已保留：${output}`);
    }
    assert.deepEqual(sourceState().state, before.state, '退出核对发现目标状态变化');
  }
}

export function cleanupDualRead(output) {
  const receipt = loadReceipt(output);
  for (const role of ['server', 'redis', 'postgres']) {
    const id = receipt.containers[role]; assertOwned(inspect(id), receipt.token, role); docker(['rm', '-f', id]);
  }
  console.log('已清理该回执登记的隔离资源；备份与验收文件保留。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  const options = Object.fromEntries(args.filter(value => value !== '--retain').reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value, all[index + 1]]); return pairs;
  }, []));
  assert(['run', 'cleanup', 'serve'].includes(mode));
  assert.equal(options['--target'], target);
  assert(options['--output']);
  if (mode === 'run') await runDualRead({ bundle: options['--backup'], baseline: options['--baseline'],
    output: options['--output'], retain: args.includes('--retain') });
  if (mode === 'cleanup') cleanupDualRead(options['--output']);
  if (mode === 'serve') {
    const receipt = loadReceipt(options['--output']), port = Number(options['--port']);
    assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
    const bridge = await openReadBridge(receipt.containers.server, port);
    console.log(JSON.stringify({ baseUrl: bridge.baseUrl, readOnly: true }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close(); });
  }
}
