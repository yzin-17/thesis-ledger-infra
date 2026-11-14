import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { selectTarget } from './options.mjs';

const executeSql = ['exec', '-T', 'postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -'];

export class DatabaseUpdate {
  constructor(runtime, target) {
    this.runtime = runtime; this.target = target; this.sqlFiles = [];
    this.mode = runtime.env.DEV_DATABASE_MODE ?? 'check';
    if (!['check', 'rebuild', 'upgrade'].includes(this.mode)) throw new Error('DEV_DATABASE_MODE 必须是 check、upgrade 或 rebuild。');
    const noBackup = runtime.env.DEV_DATABASE_UPGRADE_NO_BACKUP;
    if (noBackup && !['true', 'false'].includes(noBackup)) throw new Error('DEV_DATABASE_UPGRADE_NO_BACKUP 必须为 true 或 false。');
    this.noBackup = noBackup === 'true';
  }
  async initialize() {
    const config = JSON.parse(await this.runtime.compose(['config', '--format', 'json']));
    this.name = config.services?.postgres?.environment?.POSTGRES_DB;
    this.owner = config.services?.postgres?.environment?.POSTGRES_USER; this.project = config.name;
    if ([this.name, this.owner, this.project].some(value => typeof value !== 'string' || !value)) throw new Error('无法从 Compose 确认数据库目标和 owner。');
    if (this.noBackup && (this.mode !== 'upgrade' || this.project !== 'thesis-ledger-dev' || this.name !== 'thesis_ledger' || this.owner !== 'thesis_ledger'
      || !/^[a-f0-9]{64}$/.test(this.runtime.env.DEV_DATABASE_UPGRADE_MIGRATION_SHA256 ?? '')))
      throw new Error('不备份升级必须指定本开发库及迁移摘要。');
    if (this.mode !== 'check') {
      if (!['all', 'thesis-ledger'].includes(this.target)) throw new Error('数据库升级或重建需要选择 thesis-ledger 或 all。');
      if (this.mode === 'rebuild' && this.runtime.env.DEV_DATABASE_ALLOW_DATA_LOSS !== 'true') throw new Error('重建必须显式设置 DEV_DATABASE_ALLOW_DATA_LOSS=true。');
      if (this.runtime.env.DEV_DATABASE_CONFIRM !== `${this.project}/${this.name}`) throw new Error(`DEV_DATABASE_CONFIRM 必须精确匹配 ${this.project}/${this.name}。`);
    }
    this.permissions = resolve(this.runtime.root, '../thesis-ledger/infra/docker/bootstrap-app-role.sql');
  }
  async gate(mode, work) {
    const runtime = this.runtime;
    runtime.log(`生成数据库结构 SQL（模式: ${mode}）...`);
    const env = {
      NODE_ENV: 'development', DEV_DATABASE_MODE: mode,
      DEV_DATABASE_ALLOW_DATA_LOSS: runtime.env.DEV_DATABASE_ALLOW_DATA_LOSS ?? '',
      DEV_DATABASE_CONFIRM: runtime.env.DEV_DATABASE_CONFIRM ?? '', DEV_DATABASE_PROJECT: this.project,
      DEV_DATABASE_EXPECTED_DATABASE: this.name, DEV_DATABASE_EXPECTED_OWNER: this.owner,
      DEV_DATABASE_PERMISSIONS_SQL: '/tmp/bootstrap-app-role.sql',
    };
    const sql = await runtime.compose(['run', '--rm', '--no-deps', '-T', ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      '-v', `${this.permissions}:/tmp/bootstrap-app-role.sql:ro`, 'thesis-ledger', 'node', 'apps/server/dist/src/platform/dev-database-rebuild.js']);
    const path = join(work, `database-${mode}.sql`);
    writeFileSync(path, sql, { mode: 0o600 }); this.sqlFiles.push(path);
    runtime.log('校验 PostgreSQL 业务结构...');
    await runtime.compose(executeSql, { input: sql, stream: true });
  }
  async prepare(build) {
    this.target = build.target;
    if (!selectTarget(this.target).includes('thesis-ledger')) return;
    await this.runtime.compose(['up', '-d', '--no-build', 'postgres']); await this.runtime.wait('postgres');
    if (this.mode !== 'check') {
      await this.runtime.compose(['stop', 'thesis-ledger', 'backtest-worker']);
      if (this.mode === 'upgrade') { await this.upgrade(build.work); return; }
    }
    // 任一失败都传播；消费者停止后不得隐式重新启动。
    await this.gate(this.mode, build.work);
  }
  async upgrade(work) {
    const runtime = this.runtime;
    const backupRoot = runtime.env.DATABASE_UPGRADE_BACKUP_ROOT ?? join(runtime.root, '.database-upgrades');
    if (!isAbsolute(backupRoot)) throw new Error('DATABASE_UPGRADE_BACKUP_ROOT 必须为绝对路径。');
    mkdirSync(backupRoot, { recursive: true });
    const directory = mkdtempSync(join(backupRoot, 'run.')); chmodSync(directory, 0o700);
    const ids = [];
    for (const service of ['postgres', 'thesis-ledger', 'backtest-worker']) {
      const id = (await runtime.compose(['ps', '-aq', service])).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('数据库升级需要三个唯一完整容器 ID。');
      ids.push(id);
    }
    runtime.log(`数据库升级${this.noBackup ? '不备份；仅结构演练与旧数据摘要' : '备份与恢复演练'}；证据目录: ${directory}`);
    const input = await runtime.compose(['run', '--rm', '--no-deps', '-T', 'thesis-ledger', 'node', 'apps/server/dist/src/platform/database-upgrade-export.js']);
    writeFileSync(join(directory, 'image-input.json'), input, { mode: 0o600 });
    const prepare = (phase) => runtime.run('pnpm', ['--dir', resolve(runtime.root, '../thesis-ledger'), '--filter', '@thesis-ledger/server', 'exec', 'tsx', 'src/platform/database-upgrade-prepare.ts'], {
      env: { ...runtime.env, DATABASE_UPGRADE_RUN_DIR: directory, DATABASE_UPGRADE_CONTAINER: ids[0], DATABASE_UPGRADE_CONSUMERS: JSON.stringify(ids.slice(1)),
        DEV_DATABASE_PROJECT: this.project, DEV_DATABASE_EXPECTED_DATABASE: this.name, DEV_DATABASE_EXPECTED_OWNER: this.owner,
        DEV_DATABASE_PERMISSIONS_SQL: this.permissions, DATABASE_UPGRADE_PHASE: phase }, stream: true,
    });
    await prepare('prepare');
    try {
      await runtime.compose(executeSql, { input: readFileSync(join(directory, 'upgrade.sql'), 'utf8') });
      writeFileSync(join(directory, 'execute.log'), '事务执行成功。\n', { mode: 0o600 });
    } catch (error) {
      writeFileSync(join(directory, 'execute.log'), '事务执行失败；原始 SQL 错误输出未保存。\n', { mode: 0o600 });
      throw new Error(`数据库增量事务失败，消费者保持停止；证据位于 ${directory}。`, { cause: error });
    }
    if (this.noBackup) await prepare('verify-no-backup');
    await this.gate('check', work);
  }
  cleanup() { for (const path of this.sqlFiles) if (existsSync(path)) unlinkSync(path); }
}

