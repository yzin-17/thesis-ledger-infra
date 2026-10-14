import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTargetRuntime, docker } from './backtest-target-runtime.mjs';
import { assertDevelopmentRebuildAuthorization } from '../../thesis-ledger/apps/server/dist/src/platform/database-structure.js';
import { parseConfig } from '../../thesis-ledger/apps/server/dist/src/platform/config.js';

export function assertPrivateCompose(config, project) {
  assert.match(project, /^thesis-ledger-t4-production-[0-9a-f]{8}$/);
  for (const [key, volume] of Object.entries(config.volumes)) {
    assert.equal(volume.name, `${project}-${key}`);
    assert(!volume.external, '不得连接共享外部卷');
  }
  assert.equal(config.services['thesis-ledger'].ports.length, 1);
  const port = config.services['thesis-ledger'].ports[0];
  assert.equal(port.host_ip, '127.0.0.1');
  assert.equal(port.target, 3000);
  assert(!port.published, '必须使用专属临时端口');
  assert.equal(config.services['backtest-worker'].ports, undefined);
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--confirm', 'isolated-production-smoke']);
  const runtime = createTargetRuntime(`t4-${randomUUID()}`);
  const project = `thesis-ledger-t4-production-${randomUUID().slice(0,8)}`;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), `${project}-`));
  const override = join(directory, 'override.yml');
  const volumes = ['thesis-ledger-postgres-data', 'thesis-ledger-redis-data', 'thesis-ledger-dsa-data', 'thesis-ledger-backtest-data'];
  writeFileSync(override, `services:\n  thesis-ledger:\n    ports: !override ["127.0.0.1::3000"]\nvolumes:\n${volumes.map(key => `  ${key}:\n    name: ${project}-${key}\n    external: false`).join('\n')}\n`);
  const env = {
    ...process.env, THESIS_LEDGER_IMAGE: runtime.baseline.get('thesis-ledger').Image,
    DSA_IMAGE: runtime.baseline.get('dsa').Image,
    POSTGRES_DB: 't4_lifecycle', POSTGRES_OWNER_USER: 't4_owner', POSTGRES_OWNER_PASSWORD: randomBytes(24).toString('hex'),
    POSTGRES_APP_USER: 't4_app', POSTGRES_APP_PASSWORD: randomBytes(24).toString('hex'),
    THESIS_LEDGER_DSA_TOKEN: randomBytes(24).toString('hex'), THESIS_LEDGER_CONTROL_TOKEN: randomBytes(24).toString('hex'),
    THESIS_LEDGER_DSA_SECRET_KEY: randomBytes(32).toString('base64'), CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  for (const key of ['AI_PROVIDER_CONFIGS_JSON','AI_RESEARCH_POLICY_JSON','AI_PROVIDER_ID','AI_API_KEY','AI_BASE_URL','AI_MODEL']) delete env[key];
  const compose = (...args) => execFileSync('docker', ['compose','--env-file','.env.example','-p',project,'-f','compose.yml','-f',override,...args], { cwd, env, encoding:'utf8', timeout:180_000, maxBuffer:2*1024*1024, stdio:['pipe','pipe','pipe'] }).trim();
  let validated = false;
  const protectedData = runtime.protect();
  try {
    const config = JSON.parse(compose('config','--format','json'));
    assertPrivateCompose(config, project);
    parseConfig(Object.fromEntries(Object.entries(config.services['thesis-ledger'].environment).filter(([,value])=>value!==null)));
    assert.equal(docker('ps','-aq','--filter',`label=com.docker.compose.project=${project}`),'');
    assert.equal(config.services['thesis-ledger'].image, config.services['backtest-worker'].image);
    validated = true;
    compose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','90','postgres','redis','dsa');
    const structure = JSON.parse(docker('exec', runtime.baseline.get('thesis-ledger').Id, 'node', '--input-type=module', '-e', `
      import { discoverDatabaseStructure, buildDatabaseRebuildSql } from '/app/apps/server/dist/src/platform/database-structure.js';
      const input = await discoverDatabaseStructure();
      const sql = buildDatabaseRebuildSql(input, process.argv[1], {databaseName:'t4_lifecycle',ownerName:'t4_owner'});
      console.log(JSON.stringify({head:input.currentHead,tables:input.expectedTables.length,sql}));
    `, readFileSync(join(cwd,'scripts/bootstrap-app-role.sql'),'utf8')));
    process.env.NODE_ENV = 'development';
    assertDevelopmentRebuildAuthorization({ mode:'rebuild', allowDataLoss:'true', confirm:`${project}/t4_lifecycle`, expectedTarget:`${project}/t4_lifecycle` });
    execFileSync('docker',['exec','-i',`${project}-postgres-1`,'psql','-U','t4_owner','-d','t4_lifecycle','-v','ON_ERROR_STOP=1'], { input:structure.sql, encoding:'utf8', timeout:90_000, maxBuffer:2*1024*1024 });
    compose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','90','thesis-ledger','backtest-worker');
    const rows = JSON.parse(docker('inspect',...['postgres','redis','dsa','thesis-ledger','backtest-worker'].map(s=>`${project}-${s}-1`)));
    for (const row of rows) assert.equal(row.State.Health.Status,'healthy');
    const endpoint=compose('port','thesis-ledger','3000');
    const response=await fetch(`http://${endpoint}/api/v1/health`,{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200,'生产 Compose 映射的 API 必须可访问');
    const identity = JSON.parse(docker('exec',`${project}-postgres-1`,'psql','-U','t4_owner','-d','t4_lifecycle','-Atq','-c',`SELECT json_build_object('head',(SELECT version FROM "SchemaVersion" WHERE id=1),'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),'appRole',exists(SELECT 1 FROM pg_roles WHERE rolname='t4_app'))`));
    assert.equal(identity.head,structure.head); assert.equal(identity.tables,structure.tables); assert(identity.appRole);
    runtime.record('production-compose', { project, ...identity, healthyServices:rows.length, apiStatus:response.status, image:config.services['thesis-ledger'].image, dedicatedVolumes:volumes.length, published:false });
    assert.deepEqual(runtime.protect(), protectedData);
  } catch (error) {
    if (validated) {
      for (const service of ['thesis-ledger','backtest-worker']) {
        try {
          const logs=docker('logs','--tail','16',`${project}-${service}-1`);
          console.error(logs.replace(/postgresql:\/\/\S+/gu,'[数据库连接已隐藏]'));
        } catch { /* 服务可能尚未创建。 */ }
      }
    }
    throw error;
  } finally {
    try { if(validated) compose('down','--volumes'); }
    finally { rmSync(directory,{recursive:true,force:true}); await runtime.cleanup(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
