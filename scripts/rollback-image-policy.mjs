import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repositoriesByTarget = {
  all: ['daily-stock-analysis', 'thesis-ledger'],
  dsa: ['daily-stock-analysis'],
  'thesis-ledger': ['thesis-ledger'],
};
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const rollbackReferencePattern = /^(daily-stock-analysis|thesis-ledger):rollback-([a-f0-9]{64})$/;
const imageFormat = '{"Id":{{json .Id}},"Created":{{json .Created}},"RepoTags":{{json .RepoTags}}}';
const containerFormat = '{"Id":{{json .Id}},"Image":{{json .Image}}}';

function requireImageId(id) {
  if (!imageIdPattern.test(id)) throw new Error('镜像 ID 必须为完整 SHA256');
  return id;
}

export function readConfiguration(env = process.env, extraProtected = [], spaceRecovery = false) {
  const raw = env.ROLLBACK_IMAGE_KEEP_COUNT ?? '2';
  const keepCount = Number(raw);
  const validCount = spaceRecovery ? /^(0|[1-9][0-9]*)$/.test(raw) : /^[1-9][0-9]*$/.test(raw);
  if (!validCount || !Number.isSafeInteger(keepCount)) {
    throw new Error('ROLLBACK_IMAGE_KEEP_COUNT 必须是大于零的安全整数；容量恢复模式允许零');
  }
  const protectedReferences = (env.ROLLBACK_PROTECTED_IMAGES ?? '').split(/\s+/).filter(Boolean);
  protectedReferences.push(...extraProtected);
  for (const reference of protectedReferences) {
    if (!imageIdPattern.test(reference) && !rollbackReferencePattern.test(reference)) {
      throw new Error('保护基线必须为完整镜像 ID 或本仓回滚标签');
    }
  }
  return { keepCount, protectedReferences: [...new Set(protectedReferences)] };
}

function compareNewest(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.imageId < b.imageId) return -1;
  if (a.imageId > b.imageId) return 1;
  return 0;
}

export function planRollbackImages({ images, containers, repositories, keepCount, protectedIds = [] }) {
  if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error('保留数量必须为非负安全整数');
  const usedIds = new Set(containers.map((container) => requireImageId(container.Image)));
  const pinnedIds = new Set(protectedIds.map(requireImageId));
  const retained = [];
  const remove = [];
  for (const repository of repositories) {
    if (!repositoriesByTarget.all.includes(repository)) throw new Error('不支持的镜像仓库');
    const entries = new Map();
    for (const image of images) {
      requireImageId(image.Id);
      if (!Array.isArray(image.RepoTags)) throw new Error('镜像标签清单无效');
      const ownTags = image.RepoTags.filter((tag) => tag.startsWith(`${repository}:rollback-`));
      if (ownTags.length === 0) continue;
      const reference = `${repository}:rollback-${image.Id.slice(7)}`;
      if (ownTags.length !== 1 || ownTags[0] !== reference) throw new Error('回滚标签与镜像 ID 不一致');
      const createdAt = Date.parse(image.Created);
      if (!Number.isFinite(createdAt) || !/^\d{4}-\d{2}-\d{2}T/.test(image.Created)) {
        throw new Error('镜像创建时间无效');
      }
      const reasons = [];
      const extraTags = image.RepoTags.filter((tag) => tag !== reference);
      if (extraTags.length > 0) reasons.push('额外标签保护');
      if (usedIds.has(image.Id)) reasons.push('现存容器引用');
      if (pinnedIds.has(image.Id)) reasons.push('指定或更新前回退基线');
      entries.set(image.Id, { repository, reference, imageId: image.Id, createdAt, reasons, extraTags });
    }
    const exclusive = [...entries.values()].filter((entry) => entry.extraTags.length === 0);
    const protectedCount = exclusive.filter((entry) => entry.reasons.length > 0).length;
    let remaining = Math.max(0, keepCount - protectedCount);
    for (const entry of [...entries.values()].sort(compareNewest)) {
      if (entry.reasons.length > 0) retained.push(entry);
      else if (remaining > 0) {
        retained.push({ ...entry, reasons: ['历史数量保留'] });
        remaining -= 1;
      } else remove.push(entry);
    }
  }
  remove.sort((a, b) => -compareNewest(a, b));
  return { keepCount, repositories, retained, remove };
}

