import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runApplicationCommand } from '../application-contract.mjs';
import { checksum, digest } from '../state-backup.mjs';
import { captureRedisNamespace } from '../redis-namespace-recovery.mjs';
import { imageIdPattern } from './options.mjs';

const writers = ['thesis-ledger', 'backtest-worker', 'dsa'];
const stores = {
  postgres: { service: 'postgres', target: '/var/lib/postgresql/data' },
  redis: { service: 'redis', target: '/data' },
  dsa: { service: 'dsa', target: '/app/data' },
  backtest: { service: 'backtest-worker', target: '/app/var/backtest' },
};
const containerServices = ['postgres', 'redis', 'dsa', 'thesis-ledger', 'backtest-worker'];
const namePattern = /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/u;
const switchDir = (runtime) => join(runtime.root, '.maintenance-backups/state-switch');

async function readPackage(runtime, file, database) {
  const root = realpathSync(resolve(runtime.root, '../thesis-ledger/.recovery-artifacts'));
  const privatePath = (path, isDirectory = false) => {
    assert(isAbsolute(path) && !path.includes(',') && realpathSync(path).startsWith(root + sep));
    const stat = lstatSync(path);
    assert((isDirectory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0);
    return path;
  };
  const plan = JSON.parse(readFileSync(privatePath(file), 'utf8'));
  assert.equal(plan.format, 'thesis-ledger-state-switch-v1');
  assert.equal(plan.target, database.project);
  assert.equal(plan.target, 'thesis-ledger-dev');
  assert.equal(plan.databaseName, database.name);
  assert.equal(plan.ownerName, database.owner);
  assert(namePattern.test(plan.sqliteName) && /^[a-zA-Z0-9:_-]+:$/.test(plan.redisNamespace));
  assert(Array.isArray(plan.redisTransientKeys) && plan.redisTransientKeys.every((key) => key.startsWith(plan.redisNamespace)));
  assert(/^[a-f0-9]{32}$/u.test(plan.expectedSource) && namePattern.test(plan.targetHead));
  assert(typeof plan.sourceGuard === 'string' && /^SELECT\b/u.test(plan.sourceGuard));
  assert(typeof plan.schemaHeadSql === 'string' && /^SELECT\b/u.test(plan.schemaHeadSql));
  for (const key of ['dsaFileTree', 'backtestFileTree', 'convertedFileTree']) assert(/^[a-f0-9]{64}$/u.test(plan[key]));
  assert(Number.isSafeInteger(plan.statusRevision) && plan.statusRevision > 0);
  for (const name of ['migration', 'sqlite', 'sqliteSnapshot', 'dsaArchive', 'backtestArchive', 'redis']) {
    const { path, sha256 } = plan[name];
    assert.equal(await checksum(privatePath(path)), sha256, '切换包载荷已改变 ' + name);
  }
  privatePath(plan.convertedBacktest, true);
  return plan;
}

const inspectField = async (runtime, id, format, cleanup = false) =>
  (await runtime.docker(['inspect', '--format', format, id], { cleanup })).trim();
const readOne = async (runtime, service, command, options) =>
  (await runtime.docker(['exec', '-i', service, ...command], options)).trim();
const copiedVolume = (plan, token, name) => `${plan.target}-state-${token}-${name}`;

function copyRunner(runtime, plan, token) {
  return (name, image, args, options) => runtime.dockerSync(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--user', '0:0', '--label', 'io.thesisledger.state-switch=' + token,
    '--mount', `type=volume,source=${copiedVolume(plan, token, name)},target=/copy,volume-nocopy`,
    ...args, image, ...options.command], { encoding: null, timeout: 120_000, maxBuffer: 128 * 1024 * 1024, input: options.input });
}

