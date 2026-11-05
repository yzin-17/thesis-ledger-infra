import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DsaRuntimeRecovery, ownsUpdateLock } from './dsa-runtime-recovery.mjs';
import { assertRestoredRuntime, normalizeMounts } from './dsa-runtime-snapshot.mjs';
import { checkOutputDirectory, digest, inspect, protectionSql, sql, target, verifyBundle } from './research-state-backup.mjs';
import { assertDsaTarget } from './dsa-target-contract.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(infra, '../daily-stock-analysis');
const label = 'org.openai.thesis-ledger.dg2c';
const qaMounts = [['tests', '/app/tests'], ['scripts/data_test_scope.py', '/app/scripts/data_test_scope.py'],
  ['docs/tasks/evidence', '/app/docs/tasks/evidence']];

export function assertRecoveryProbe(value, name, image) {
  assert(/^dsa-dg2c-[a-f0-9-]{36}$/.test(name));
  assert.equal(value.Name, '/' + name);
  assert.equal(value.Config.Labels[label], name);
  assert.equal(value.Image, image);
  assert.equal(value.Config.User, '1000:1000');
  assert.equal(value.HostConfig.NetworkMode, 'none');
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert(!value.HostConfig.Privileged && !value.HostConfig.CapAdd?.length);
  assert.deepEqual(Object.keys(value.HostConfig.Tmpfs).sort(), ['/app/data', '/app/logs', '/app/reports', '/tmp']);
  assert(value.HostConfig.SecurityOpt.includes('no-new-privileges'));
  const binds = value.Mounts.filter(m => m.Type !== 'tmpfs');
  assert.equal(binds.length, qaMounts.length);
  for (const [path, destination] of qaMounts) {
    const matches = binds.filter(m => m.Destination === destination);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].Type, 'bind'); assert.equal(matches[0].RW, false);
    assert.equal(matches[0].Source, join(source, path));
  }
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...options });
  assert.equal(result.status, 0, `恢复验收 Docker 步骤失败：${args[0]}，退出 ${result.status}`);
  return result.stdout;
}

const initialize = `import io,sys,tarfile,pathlib
root=pathlib.Path('/app/data'); found=set()
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as outer:
 for item in outer:
  assert item.isfile() and item.name in ['dsa.sqlite','dsa-data.tar'] and item.name not in found
  found.add(item.name);raw=outer.extractfile(item).read()
  if item.name=='dsa.sqlite':(root/'stock_analysis.db').write_bytes(raw)
  else:
   with tarfile.open(fileobj=io.BytesIO(raw)) as inner:
    for entry in inner:
     p=pathlib.PurePosixPath(entry.name);assert not p.is_absolute() and '..' not in p.parts
     if entry.isdir():continue
     assert entry.isfile();target=root/str(p);target.parent.mkdir(parents=True,exist_ok=True)
     target.write_bytes(inner.extractfile(entry).read())
assert found=={'dsa.sqlite','dsa-data.tar'}
print('retained-copy-ready')`;

const runtimeRead = `import json,os,sqlite3,urllib.request,urllib.parse
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def read(path,control=False):
 token=os.environ.get('THESIS_LEDGER_CONTROL_TOKEN') if control else os.environ.get('THESIS_LEDGER_DSA_TOKEN')
 token=token or os.environ['THESIS_LEDGER_DSA_TOKEN']
 with opener.open(urllib.request.Request('http://127.0.0.1:8000'+path,headers={'Authorization':'Bearer '+token}),timeout=10) as r:
  assert r.status==200;return json.load(r)
assert read('/health')['status']=='ok'
assert read('/api/v3/thesis-ledger/control/providers',True)['contractVersion']==3
c=sqlite3.connect('file:'+os.environ['DATABASE_PATH']+'?mode=ro',uri=True)
rows=c.execute('SELECT from_currency,to_currency,rate_date,rate FROM portfolio_fx_rates').fetchall();assert rows
for a,b,day,rate in rows:
 value=read('/api/v3/thesis-ledger/market/fx-rates?'+urllib.parse.urlencode({'baseCurrency':b,'currencies':a,'asOf':day}))
 row=next(v for v in value['rates'] if v['fromCurrency']==a and v['toCurrency']==b)
 assert row['available'] and float(row['rate'])==float(rate) and row['rateDate']==day
print(json.dumps({'health':200,'controlContractVersion':3,'cachedFxRowsRead':len(rows),'source':'retained-cache-at-original-rate-date'}))`;