function runCommand(binary, args, input) {
  return execFileSync(binary, args, { encoding: 'utf8', input, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}

function lines(value) {
  return value.trim().split('\n').filter(Boolean);
}

function inspectRecords(docker, kind, references, format) {
  if (references.length === 0) return [];
  const records = lines(docker(kind, 'inspect', '--format', format, ...references)).map((line) => JSON.parse(line));
  if (records.length !== references.length) throw new Error('Docker inspect 返回数量不一致');
  return records;
}

function readInventory(docker, repositories) {
  const references = new Set();
  for (const repository of repositories) {
    const found = lines(docker('image', 'ls', '--filter', `reference=${repository}:rollback-*`, '--format', '{{.Repository}}:{{.Tag}}'));
    for (const reference of found) {
      if (!rollbackReferencePattern.test(reference) || !reference.startsWith(`${repository}:`)) {
        throw new Error('回滚镜像列表包含非法标签');
      }
      references.add(reference);
    }
  }
  const images = inspectRecords(docker, 'image', [...references], imageFormat);
  const containerIds = lines(docker('ps', '-aq'));
  const containers = inspectRecords(docker, 'container', containerIds, containerFormat);
  return { images, containers };
}

function resolveProtectedIds(docker, references) {
  const images = inspectRecords(docker, 'image', references, imageFormat);
  return images.map((image, index) => {
    const id = requireImageId(image.Id);
    const expected = references[index].replace(/^.*:rollback-/, 'sha256:');
    if (id !== expected) throw new Error('指定回退基线的标签身份不一致');
    return id;
  });
}

function requireIdleBuilder(docker, context) {
  const statuses = docker('buildx', '--builder', context, 'history', 'ls', '--format', '{{.Status}}');
  if (/running|pending/i.test(statuses)) throw new Error('存在活动构建，停止回滚镜像淘汰');
}

function lockForContext(run, env, context) {
  if (env.DOCKER_HOST) throw new Error('不支持 DOCKER_HOST 覆盖');
  const endpoint = run('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  if (!endpoint.startsWith('unix://')) throw new Error('回滚维护仅支持本地 Docker context');
  const checksum = run('cksum', [], endpoint).trim().split(/\s+/)[0];
  if (!/^\d+$/.test(checksum)) throw new Error('更新锁标识无效');
  return join(env.TMPDIR || '/tmp', `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
}

function isProcessAncestor(owner, run) {
  let pid = process.ppid;
  const visited = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    if (String(pid) === owner) return true;
    if (pid <= 1 || visited.has(pid)) return false;
    visited.add(pid);
    const parent = run('ps', ['-p', String(pid), '-o', 'ppid=']).trim();
    if (!/^[1-9][0-9]*$/.test(parent) || !Number.isSafeInteger(Number(parent))) return false;
    pid = Number(parent);
  }
  return false;
}

function withUpdateLock(lockPath, owner, action, run) {
  const pidPath = join(lockPath, 'pid');
  if (owner !== undefined) {
    if (!/^[1-9][0-9]*$/.test(owner) || readFileSync(pidPath, 'utf8').trim() !== owner || !isProcessAncestor(owner, run)) {
      throw new Error('不能借用其他进程的更新锁');
    }
    return action();
  }
  try { mkdirSync(lockPath); } catch { throw new Error(`已有更新锁或锁目录不可用: ${lockPath}`); }
  let pidWritten = false;
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    pidWritten = true;
    return action();
  } finally {
    if (pidWritten) unlinkSync(pidPath);
    rmdirSync(lockPath);
  }
}

function applyPlan(initial, readPlan, docker, context, log) {
  const removed = [];
  const skipped = [];
  requireIdleBuilder(docker, context);
  for (const candidate of initial.remove) {
    requireIdleBuilder(docker, context);
    const current = readPlan().remove.find((entry) => entry.reference === candidate.reference);
    if (!current) {
      skipped.push(candidate.reference);
      log(`跳过已受保护或不再需要淘汰的镜像: ${candidate.reference}`);
      continue;
    }
    if (current.imageId !== candidate.imageId) throw new Error('候选镜像身份发生变化');
    requireIdleBuilder(docker, context);
    docker('image', 'rm', '--no-prune', candidate.reference);
    removed.push(candidate.reference);
    log(`已移除回滚标签: ${candidate.reference}`);
  }
  return { removed, skipped };
}

/** 两类镜像维护复用相同的本地 context、活动构建及更新锁校验。 */
export function withDockerMaintenanceLock(options, action, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const env = dependencies.env ?? process.env;
  const context = run('docker', ['context', 'show']).trim();
  const lockPath = lockForContext(run, env, context);
  const docker = (...args) => run('docker', ['--context', context, ...args]).trim();
  const idle = () => requireIdleBuilder(docker, context);
  const execute = () => {
    if (options.apply) idle();
    return action({ docker, context, idle });
  };
  if (options.apply) return withUpdateLock(lockPath, options.lockOwner, execute, run);
  if (options.lockOwner !== undefined) throw new Error('只读预览不接受借用更新锁');
  return execute();
}

export function runMaintenance(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const log = dependencies.log ?? console.log;
  const configuration = readConfiguration(env, options.protectedReferences, options.spaceRecovery === true);
  const repositories = repositoriesByTarget[options.target ?? 'all'];
  if (!repositories) throw new Error('目标必须为 all、dsa 或 thesis-ledger');
  if (options.validateConfig) return { validated: true };
  if (options.spaceRecovery && options.apply && options.lockOwner === undefined) {
    throw new Error('容量恢复执行必须借用已验证的更新锁');
  }
  return withDockerMaintenanceLock(options, ({ docker, context }) => {
    const protectedIds = resolveProtectedIds(docker, configuration.protectedReferences);
    const readPlan = () => planRollbackImages({ ...readInventory(docker, repositories), ...configuration, repositories, protectedIds });
    const plan = readPlan();
    log(JSON.stringify({ mode: options.apply ? '应用' : '只读预览', context, ...plan }, null, 2));
    if (!options.apply) return plan;
    const executionPlan = options.spaceRecovery ? { ...plan, remove: plan.remove.slice(0, 1) } : plan;
    const result = applyPlan(executionPlan, readPlan, docker, context, log);
    log(`回滚镜像维护完成：移除 ${result.removed.length} 个标签，跳过 ${result.skipped.length} 个候选；共享层释放量须另行实测。`);
    return result;
  }, dependencies);
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    apply: { type: 'boolean' }, help: { type: 'boolean' },
    'validate-config': { type: 'boolean' }, 'lock-owner': { type: 'string' },
    'space-recovery': { type: 'boolean' },
    protect: { type: 'string', multiple: true },
  } });
  if (values.help) {
    console.log('用法: node scripts/rollback-image-policy.mjs [all|dsa|thesis-ledger] [--apply]\n默认只读预览；ROLLBACK_IMAGE_KEEP_COUNT 默认 2，ROLLBACK_PROTECTED_IMAGES 保护指定回退基线。\n--space-recovery 为更新入口专属容量恢复：允许零目标，每次至多退役一个最旧候选；执行须借用更新锁。无实际删除返回2，失败返回1。');
    return;
  }
  if (positionals.length > 1) throw new Error('只接受一个维护目标');
  const result = runMaintenance({ target: positionals[0], apply: values.apply, validateConfig: values['validate-config'],
    lockOwner: values['lock-owner'], protectedReferences: values.protect, spaceRecovery: values['space-recovery'] });
  if (values['space-recovery'] && values.apply && result.removed?.length === 0) {
    console.log('本次没有退役历史回滚；停止容量恢复并保留保护边界。');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`回滚镜像维护失败: ${error.message}`);
    process.exitCode = 1;
  }
}
