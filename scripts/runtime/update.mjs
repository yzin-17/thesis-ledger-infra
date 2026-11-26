import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readConfiguration } from './options.mjs';
import { BuildPlan } from './build.mjs';
import { BuildSpace } from './space.mjs';
import { DatabaseUpdate, initializeEmptyVolumes } from './database.mjs';
import { reinstall } from './reinstall.mjs';
import { activateStateSwitch, prepareStateSwitch } from './state-switch.mjs';
import { pinStateSwitchImages } from './state-switch-images.mjs';
import { booleanOption, imageIdPattern, positiveInteger, selectedServices, selectTarget } from './options.mjs';

export const updateUsage = `用法: ./scripts/update.sh [all|dsa|thesis-ledger]

默认目标为 all。环境参数：
  ENV_FILE                         Compose 环境文件
  HEALTH_TIMEOUT_SECONDS           健康检查超时秒数，默认120
  REUSE_DSA_IMAGE_ID                已完成且源码未变的 DSA 完整镜像 ID
  REUSE_THESIS_LEDGER_IMAGE_ID      已验 Server 完整镜像 ID；仅 thesis-ledger
  PULL_BASE_IMAGES / PULL_SERVICE_IMAGES  刷新基础或数据库/Redis 镜像，默认false
  BOOTSTRAP_SPACE_PROBE             显式允许全空环境下载首次探针
  INITIALIZE_EMPTY_DEV_VOLUMES / EMPTY_DEV_CONFIRM  空开发卷初始化及精确确认
  BUILD_HTTP_PROXY / BUILD_HTTPS_PROXY / BUILD_NO_PROXY  构建代理
  BUILD_ALPINE_MIRROR               可选 HTTPS Alpine 镜像根地址
  UPDATE_SPACE_MODE                auto 或 compact，默认auto
  REPAIR_BUILD_CACHE_ON_NO_SPACE    自动空间整备与保卷恢复，默认true
  BUILD_CACHE_MAX_USED_SPACE / BUILD_CACHE_RESERVED_SPACE  默认8gb/4gb
  BUILD_CACHE_MIN_FREE_SPACE / BUILD_HOST_MIN_FREE_SPACE    参考目标18gb/20gb
  BUILD_SPACE_HOST_PATH / BUILD_PROTECTED_IMAGES  宿主测量路径和完整镜像保护 ID
  DEV_DATABASE_MODE                check 默认；upgrade 保留数据；rebuild 显式重建
  DEV_DATABASE_ALLOW_DATA_LOSS      rebuild 必须显式为true
  DEV_DATABASE_CONFIRM             upgrade/rebuild 精确确认项目名/数据库名
  DEV_DATABASE_UPGRADE_NO_BACKUP    本开发库显式不备份增列；默认false
  DEV_DATABASE_UPGRADE_MIGRATION_SHA256  不备份时绑定唯一增列SQL的SHA256
  DATABASE_UPGRADE_BACKUP_ROOT      绝对升级备份目录
  DEV_STATE_SWITCH_PACKAGE         隔离演练通过的联合状态切换包，仅 all
`;

export async function checkpoint(runtime, target, recovery) {
  if (!selectTarget(target).includes('dsa')) return;
  const id = (await runtime.run(process.execPath, [join(runtime.root, 'scripts/dsa-runtime-recovery.mjs'),
    'snapshot', runtime.root, runtime.envFile, runtime.lockPath], { env: recovery ? { ...runtime.env,
      DSA_RUNTIME_VERIFIED_RECOVERY_IMAGE: JSON.stringify(recovery) } : runtime.env,
    onOutput: (value, kind) => { if (kind === 'stderr') runtime.log(value.trim()); },
  })).trim();
  if (!id) return;
  if (!imageIdPattern.test(id)) throw new Error('DSA 快照返回的镜像身份无效。');
  runtime.env.BUILD_PROTECTED_IMAGES = `${runtime.env.BUILD_PROTECTED_IMAGES ?? ''} ${id}`.trim();
  runtime.addComposeFile(join(runtime.root, '.maintenance-backups/dsa-runtime/mounts.compose.json'));
}

export async function startUpdated(runtime, build) {
  const services = selectedServices(build.target);
  if (runtime.env.REUSE_THESIS_LEDGER_IMAGE_ID) {
    await runtime.compose(['up', '-d', '--no-build', '--pull', 'never', 'postgres', 'redis', 'dsa']);
    for (const service of ['postgres', 'redis', 'dsa']) await runtime.wait(service);
  }
  runtime.log(`启动目标服务: ${services.join(' ')}`);
  try {
    await runtime.compose(['up', '-d', '--no-build', ...(runtime.env.REUSE_THESIS_LEDGER_IMAGE_ID ? ['--force-recreate', '--no-deps'] : []), ...services]);
    for (const service of services) await runtime.wait(service);
  } catch (error) {
    for (const service of selectTarget(build.target)) {
      try {
        const id = (await runtime.compose(['ps', '-aq', service])).trim().split('\n')[0];
        if (id) await runtime.docker(['logs', '--tail', '80', id], { stream: true, cleanup: true });
      } catch { /* 保留主错误；日志缺失不能触发重建。 */ }
    }
    throw error;
  }
}