function verifyCopyFiles(runtime, plan, image, withCopy, stoppedDsaVolume) {
  const app = resolve(runtime.root, '../daily-stock-analysis');
  const sqliteReader = runApplicationCommand(app, ['snapshot-state-program'], { env: runtime.env });
  const sqliteRead = withCopy('dsa', image, ['-i', '-e', 'DATABASE_PATH=/copy/' + plan.sqliteName,
    '--entrypoint', 'python'], { command: ['-'], input: sqliteReader });
  assert.equal(digest(sqliteRead), plan.sqliteSnapshot.sha256, '停止后 DSA SQLite 已变化');
  const treeProgram = runApplicationCommand(app, ['state-tree-program'], { env: runtime.env });
  const treeDigest = (name, root, mounts, ignored) => withCopy(name, image,
    ['-i', ...mounts, '--entrypoint', 'python'], { command: ['-', root, ...ignored], input: treeProgram }).toString().trim();
  const ignored = ['', '-wal', '-shm'].map((suffix) => plan.sqliteName + suffix);
  // SQLite 是本次替换项。其余文件随原卷逐字节复制，直接和停写后的源卷核对。
  const dsaSource = stoppedDsaVolume
    ? treeDigest('dsa', '/origin', ['--mount', `type=volume,source=${stoppedDsaVolume},target=/origin,readonly,volume-nocopy`], ignored)
    : plan.dsaFileTree;
  assert.equal(treeDigest('dsa', '/copy', [], ignored), dsaSource, 'DSA 文件副本与源卷不一致');
  assert.equal(treeDigest('backtest', '/copy', [], []), plan.backtestFileTree, '停止后回测制品已变化');
  const artifactMount = ['--mount', `type=bind,source=${plan.convertedBacktest},target=/input,readonly`];
  assert.equal(treeDigest('backtest', '/input', artifactMount, []), plan.convertedFileTree, '暂存制品已变化');
  return { artifactMount, dsaSource };
}

/** 只对本次应用切换创建的副本运行文件读回，保留源服务和副本。 */
export async function verifyRecordedStateSwitchCopies(runtime, database, packagePath, token) {
  assert(runtime.lockOwned && /^[a-f0-9-]{36}$/u.test(token));
  const plan = await readPackage(runtime, packagePath, database);
  for (const key of Object.keys(stores)) {
    const volume = copiedVolume(plan, token, key);
    const label = (await runtime.docker(['volume', 'inspect', '--format', '{{index .Labels "io.thesisledger.state-switch"}}', volume])).trim();
    assert.equal(label, token);
  }
  const candidate = (await runtime.docker(['image', 'inspect', '--format', '{{.Id}}', 'daily-stock-analysis:thesisledger-dev'])).trim();
  assert(imageIdPattern.test(candidate));
  verifyCopyFiles(runtime, plan, candidate, copyRunner(runtime, plan, token));
}

export async function prepareStateSwitch(runtime, database, target) {
  const packagePath = runtime.env.DEV_STATE_SWITCH_PACKAGE;
  if (!packagePath) return undefined;
  assert(target === 'all' && database.mode === 'check' && runtime.env.DEV_DATABASE_CONFIRM === `${database.project}/${database.name}`,
    '联合切换需要 update.sh all、check 模式和精确数据库确认');
  assert(!existsSync(join(switchDir(runtime), 'active.compose.json')), '当前运行态已完成一次状态切换');
  const plan = await readPackage(runtime, packagePath, database);
  const source = {};
  for (const service of containerServices) {
    const id = (await runtime.compose(['ps', '-q', service])).trim();
    assert(/^[a-f0-9]{64}$/u.test(id), '切换源服务必须在运行 ' + service);
    const image = await inspectField(runtime, id, '{{.Image}}');
    assert(imageIdPattern.test(image));
    const expected = plan.sourceImages[service === 'thesis-ledger' ? 'server' : service === 'backtest-worker' ? 'worker' : service];
    assert.equal(image, expected, '切换源镜像变化 ' + service);
    source[service] = { id, image, mounts: JSON.parse(await inspectField(runtime, id, '{{json .Mounts}}')) };
  }
  for (const store of Object.values(stores)) {
    const mounts = source[store.service].mounts.filter((mount) => mount.Destination === store.target);
    assert(mounts.length === 1 && mounts[0].Type === 'volume' && mounts[0].RW && namePattern.test(mounts[0].Name));
  }
  const psql = ['psql', '-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-U', plan.ownerName, '-d', plan.databaseName];
  const verifySource = async (id) => assert.equal(await readOne(runtime, id, psql, { input:
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + plan.sourceGuard + '\nROLLBACK;\n' }), plan.expectedSource,
  '目标 PostgreSQL 数据已偏离通过演练的切换包');
  await verifySource(source.postgres.id);
  runtime.env.BUILD_PROTECTED_IMAGES = [runtime.env.BUILD_PROTECTED_IMAGES, ...containerServices.map((key) => source[key].image)]
    .filter(Boolean).join(' ');
  return { plan, packagePath, source, psql, verifySource };
}

