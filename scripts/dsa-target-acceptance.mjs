import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compatibilityInventory, readDataContract } from './dsa-code-payload.mjs';
import { ownsUpdateLock } from './dsa-runtime-recovery.mjs';
import { normalizeMounts, validateSnapshot } from './dsa-runtime-snapshot.mjs';
import { verifyBundle, protectionSql, sql } from './research-state-backup.mjs';
import { assertDsaTarget, assertForwardRequest, assertOwnedProbe, project } from './dsa-target-contract.mjs';
import { consumeDsaCases, consumeEventExchange } from '../../thesis-ledger/scripts/dsa-target-consumer.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(infra, '../daily-stock-analysis');
const [lock, backup, reportPath] = process.argv.slice(2);
assert(lock && ownsUpdateLock(lock), '只能由持有正式更新锁的验收入口调用');
assert(backup && reportPath && resolve(backup) === backup && resolve(reportPath) === reportPath);
assert(!existsSync(reportPath), '不得覆盖已有验收报告');
const name = 'dsa-dg2a-' + randomUUID();
const report = { version: 'dsa-dg2a-target-v1', startedAt: new Date().toISOString(), name, sdkConsumers: [], trace: [] };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
let probeId, target, bridge, producer;

function command(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  assert.equal(result.status, 0, `Docker 验收步骤失败：${args[0]}，退出 ${result.status}`);
  return result.stdout;
}
const inspect = (id) => JSON.parse(command(['inspect', id]))[0];
function inventory(root, paths) {
  const result = {};
  function visit(path) {
    if (path.split('/').includes('__pycache__') || /\.(pyc|pyo)$/.test(path)) return;
    const full = join(root, path);
    if (statSync(full).isDirectory()) for (const entry of readdirSync(full).sort()) visit(path + '/' + entry);
    else result[path] = hash(readFileSync(full));
  }
  for (const path of paths) visit(path);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
const identityProgram = `import json,pathlib,hashlib,importlib.util,importlib.metadata as m,sys,marshal
from longbridge.openapi import OAuthBuilder
root=pathlib.Path('/app'); files={}
for name in ['server.py','api','data_provider','src','scripts/admit_nav_research.py','scripts/data-runtime-contract.json']:
 p=root/name
 for f in sorted(p.rglob('*') if p.is_dir() else [p]):
  if f.is_file() and '__pycache__' not in f.parts and f.suffix not in ['.pyc','.pyo']:
   files[str(f.relative_to(root))]=hashlib.sha256(f.read_bytes()).hexdigest()
def visible(name):
 try:return importlib.util.find_spec(name) is not None
 except (ModuleNotFoundError,ValueError):return False
bad_cache=[];cache_count=0
for directory in ['src','api','data_provider']:
 for f in (root/directory).rglob('*.pyc'):
  cache_count+=1;source=f.parent.parent/(f.name.split('.')[0]+'.py')
  if f.parent.name!='__pycache__' or sys.implementation.cache_tag not in f.name.split('.') or not source.is_file():
   bad_cache.append(str(f.relative_to(root)));continue
  if marshal.loads(f.read_bytes()[16:]).co_filename!=str(source):bad_cache.append(str(f.relative_to(root)))
print(json.dumps({'files':files,'inputs':json.loads((root/'scripts/data-runtime-inputs.json').read_text()),
 'contract':json.loads((root/'scripts/data-runtime-contract.json').read_text()),
 'longbridge':m.version('longbridge'),'storageVersion':OAuthBuilder.THESIS_LEDGER_STORAGE_VERSION,
 'models':{n:visible(n) for n in ['openai','anthropic','litellm','google.genai','google.generativeai','langchain','llama_index']},
 'bytecodeFiles':cache_count,'invalidBytecode':bad_cache,
 'removedPaths':[n for n in ['main.py','webui.py','bot','strategies','apps','src/agent','src/analyzer.py','src/notification.py']
  if (root/n).is_file() or ((root/n).is_dir() and any(f.is_file() for f in (root/n).rglob('*')))],
 'emptyRetiredDirectories':[n for n in ['bot','strategies','apps','src/agent'] if (root/n).is_dir() and not any((root/n).rglob('*'))]}))`;
const runtimeProgram = `import os,json,urllib.request,urllib.error
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def read(path,authorized=False):
 headers={}
 if authorized:headers['Authorization']='Bearer '+(os.environ.get('THESIS_LEDGER_CONTROL_TOKEN') or os.environ['THESIS_LEDGER_DSA_TOKEN'])
 try:r=opener.open(urllib.request.Request('http://127.0.0.1:8000'+path,headers=headers),timeout=10)
 except urllib.error.HTTPError as e:r=e
 data=r.read();return r.status,json.loads(data) if data else None
health,h=read('/health');cap,c=read('/api/v3/thesis-ledger/capabilities');schema,s=read('/openapi.json')
control,v=read('/api/v3/thesis-ledger/control/providers',True)
denied,_=read('/api/v3/thesis-ledger/control/providers');retired,_=read('/api/v1/analysis')
assert health==cap==schema==control==200
assert c['dataContractVersions']==[3] and v['contractVersion']==3 and denied==401 and retired==404
assert '/api/v3/thesis-ledger/market/news' in s['paths'] and '/api/v3/thesis-ledger/backtest/nav-inputs' in s['paths']
print(json.dumps({'healthStatus':health,'dataContractVersions':c['dataContractVersions'],'controlContractVersion':v['contractVersion'],
 'providerRegistryCount':len(v['providers']),'openApiPaths':len(s['paths']),'unauthorizedStatus':denied,'retiredAnalysisStatus':retired}))`;
const forwardProgram = `import sys,json,urllib.request,urllib.error
p=json.load(sys.stdin);u='http://127.0.0.1:'+str(p['port'])+p['path']
r=urllib.request.Request(u,data=p['body'].encode() if p['body'] else None,method=p['method'],headers={'Content-Type':'application/json','Authorization':'Bearer data-runtime-controlled-token'})
try:r=urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=15)
except urllib.error.HTTPError as e:r=e
print(json.dumps({'status':r.status,'body':r.read().decode()}))`;
function forward(port, path, method = 'GET', body = '') {
  return JSON.parse(command(['exec', '-i', probeId, 'python', '-c', forwardProgram],
    { input: JSON.stringify({ port, path, method, body }) }));
}
async function matrix(tools) {
  const args = ['exec', probeId, tools.python, '-m', 'tests.dg2a_image_probe', 'matrix', '--tools', tools.directory];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 900000);
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); })
    .finally(() => clearTimeout(timer));
  writeFileSync(reportPath + '.matrix.log', output, { mode: 0o600 });
  const line = output.split('\n').find((line) => line.startsWith('DG2A_MATRIX '));
  assert(line, '候选镜像矩阵未返回终态，详见私有日志');
  report.matrix = JSON.parse(line.slice('DG2A_MATRIX '.length)); save();
  const xml = command(['exec', probeId, 'cat', report.matrix.junit]);
  writeFileSync(reportPath + '.matrix.xml', xml, { mode: 0o600 });
  report.matrix.junitSha256 = hash(xml);
  assert.equal(status, 0, '候选镜像矩阵失败，详见私有日志');
  assert.equal(report.matrix.nativeStoragePassed, true, '定制 SDK 存储路径未实际通过');
}
async function startProducer(tools, scenario) {
  const child = spawn('docker', ['exec', '-i', probeId, tools.python, '-m', 'tests.dg2a_image_probe',
    'serve', '--tools', tools.directory, '--scenario', scenario], { stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal });
  const state = { child, code: undefined, output: '', stopped: null, ready: null };
  state.exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => { state.code = code; done(code); }); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    state.output = (state.output + line + '\n').slice(-8000);
    if (!line.startsWith('DSA_RUNTIME:')) return;
    const value = JSON.parse(line.slice('DSA_RUNTIME:'.length));
    if (value.kind === 'bound') state.ready = value;
    if (value.kind === 'stopped') state.stopped = value;
  });
  child.stderr.on('data', (data) => { state.output = (state.output + data).slice(-8000); });
  state.lines = lines; producer = state;
  for (let tick = 0; !state.ready; tick++) {
    assert(state.code === undefined && tick < 600, `候选 HTTP 启动失败：${state.output.slice(-1600)}`);
    await delay(50);
  }
  assert(Object.values(state.ready.models).every((value) => value === false));
  for (let tick = 0; ; tick++) {
    try { if (forward(state.ready.port, '/health').status === 200) break; } catch { /* 等待实际生命周期启动。 */ }
    assert(tick < 100 && state.code === undefined); await delay(50);
  }
  return state.ready;
}
async function stopProducer() {
  if (!producer) return;
  const state = producer;
  if (state.code === undefined) state.child.stdin.end('stop\n');
  const code = await Promise.race([state.exited, delay(15000).then(() => 'timeout')]);
  assert.equal(code, 0, `候选 HTTP 关闭失败：${state.output.slice(-1600)}`);
  assert.deepEqual(state.stopped, { kind: 'stopped', forbiddenImports: [], children: 0, lifecycleActive: false, oauthActive: false });
  state.lines.close(); producer = null;
}
async function consumeScenario(tools, scenario) {
  const ready = await startProducer(tools, scenario);
  bridge = createServer(async (request, response) => {
    try {
      const path = assertForwardRequest(request.url, request.method);
      const parts = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert(length <= 1000000); parts.push(chunk); }
      const result = forward(ready.port, path, request.method, Buffer.concat(parts).toString());
      report.trace.push({ scenario, path, method: request.method, status: result.status, bodySha256: hash(result.body) });
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(result.body);
    } catch { response.writeHead(400); response.end('{"message":"独立数据传输被拒绝"}'); }
  });
  await new Promise((done) => bridge.listen(0, '127.0.0.1', done));
  const results = await consumeDsaCases(`http://127.0.0.1:${bridge.address().port}`, ready.cases);
  for (const item of ready.cases) {
    assert(report.trace.some((row) => row.scenario === scenario && row.path.split('?')[0] === item.path && row.status === item.status),
      `缺少实际 HTTP 结果：${scenario}/${item.client}/${item.status}`);
  }
  await new Promise((done) => bridge.close(done)); bridge = null;
  await stopProducer(); report.sdkConsumers.push({ scenario, results, cleanShutdown: true }); save();
}