export async function initializeEmptyVolumes(runtime, database) {
  if (runtime.env.INITIALIZE_EMPTY_DEV_VOLUMES !== 'true') return;
  const confirmation = `${database.project}/${database.name}`;
  if (confirmation !== 'thesis-ledger-dev/thesis_ledger' || runtime.env.EMPTY_DEV_CONFIRM !== confirmation) throw new Error('空开发卷初始化需要精确确认 thesis-ledger-dev/thesis_ledger。');
  const names = ['thesis-ledger-postgres-data', 'thesis-ledger-redis-data', 'thesis-ledger-dsa-data', 'thesis-ledger-backtest-data'];
  const missing = [];
  for (const name of names) { try { await runtime.docker(['volume', 'inspect', name]); } catch { missing.push(name); } }
  if (!missing.length) return;
  if ((await runtime.docker(['ps', '-aq'])).trim()) throw new Error('空开发卷初始化拒绝已有容器的环境。');
  const config = JSON.parse(await runtime.compose(['config', '--format', 'json']));
  if (!config.volumes || Object.keys(config.volumes).length !== names.length || names.some(name => config.volumes[name]?.name !== name || config.volumes[name]?.external !== true)) throw new Error('配置卷集合不匹配。');
  for (const name of (await runtime.docker(['volume', 'ls', '-q'])).trim().split('\n').filter(Boolean)) {
    if (!names.includes(name) || (await runtime.docker(['volume', 'inspect', '--format', '{{index .Labels "thesis-ledger.empty-development"}}', name])).trim() !== 'true') throw new Error('现有卷不属于本入口初始化，停止。');
  }
  for (const name of missing) await runtime.docker(['volume', 'create', '--label', 'thesis-ledger.empty-development=true', name]);
  runtime.log('已初始化空开发环境的四个配置卷；数据库仍需通过完整结构检查。');
}
