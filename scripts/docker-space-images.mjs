import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfiguration } from './runtime/options.mjs';
import { LocalDocker } from './runtime/docker.mjs';

const repositories = { all: ['daily-stock-analysis', 'thesis-ledger'], dsa: ['daily-stock-analysis'],
  'thesis-ledger': ['thesis-ledger'] };
const devTags = { 'daily-stock-analysis': 'daily-stock-analysis:thesisledger-dev', 'thesis-ledger': 'thesis-ledger:dev' };
const idPattern = /^sha256:[a-f0-9]{64}$/;
const lines = (value) => value.trim().split('\n').filter(Boolean);
const requireId = (id) => { if (!idPattern.test(id)) throw new Error('镜像ID必须为完整SHA256'); return id; };

export function planSpaceImages({ images, containers, target = 'all', protectedIds = [], allUnused = false }) {
  const selected = repositories[target];
  if (!selected) throw new Error('目标必须为 all、dsa 或 thesis-ledger');
  const protectedSet = new Set([...containers.map((item) => requireId(item.Image)), ...protectedIds.map(requireId)]);
  const normalized = images.map((image) => {
    requireId(image.Id);
    if (image.RepoTags !== null && !Array.isArray(image.RepoTags)) throw new Error('镜像标签清单无效');
    if (image.RepoTags?.some((tag) => typeof tag !== 'string' || !tag.trim())) throw new Error('镜像标签内容无效');
    return { ...image, RepoTags: image.RepoTags ?? [] };
  });
  if (new Set(normalized.map((image) => image.Id)).size !== normalized.length) throw new Error('镜像库存ID重复');
  if (allUnused) {
    const remove = normalized.filter((image) => !protectedSet.has(image.Id)).flatMap((image) =>
      (image.RepoTags.length ? image.RepoTags : [image.Id]).map((reference) =>
        ({ imageId: image.Id, reference, kind: 'unused' })));
    return { target, allUnused, remove, protectedIds: [...protectedSet] };
  }
  const remove = [];
  for (const image of normalized) {
    if (protectedSet.has(image.Id)) continue;
    if (image.RepoTags.length === 0) {
      remove.push({ imageId: image.Id, reference: image.Id, kind: 'dangling' });
    } else if (image.RepoTags.length === 1 && selected.some((repo) => image.RepoTags[0] === devTags[repo])) {
      remove.push({ imageId: image.Id, reference: image.RepoTags[0], kind: 'unused-dev' });
    }
  }
  remove.sort((a, b) => a.reference.localeCompare(b.reference));
  return { target, remove, protectedIds: [...protectedSet] };
}

function inspect(docker, kind, refs, format) {
  if (!refs.length) return [];
  const records = lines(docker(kind, 'inspect', '--format', format, ...refs)).map((line) => JSON.parse(line));
  if (records.length !== refs.length) throw new Error('Docker库存读取数量不一致');
  return records;
}

function inventory(docker) {
  const imageIds = [...new Set(lines(docker('image', 'ls', '-aq', '--no-trunc')))];
  const containerIds = lines(docker('ps', '-aq'));
  return {
    images: inspect(docker, 'image', imageIds, '{"Id":{{json .Id}},"RepoTags":{{json .RepoTags}}}'),
    containers: inspect(docker, 'container', containerIds, '{"Id":{{json .Id}},"Image":{{json .Image}}}'),
  };
}

export function runSpaceImageMaintenance(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const configuration = readConfiguration(env, options.protectedReferences);
  const log = dependencies.log ?? console.log;
  const runtime = new LocalDocker({ env, runSync: dependencies.run && ((binary, args, settings) => dependencies.run(binary, args, settings?.input)) }).connectSync();
  const docker = (...args) => runtime.dockerSync(args).trim();
  const idle = () => runtime.idleSync(), context = runtime.context;
  const execute = () => {
    if (options.apply) idle();
    const protectedIds = inspect(docker, 'image', configuration.protectedReferences,
      '{"Id":{{json .Id}}}').map((item, index) => {
      const expected = configuration.protectedReferences[index];
      if (requireId(item.Id) !== expected) throw new Error('保护镜像身份发生变化');
      return item.Id;
    });
    const readPlan = () => planSpaceImages({ ...inventory(docker), target: options.target ?? 'all',
      protectedIds, allUnused: options.allUnused === true });
    const plan = readPlan();
    log(JSON.stringify({ mode: options.apply ? '应用' : '只读预览', context, ...plan }, null, 2));
    if (!options.apply) return plan;
    const removed = [];
    const skipped = [];
    for (const candidate of plan.remove) {
      idle();
      const current = readPlan().remove.find((item) => item.reference === candidate.reference);
      if (!current) { skipped.push(candidate.reference); continue; }
      if (current.imageId !== candidate.imageId || current.kind !== candidate.kind) throw new Error('清理候选身份发生变化');
      idle();
      docker('image', 'rm', '--no-prune', candidate.reference);
      removed.push(candidate);
    }
    log(JSON.stringify({ removed, skipped, remeasureRequired: true }, null, 2));
    return { removed, skipped };
  };
  if (options.apply) return runtime.lockedSync(execute, options.lockOwner);
  if (options.lockOwner !== undefined) throw new Error('只读预览不接受借用更新锁。');
  return execute();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      apply: { type: 'boolean' }, 'lock-owner': { type: 'string' }, protect: { type: 'string', multiple: true },
      'all-unused': { type: 'boolean' },
    } });
    if (positionals.length > 1) throw new Error('只接受一个维护目标');
    runSpaceImageMaintenance({ target: positionals[0], apply: values.apply,
      lockOwner: values['lock-owner'], protectedReferences: values.protect, allUnused: values['all-unused'] });
  } catch (error) { console.error(`Docker镜像空间整备失败: ${error.message}`); process.exitCode = 1; }
}