try {
  const original = await verifyBundle(backup);
  report.backup = { path: backup, createdAt: original.createdAt, files: original.files, images: original.images };
  target = inspect(`${project}-dsa-1`); assertDsaTarget(target);
  assert.deepEqual(target.Config.Cmd, readDataContract(source).entrypoint, '目标启动命令不符合数据入口合同');
  assert.deepEqual(target.Config.Entrypoint, ['/usr/local/bin/docker-entrypoint.sh']);
  report.target = { id: target.Id, image: target.Image, startedAt: target.State.StartedAt,
    command: target.Config.Cmd, mounts: normalizeMounts(target.Mounts) };
  const checkpoints = join(infra, '.maintenance-backups/dsa-runtime');
  const snapshots = readdirSync(checkpoints).filter((file) => /^\d+-.*\.json$/.test(file)).sort().reverse();
  const checkpoint = snapshots.map((file) => ({ file, value: JSON.parse(readFileSync(join(checkpoints, file))) }))
    .find(({ value }) => value.imageId === original.images.dsa);
  assert(checkpoint, '更新前正式运行态快照缺失'); validateSnapshot(checkpoint.value);
  assert.deepEqual(normalizeMounts(target.Mounts), normalizeMounts(checkpoint.value.mounts));
  command(['image', 'inspect', original.images.dsa]);
  report.rollback = { checkpoint: join(checkpoints, checkpoint.file), oldImageAvailable: true };
  const observed = JSON.parse(command(['exec', target.Id, 'python', '-c', identityProgram]));
  const expected = inventory(source, [...readDataContract(source).files, ...readDataContract(source).directories, 'scripts/data-runtime-contract.json']);
  assert.deepEqual(observed.files, expected, '目标代码与当前封存源码不一致');
  assert.deepEqual(observed.inputs, compatibilityInventory(source), '目标依赖/原生 SDK/结构指纹不一致');
  assert.deepEqual(observed.contract, readDataContract(source));
  assert(Object.values(observed.models).every((value) => value === false));
  assert.equal(observed.storageVersion, 1); assert.deepEqual(observed.removedPaths, []);
  assert.deepEqual(observed.invalidBytecode, [], '目标仍含宿主、无源或编译路径不匹配的字节码');
  report.runtime = JSON.parse(command(['exec', target.Id, 'python', '-c', runtimeProgram]));
  report.candidate = { files: Object.keys(expected).length, sha256: hash(JSON.stringify(expected)),
    image: target.Image, longbridge: observed.longbridge, storageVersion: observed.storageVersion,
    models: observed.models, bytecodeFiles: observed.bytecodeFiles, invalidBytecode: observed.invalidBytecode,
    emptyRetiredDirectories: observed.emptyRetiredDirectories, compatibility: observed.inputs };
  const server = inspect(`${project}-thesis-ledger-1`);
  assert.equal(server.Image, original.images.server, '本叶不得隐式切换主仓消费者镜像');
  const expectedSdk = Object.fromEntries(Object.entries(inventory(resolve(infra, '../thesis-ledger/apps/server/dist/src'), ['integration/dsa']))
    .filter(([path]) => /\.(js|json)$/.test(path)));
  const sdkProgram = `const fs=require('node:fs'),path=require('node:path'),c=require('node:crypto');const out={};
const root='/app/apps/server/dist/src';function visit(p){for(const n of fs.readdirSync(path.join(root,p)).sort()){
 const f=path.join(p,n);if(fs.statSync(path.join(root,f)).isDirectory())visit(f);else if(/\\.(js|json)$/.test(f))out[f]=c.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');}}
visit('integration/dsa');console.log(JSON.stringify(out));`;
  const sdkFiles = JSON.parse(command(['exec', server.Id, 'node', '-e', sdkProgram]));
  assert.deepEqual(sdkFiles, expectedSdk, '宿主实际消费的 SDK 与目标 Server 编译产物不一致');
  report.consumerRuntime = { image: server.Image, files: Object.keys(expectedSdk).length, sha256: hash(JSON.stringify(expectedSdk)) };
  const helper = join(source, 'tests/dg2a_image_probe.py');
  report.verificationInputs = { helper: hash(readFileSync(helper)), consumer: hash(readFileSync(resolve(infra, '../thesis-ledger/scripts/dsa-target-consumer.mjs'))) };
  const qaPaths = ['tests', 'scripts/data_test_scope.py', 'scripts/export_thesis_ledger_capability_inventory.py',
    'scripts/check_thesis_ledger_capability_boundaries.py', 'contracts/thesis-ledger/news-search-v1.samples.json', '.env.example'];
  report.verificationInputs.qaSourcesSha256 = hash(JSON.stringify(inventory(source, qaPaths)));
  const mainFixtures = resolve(infra, '../thesis-ledger/packages/schemas');
  const fixturePaths = ['fixtures', 'test/fixtures'];
  report.verificationInputs.mainFixturesSha256 = hash(JSON.stringify(inventory(mainFixtures, fixturePaths)));
  const qaMounts = [['tests', '/app/tests'], ['.env.example', '/app/.env.example'],
    ['scripts/data_test_scope.py', '/app/scripts/data_test_scope.py'],
    ['scripts/export_thesis_ledger_capability_inventory.py', '/app/scripts/export_thesis_ledger_capability_inventory.py'],
    ['scripts/check_thesis_ledger_capability_boundaries.py', '/app/scripts/check_thesis_ledger_capability_boundaries.py'],
    ['contracts/thesis-ledger/news-search-v1.samples.json', '/app/contracts/thesis-ledger/news-search-v1.samples.json'],
    ['docs/evidence', '/app/docs/evidence']];
  const mounts = qaMounts.flatMap(([path, destination]) => ['--mount', `type=bind,src=${join(source, path)},dst=${destination},readonly`]);
  for (const path of fixturePaths)
    mounts.push('--mount', `type=bind,src=${join(mainFixtures, path)},dst=/thesis-ledger/packages/schemas/${path},readonly`);
  const tmpfs = ['/tmp', '/app/data', '/app/logs', '/app/reports']
    .flatMap((path) => ['--tmpfs', `${path}:uid=1000,gid=1000,mode=0700${path === '/tmp' ? ',exec' : ''}`]);
  save();
  probeId = command(['run', '-d', '--rm', '--pull', 'never', '--name', name, '--label', `org.openai.thesis-ledger.dg2a=${name}`,
    '--network', 'none', '--read-only', '--user', '1000:1000', '--security-opt', 'no-new-privileges', '--no-healthcheck',
    ...tmpfs, ...mounts, '--entrypoint', '/bin/sh', target.Image, '-c', 'exec sleep infinity']).trim();
  assertOwnedProbe(inspect(probeId), name, target.Image);
  const bundle = spawnSync(join(source, '.venv/bin/python'), [helper, 'tools'], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(bundle.status, 0, '测试工具打包失败');
  report.verificationInputs.toolBundleSha256 = hash(bundle.stdout);
  const tools = JSON.parse(command(['exec', '-i', probeId, 'python', '-m', 'tests.dg2a_image_probe', 'bootstrap'], { input: bundle.stdout }));
  report.tools = tools; save();
  await matrix(tools);
  const exchangeOutput = command(['exec', probeId, tools.python, '-m', 'tests.dg2a_image_probe', 'exchange', '--tools', tools.directory]);
  const exchangeLine = exchangeOutput.split('\n').find((line) => line.startsWith('DG2A_EXCHANGE '));
  assert(exchangeLine, '候选镜像未生成跨运行时 Schema 交换');
  const exchange = JSON.parse(exchangeLine.slice('DG2A_EXCHANGE '.length));
  assert.equal(dirname(exchange.path), tools.directory);
  const wire = command(['exec', probeId, 'cat', exchange.path]); assert.equal(hash(wire), exchange.sha256);
  report.nodeSchema = { ...consumeEventExchange(JSON.parse(wire)), wireSha256: exchange.sha256,
    source: 'candidate-image-actual-http', selector: report.matrix.separateNodeSchemaCase };
  save();
  for (const scenario of ['basics', 'bars', 'events', 'nav', 'rules', 'reference']) await consumeScenario(tools, scenario);
  assert.equal(hash(JSON.stringify(inventory(source, qaPaths))), report.verificationInputs.qaSourcesSha256, '验收过程中测试输入变化');
  assert.equal(hash(JSON.stringify(inventory(mainFixtures, fixturePaths))), report.verificationInputs.mainFixturesSha256, '验收过程中共享合同样例变化');
  assert.deepEqual(sql(`${project}-postgres-1`, protectionSql), original.state, '主仓原业务状态变化');
  assertDsaTarget(inspect(target.Id));
  report.completedAt = new Date().toISOString(); report.realSourcesRequested = false; save();
} catch (error) {
  report.failure = { name: error.name, message: error.message }; save(); process.exitCode = 1;
} finally {
  if (bridge) await new Promise((done) => bridge.close(done));
  try {
    const remaining = command(['ps', '-a', '--filter', `label=org.openai.thesis-ledger.dg2a=${name}`, '--format', '{{.ID}}'])
      .trim().split('\n').filter(Boolean);
    assert(remaining.length <= 1, '本轮资源身份不唯一，保留现场');
    if (remaining.length) {
      assertOwnedProbe(inspect(remaining[0]), name, target.Image);
      command(['rm', '--force', remaining[0]]);
    }
    report.cleaned = true;
  } catch (error) { report.cleanupFailure = error.message; process.exitCode = 1; }
  save();
  console.log(JSON.stringify({ path: reportPath, candidate: report.candidate?.image, matrix: report.matrix,
    sdkScenarios: report.sdkConsumers.length, cleaned: report.cleaned, failure: report.failure }));
}