export async function update(runtime, args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { runtime.log(updateUsage); return; }
  if (args.length > 1) throw new Error(updateUsage);
  let target = args[0] ?? 'all'; selectTarget(target);
  const mode = runtime.env.UPDATE_SPACE_MODE ?? 'auto';
  if (!['auto', 'compact'].includes(mode)) throw new Error('UPDATE_SPACE_MODE 必须为 auto 或 compact。');
  const repair = booleanOption(runtime.env, 'REPAIR_BUILD_CACHE_ON_NO_SPACE', true);
  if (mode === 'compact' && !repair) throw new Error('compact 保卷重建与关闭自动清理冲突。');
  const incomplete = join(runtime.root, '.maintenance-backups/docker-space-recovery/incomplete');
  if (mode === 'compact' || existsSync(incomplete)) { target = 'all'; runtime.log('保卷恢复模式：本次恢复范围为 all。'); }
  if (runtime.env.REUSE_DSA_IMAGE_ID && !selectTarget(target).includes('dsa')) throw new Error('DSA 镜像复用仅适用于 all 或 dsa。');
  positiveInteger(runtime.env.HEALTH_TIMEOUT_SECONDS ?? '120', 'HEALTH_TIMEOUT_SECONDS');
  readConfiguration(runtime.env);
  const pull = booleanOption(runtime.env, 'PULL_BASE_IMAGES');
  const pullServices = booleanOption(runtime.env, 'PULL_SERVICE_IMAGES');
  runtime.configureCompose();
  const space = new BuildSpace(runtime, { target, repair });
  const build = new BuildPlan(runtime, space, { target, pull });
  const database = new DatabaseUpdate(runtime, target);
  let primaryError;
  try {
    await runtime.connect(); await runtime.docker(['info']); await database.initialize();
    await build.configuration(); await space.initialize();
    await runtime.locked(async () => {
      await runtime.idle();
      const stateSwitch = await prepareStateSwitch(runtime, database, build.target);
      if (stateSwitch) {
        await pinStateSwitchImages(runtime, stateSwitch);
        await runtime.run('bash', [join(runtime.root, '../thesis-ledger/scripts/local-deployment.sh'),
          'verify-switch-recovery-images', stateSwitch.packagePath, stateSwitch.source.dsa.recovery,
          stateSwitch.source['backtest-worker'].recovery], { env: runtime.env, stream: true });
      }
      const originalDsa = stateSwitch?.source.dsa;
      await checkpoint(runtime, build.target, originalDsa && {
        container: originalDsa.id, sourceImage: originalDsa.image, recoveryImage: originalDsa.recovery,
      });
      for (const [service, key] of [['dsa', 'REUSE_DSA_IMAGE_ID'], ['thesis-ledger', 'REUSE_THESIS_LEDGER_IMAGE_ID']]) {
        if (runtime.env[key]) await build.validateReuse(service, runtime.env[key]);
      }
      await space.prepareProbe();
      if (mode === 'compact') await reinstall(build, '显式 compact 维护');
      else {
        try { await space.ensure('拉取前'); }
        catch (error) { if (error.code !== 76 || !repair) throw error; await reinstall(build, '整备后零余量'); }
      }
      await initializeEmptyVolumes(runtime, database); await build.prepareInputs();
      if (pullServices) await runtime.compose(['pull', 'postgres', 'redis'], { stream: true });
      await build.prepareBaseImages();
      runtime.log(`构建应用镜像: ${selectTarget(build.target).join(' ')}`);
      await build.withRetry(reason => reinstall(build, reason));
      try { await space.maintain('构建后'); } catch { runtime.log('警告：构建后缓存维护失败，继续启动已完成镜像。'); }
      const start = async () => { await database.prepare(build); await startUpdated(runtime, build); };
      if (stateSwitch) {
        const verify = () => runtime.run('bash', [join(runtime.root, '../thesis-ledger/scripts/local-deployment.sh'),
          'verify-state-switch', stateSwitch.packagePath], { env: runtime.env, stream: true });
        await activateStateSwitch(runtime, stateSwitch, start, verify);
      } else await start();
      if (existsSync(incomplete)) unlinkSync(incomplete);
      runtime.log('源码栈更新完成，当前状态:'); runtime.log(await runtime.compose(['ps']));
      try { await space.finalize(); } catch { runtime.log('警告：新服务健康，最终空间维护未全部完成；不重新构建。'); }
    });
  } catch (error) {
    primaryError = error;
    try { runtime.log(await runtime.compose(['ps', '-a'], { cleanup: true })); } catch { /* 原错误保持。 */ }
    throw error;
  } finally {
    database.cleanup();
    try { await build.cleanup(); } catch (error) { if (!primaryError) throw error; runtime.log('构建临时目录清理失败，保留现场。'); }
  }
}