function runProbe(image, backup, output, report) {
  const name = 'dsa-dg2c-' + randomUUID(); let id;
  const tmpfs = ['/tmp', '/app/data', '/app/logs', '/app/reports'].flatMap(path => [
    '--tmpfs', `${path}:uid=1000,gid=1000,mode=0700${path === '/tmp' ? ',exec' : ''}`]);
  const mounts = qaMounts.flatMap(([path, destination]) => [
    '--mount', `type=bind,src=${join(source, path)},dst=${destination},readonly`]);
  try {
    report.probeStep = 'create-isolated-container';
    id = docker(['run', '-d', '--rm', '--pull', 'never', '--name', name, '--label', `${label}=${name}`,
      '--network', 'none', '--read-only', '--user', '1000:1000', '--security-opt', 'no-new-privileges',
      '--no-healthcheck', ...tmpfs, ...mounts,
      '--entrypoint', '/bin/sh', image, '-c', 'exec sleep infinity']).toString().trim();
    assertRecoveryProbe(inspect(id), name, image);
    const archive = spawnSync('tar', ['-C', backup, '-cf', '-', 'dsa.sqlite', 'dsa-data.tar'], {
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    assert.equal(archive.status, 0);
    report.probeStep = 'restore-owned-data-copy';
    docker(['exec', '-i', id, 'python', '-c', initialize], { input: archive.stdout });
    const bundle = spawnSync(join(source, '.venv/bin/python'), [join(source, 'tests/dg2a_image_probe.py'), 'tools'],
      { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(bundle.status, 0);
    report.toolBundleSha256 = digest(bundle.stdout);
    report.probeStep = 'bootstrap-pure-test-tools';
    const tools = JSON.parse(docker(['exec', '-i', id, 'python', '-m', 'tests.dg2a_image_probe', 'bootstrap'], { input: bundle.stdout }));
    report.tools = tools;
    const program = `import os,json,multiprocessing,threading,xml.etree.ElementTree as ET
from pathlib import Path
from tests.dg2a_image_probe import controlled_environment
with controlled_environment(Path(${JSON.stringify(tools.directory)})):
 os.environ['DSA_RECOVERY_BASELINE']='/app/data'
 import pytest
 code=pytest.main(['-q','-o','cache_dir=/tmp/pytest-cache','-o','junit_family=xunit1','--junitxml=/tmp/dg2c.xml','tests/test_data_process_recovery.py','tests/test_data_announcement_lifecycle.py','tests/test_data_catalog_lifecycle.py','tests/test_provider_oauth_manager.py','tests/test_provider_oauth_api.py','tests/test_data_lifespan.py'])
 root=ET.parse('/tmp/dg2c.xml').getroot() if Path('/tmp/dg2c.xml').exists() else ET.Element('missing');cases=list(root.iter('testcase'))
 result={'tests':len(cases),'failures':len(list(root.iter('failure'))),'errors':len(list(root.iter('error'))),'skips':len(list(root.iter('skipped'))),'activeChildren':len(multiprocessing.active_children()),'extraThreads':[t.name for t in threading.enumerate() if t is not threading.main_thread()]}
 result['properties']={c.get('name'):{p.get('name'):p.get('value') for p in c.findall('./properties/property')} for c in cases if c.find('properties') is not None}
 print('DG2C_MATRIX '+json.dumps(result),flush=True)
 assert code==0 and result['tests']>0 and not any(result[k] for k in ['failures','errors','skips','activeChildren','extraThreads'])
`;
    report.probeStep = 'process-fault-and-lifecycle-matrix';
    const result = spawnSync('docker', ['exec', id, tools.python, '-c', program], { encoding: 'utf8', timeout: 120000,
      maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(output, 'probe.log'), result.stdout + result.stderr, { mode: 0o600 });
    const line = result.stdout.split('\n').find(l => l.startsWith('DG2C_MATRIX '));
    report.probe = line ? JSON.parse(line.slice('DG2C_MATRIX '.length)) : { failure: '未返回矩阵统计' };
    if (report.probe.tests > 0) {
      const xml = docker(['exec', id, 'cat', '/tmp/dg2c.xml']);
      writeFileSync(join(output, 'probe.xml'), xml, { mode: 0o600 }); report.probe.junitSha256 = digest(xml);
    }
    assert.equal(result.status, 0, '隔离保留副本的故障/生命周期断言失败');
  } finally {
    if (id) { assertRecoveryProbe(inspect(id), name, image); docker(['rm', '--force', id]); }
    report.probeCleaned = true;
  }
}

export async function recoverTarget(lock, backup, originalPath, candidatePath, retentionPath, output) {
  assert(ownsUpdateLock(lock), '恢复验收必须持有正式维护锁');
  for (const path of [backup, originalPath, candidatePath, retentionPath, output]) assert.equal(resolve(path), path);
  checkOutputDirectory(output);
  const original = await verifyBundle(backup);
  const candidate = JSON.parse(readFileSync(candidatePath)), retention = JSON.parse(readFileSync(retentionPath));
  assert(candidate.completedAt && candidate.cleaned && !candidate.failure && !candidate.cleanupFailure);
  assert.equal(retention.passed, true); assert.equal(retention.candidateImage, candidate.candidate.image);
  assert.deepEqual(retention.baselineFiles, original.files);
  const baselineBytes = readFileSync(join(dirname(retentionPath), 'baseline.json'));
  const rebuilt = spawnSync(join(source, '.venv/bin/python'), [join(infra, 'scripts/dsa-state-retention.py'),
    'baseline', join(backup, 'dsa.sqlite'), join(backup, 'dsa-data.tar')], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(rebuilt.status, 0);
  assert.deepEqual(JSON.parse(baselineBytes), JSON.parse(rebuilt.stdout), '私有逐对象基线与正式备份不符');
  const before = inspect(`${target}-dsa-1`); assertDsaTarget(before);
  assert.equal(before.Image, candidate.candidate.image);
  assert.deepEqual(sql(`${target}-postgres-1`, protectionSql), original.state);
  const originalSnapshot = JSON.parse(readFileSync(originalPath));
  assert.equal(originalSnapshot.imageId, original.images.dsa);
  assert.deepEqual(normalizeMounts(before.Mounts), normalizeMounts(originalSnapshot.mounts));
  const runtime = new DsaRuntimeRecovery(infra, join(infra, '.env'));
  runtime.prepareRestore(originalPath);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const report = { version: 'dsa-dg2c-recovery-v1', startedAt: new Date().toISOString(),
    candidateImage: before.Image, baselineImage: original.images.dsa, stages: [], realModelsPaused: true,
    baselineInventorySha256: digest(baselineBytes),
    scripts: { entry: digest(readFileSync(fileURLToPath(import.meta.url))),
      shellEntry: digest(readFileSync(join(infra, 'scripts/dsa-target-recovery.sh'))),
      runtimeRecovery: digest(readFileSync(join(infra, 'scripts/dsa-runtime-recovery.mjs'))),
      runtimeSnapshot: digest(readFileSync(join(infra, 'scripts/dsa-runtime-snapshot.mjs'))),
      retention: digest(readFileSync(join(infra, 'scripts/dsa-state-retention.py'))),
      processTests: digest(readFileSync(join(source, 'tests/test_data_process_recovery.py'))) } };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let restoreCandidate; let switched = false; let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  function retainedStage(stage, image) {
    const actual = inspect(`${target}-dsa-1`); assert.equal(actual.Image, image);
    if (stage === 'baseline-restored') {
      assert.equal(actual.State.Running, true); assert.equal(actual.State.Health?.Status, 'healthy');
      assertRestoredRuntime(runtime.inspect(actual.Id), originalSnapshot);
    } else assertDsaTarget(actual);
    const observed = JSON.parse(docker(['exec', '-i', actual.Id, 'python', '-c',
      readFileSync(join(infra, 'scripts/dsa-state-retention.py'), 'utf8'), 'verify'], { input: baselineBytes }));
    assert.equal(observed.passed, true);
    const reads = JSON.parse(docker(['exec', actual.Id, 'python', '-c', runtimeRead]));
    assert.deepEqual(sql(`${target}-postgres-1`, protectionSql), original.state);
    report.stages.push({ stage, at: new Date().toISOString(), image, reads, retained: observed }); save();
  }
  save();
  try {
    retainedStage('before', before.Image);
    runProbe(before.Image, backup, output, report); save();
    assert(!interrupted, '验收被中断，尚未切换目标');
    restoreCandidate = runtime.snapshot(); assert.equal(restoreCandidate.imageId, before.Image);
    report.candidateSnapshot = restoreCandidate.path; save();
    switched = true;
    await runtime.restore(originalPath, 120);
    retainedStage('baseline-restored', original.images.dsa);
    assert(!interrupted, '验收被中断，恢复候选');
  } catch (error) {
    report.failure = { name: error.name, message: error.message }; save();
  } finally {
    if (switched) {
      try {
        await runtime.restore(restoreCandidate.path, 120);
        retainedStage('candidate-restored', before.Image); report.candidateRestored = true;
      } catch (error) { report.restoreFailure = error.message; }
    }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    report.completedAt = new Date().toISOString();
    report.passed = !report.failure && !report.restoreFailure && report.candidateRestored === true;
    save();
  }
  assert.equal(report.passed, true, 'DG2c 未通过，详见私有报告；已执行有条件的候选恢复');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await recoverTarget(...process.argv.slice(2));
  console.log(JSON.stringify({ passed: report.passed, image: report.candidateImage,
    stages: report.stages.map(s => s.stage), probe: report.probe, cleaned: report.probeCleaned }));
}