export async function activateStateSwitch(runtime, prepared, start, verify) {
  assert(runtime.lockOwned, '状态切换需要正式更新锁');
  const { plan, source, psql, verifySource } = prepared;
  const directory = join(switchDir(runtime), randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const candidatePath = join(directory, 'candidate.compose.json');
  const privateServer = join(directory, 'verification.compose.yml');
  const rollbackPath = join(directory, 'rollback.compose.json');
  const rollback = Object.fromEntries(containerServices.map((service) => [service, { image: source[service].recovery }]));
  assert(containerServices.every((service) => rollback[service].image));
  writeFileSync(rollbackPath, JSON.stringify({ services: rollback }), { flag: 'wx', mode: 0o600 });
  writeFileSync(privateServer, 'services:\n  thesis-ledger:\n    ports: !reset []\n  dsa:\n    ports: !reset []\n', { flag: 'wx', mode: 0o600 });
  const transient = new Set(plan.redisTransientKeys);
  const stableQueueValues = (rows) => rows.filter((row) => !transient.has(row.key) || row.expiresAt === -1)
    .map(({ key, expiresAt, hashFields, payload }) => ({ key, expiresAt, value: hashFields ?? payload }));
  const redisArchive = stableQueueValues(JSON.parse(readFileSync(plan.redis.path, 'utf8')));
  const verifyRedis = (id) => assert(isDeepStrictEqual(stableQueueValues(captureRedisNamespace(id, plan.redisNamespace)), redisArchive),
    '目标 Redis 持久作业已偏离切换包');
  await verifySource(source.postgres.id);
  verifyRedis(source.redis.id);
  let stopped = false, startedCandidate = false, stage = '停写';
  const replacements = {};
  const services = {};
  const volumes = {};
  const token = directory.split(sep).at(-1);
  const label = 'io.thesisledger.state-switch=' + token;
  const withCopy = copyRunner(runtime, plan, token);
  try {
    stopped = true;
    await runtime.compose(['stop', '-t', '45', ...writers]);
    await verifySource(source.postgres.id);
    verifyRedis(source.redis.id);
    await runtime.compose(['stop', '-t', '60', 'redis', 'postgres']);
    for (const service of containerServices)
      assert.equal(await inspectField(runtime, source[service].id, '{{.State.Running}}'), 'false');

    stage = '复制源卷';
    for (const [name, store] of Object.entries(stores)) {
      const oldVolume = source[store.service].mounts.find((mount) => mount.Destination === store.target).Name;
      const volume = copiedVolume(plan, token, name);
      const key = 'converted-' + name;
      assert.equal((await runtime.docker(['volume', 'create', '--label', label, volume])).trim(), volume);
      replacements[name] = volume;
      volumes[key] = { name: volume, external: true };
      for (const service of name === 'backtest' ? ['thesis-ledger', 'backtest-worker'] : [store.service])
        services[service] = { volumes: [{ type: 'volume', source: key, target: store.target }] };
      withCopy(name, source.postgres.image, ['--mount', `type=volume,source=${oldVolume},target=/origin,readonly,volume-nocopy`,
        '--entrypoint', '/bin/sh'], { command: ['-ec', 'set -o pipefail; tar -C /origin -cf - . | tar -C /copy -xpf -'] });
    }

    stage = '核对副本文件';
    const stoppedDsaVolume = source.dsa.mounts.find((mount) => mount.Destination === stores.dsa.target).Name;
    const { artifactMount, dsaSource } = verifyCopyFiles(runtime, plan, source.dsa.recovery, withCopy, stoppedDsaVolume);
    writeFileSync(join(directory, 'source-checkpoint.json'), JSON.stringify({
      postgres: plan.expectedSource, dsaSqlite: plan.sqliteSnapshot.sha256, dsaFiles: dsaSource,
      backtestFiles: plan.backtestFileTree, volumes: Object.fromEntries(Object.entries(stores).map(([key, store]) =>
        [key, source[store.service].mounts.find((mount) => mount.Destination === store.target).Name])),
    }, null, 2), { flag: 'wx', mode: 0o600 });

    stage = '安装 SQLite 和回测制品';
    withCopy('dsa', source.postgres.image, ['--mount', `type=bind,source=${plan.sqlite.path},target=/input,readonly`, '--entrypoint', 'sh'],
      { command: ['-ec', 'cp /input "/copy/$1"; rm -f "/copy/$1-wal" "/copy/$1-shm"', 'install', plan.sqliteName] });
    withCopy('backtest', source.postgres.image, [...artifactMount, '--entrypoint', 'sh'], { command: ['-ec',
      'set -o pipefail; for namespace in /input/*; do name="${namespace##*/}"; owner="$(stat -c %u:%g "/copy/$name")"; tar -C /input -cf - "$name" | tar -C /copy -xpf -; chown -R "$owner" "/copy/$name"; done'] });

    stage = '应用 PostgreSQL 副本事务';
    const instance = (await runtime.docker(['run', '--detach', '--rm', '--network', 'none', '--pull', 'never', '--label', label,
      '--mount', `type=volume,source=${replacements.postgres},target=${stores.postgres.target},volume-nocopy`, source.postgres.image])).trim();
    assert(/^[a-f0-9]{64}$/u.test(instance));
    try {
      const expires = Date.now() + 30_000;
      while (true) {
        try { await readOne(runtime, instance, ['pg_isready', '-U', plan.ownerName, '-d', plan.databaseName]); break; }
        catch (error) { if (Date.now() >= expires) throw error; await runtime.sleep(500); }
      }
      await verifySource(instance);
      assert.equal(await checksum(plan.migration.path), plan.migration.sha256, '事务载荷已改变');
      await readOne(runtime, instance, [...psql, '-o', '/dev/null'], { input: readFileSync(plan.migration.path), timeout: 120_000 });
      const head = 'BEGIN READ ONLY;\n' + plan.schemaHeadSql + '\nROLLBACK;\n';
      assert.equal(await readOne(runtime, instance, psql, { input: head }), plan.targetHead);
    } finally {
      await runtime.docker(['stop', '-t', '45', instance], { cleanup: true });
    }

    writeFileSync(candidatePath, JSON.stringify({ services, volumes }), { flag: 'wx', mode: 0o600 });
    runtime.addComposeFile(candidatePath);
    runtime.addComposeFile(privateServer);
    stage = '启动隔离端口的候选服务';
    startedCandidate = true;
    await start();
    stage = '验证候选服务';
    await verify(prepared);
    stage = '开放已核验服务端口';
    runtime.files = runtime.files.filter((file) => file !== privateServer);
    await runtime.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'dsa']);
    await runtime.wait('dsa');
    await runtime.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'thesis-ledger']);
    await runtime.wait('thesis-ledger');
    const activePath = join(switchDir(runtime), 'active.compose.json');
    renameSync(candidatePath, activePath);
    runtime.files = runtime.files.map((file) => file === candidatePath ? activePath : file);
    stopped = false;
    runtime.log('联合状态切换及读回已完成；源卷、备份和原镜像保留。');
  } catch (error) {
    const record = (name, failure) => writeFileSync(join(directory, name + '.json'), JSON.stringify({ stage,
      message: failure.message, detail: failure.stderr?.toString() }, null, 2), { flag: 'wx', mode: 0o600 });
    record('activation-failure', error);
    if (stopped) {
      runtime.files = runtime.files.filter((file) => file !== candidatePath && file !== privateServer);
      try {
        if (startedCandidate) {
          runtime.addComposeFile(rollbackPath);
          await runtime.compose(['up', '-d', '--no-build', '--pull', 'never', '--force-recreate', ...containerServices], { cleanup: true });
        } else {
          for (const service of containerServices) {
            await runtime.compose(['start', service], { cleanup: true });
            await runtime.wait(service, { cleanup: true });
          }
        }
        for (const service of containerServices) await runtime.wait(service, { cleanup: true });
        await verifySource(`${plan.target}-postgres-1`);
        runtime.log('联合变更终止，已从原镜像及原卷恢复。');
      } catch (restoreError) {
        record('rollback-failure', restoreError);
        throw new AggregateError([error, restoreError], '联合切换及原状态自动恢复失败，保留两套卷和本次证据 ' + directory);
      }
    }
    throw new Error(`联合切换在「${stage}」失败，证据位于 ${directory}`, { cause: error });
  }
}
