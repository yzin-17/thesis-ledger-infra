import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDocker } from '../runtime/docker.mjs';
import { createRunner, CommandFailure } from '../runtime/process.mjs';
import { selectedImages } from '../runtime/options.mjs';

export const fullId = number => `sha256:${number.toString(16).padStart(64, '0')}`;
export const df = available => `Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 999999999 1 ${available} 1% /\n`;

export function fixture(t, options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'node-infra-fixture-'));
  t.onTestFinished(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'infra'); mkdirSync(root);
  for (const name of ['.env', 'compose.yml', 'compose.dev.yml']) writeFileSync(join(root, name), 'controlled');
  for (const app of ['thesis-ledger', 'daily-stock-analysis']) {
    const path = join(temporary, app, 'scripts/deployment'); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'apply-code.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(path, '../local-deployment.sh'), '#!/bin/sh\nexit 0\n');
  }
  const names = ['thesis-ledger-postgres-data', 'thesis-ledger-redis-data', 'thesis-ledger-dsa-data', 'thesis-ledger-backtest-data'];
  const state = {
    calls: [], messages: [], tags: new Map(), builds: [], hostAvailable: 40 * 1024 ** 2, dockerAvailable: 40 * 1024 ** 2,
    ids: Object.fromEntries(['dsa', 'thesis-ledger', 'backtest-worker', 'postgres', 'redis'].map((name, i) => [name, (i + 1).toString().repeat(64)])),
    volumes: new Map(names.map(name => [name, 'true'])), containerList: '',
    config: { name: 'thesis-ledger-dev', services: { postgres: { environment: { POSTGRES_DB: 'thesis_ledger', POSTGRES_USER: 'owner' } } },
      volumes: Object.fromEntries(names.map(name => [name, { name, external: true }])) },
    ...options,
  };
  for (const [source, alias] of selectedImages('all')) { state.tags.set(source, fullId(99)); state.tags.set(alias, fullId(99)); }
  state.tags.set('node:24-alpine', fullId(99)); state.tags.set('postgres:17-alpine', fullId(99));
  state.tags.set('daily-stock-analysis:thesisledger-dev', fullId(1)); state.tags.set('thesis-ledger:dev', fullId(2));
  const fail = (code = 1, stderr = '') => { throw new CommandFailure('fixture', code, '', stderr); };
  const run = async (binary, args, commandOptions = {}) => {
    state.calls.push([binary, ...args]);
    if (state.intercept) { const value = await state.intercept(binary, args, commandOptions, fail); if (value !== undefined) return value; }
    if (binary === 'cksum') return '123 20';
    if (binary === 'ps') { if (state.psDenied) fail(); return '1'; }
    if (binary === 'df') return df(state.hostAvailable);
    if (binary === 'bash') {
      const mode = args[1];
      if (mode === 'build-config') return JSON.stringify({ services: { dsa: { build: { additional_contexts: { application_source: args[2] } } } } });
      if (mode === 'prepare-build') { if (state.prefetchFailure) fail(); return ''; }
      if (mode === 'cleanup-build') return '';
      if (mode === 'validate-image') {
        const path = fileURLToPath(new URL('../../../thesis-ledger/scripts/local-deployment.sh', import.meta.url));
        return createRunner()(binary, [path, mode], { input: commandOptions.input });
      }
      if (mode === 'sync-preflight') { if (state.preflightFailure) fail(); return ''; }
      if (mode === 'sync-payload') {
        if (state.payloadFailure) fail(); mkdirSync(args[2], { recursive: true }); writeFileSync(join(args[2], 'payload'), 'controlled'); return '';
      }
    }
    if (binary === 'pnpm') {
      if (state.upgradePrepareFailure) fail();
      writeFileSync(join(commandOptions.env.DATABASE_UPGRADE_RUN_DIR, 'upgrade.sql'), 'SELECT 1;'); return '';
    }
    if (binary === process.execPath) {
      if (args[0].endsWith('dsa-runtime-recovery.mjs')) return state.checkpoint ?? '';
      if (args[0].endsWith('docker-space-images.mjs')) { if (state.imageRepair) state.imageRepair(); return ''; }
      if (args[0].endsWith('docker-reinstall-plan.mjs')) return JSON.stringify({ services: {}, volumes: {}, 'x-thesis-ledger-recovery': { volumeNames: [...state.volumes.keys()] } });
    }
    if (binary !== 'docker') throw new Error(`未声明命令: ${binary}`);
    const a = args[0] === '--context' ? args.slice(2) : args;
    if (a[0] === 'context') return a[1] === 'show' ? 'local' : 'unix:///controlled.sock';
    if (a[0] === 'info') return a.includes('{{.Containers}} {{.Images}}') ? (state.inventory ?? '0 0') : (state.operatingSystem ?? 'Linux');
    if (a[0] === 'image') {
      const reference = a.at(-1);
      if (a[1] === 'inspect') {
        const id = state.tags.get(reference) ?? ([...state.tags.values()].includes(reference) ? reference : undefined);
        if (!id) fail();
        const format = a[a.indexOf('--format') + 1];
        if (!a.includes('--format')) return '[]';
        if (format === '{{.Id}}') return id;
        if (format.includes('compose.project')) return state.projectLabel ?? 'thesis-ledger-dev';
        if (format.includes('compose.service')) return state.serviceLabel ?? (id === fullId(1) ? 'dsa' : 'thesis-ledger');
        if (format.includes('data-runtime')) return state.profile ?? 'dsa-data-runtime-v1';
        if (format.includes('contract')) return '1';
        if (format.includes('WorkingDir')) return state.directory ?? '/app';
        if (format.includes('Config.User')) return state.user ?? 'thesis';
        if (format.includes('Config.Cmd')) return state.command ?? '["node","apps/server/dist/src/main.js"]';
      }
    }
    if (a[0] === 'pull') { if (state.pullFailure === a[1]) fail(); state.tags.set(a[1], fullId(99)); return ''; }
    if (a[0] === 'tag') { state.tags.set(a[2], state.tags.get(a[1])); return ''; }
    if (a[0] === 'run') return df(state.dockerAvailable);
    if (a[0] === 'volume') {
      if (a[1] === 'ls') return [...state.volumes.keys()].join('\n');
      if (a[1] === 'create') { state.volumes.set(a.at(-1), 'true'); return a.at(-1); }
      if (!state.volumes.has(a.at(-1))) fail();
      return a.includes('--format') ? state.volumes.get(a.at(-1)) : '[]';
    }
    if (a[0] === 'ps') return state.containerList;
    if (a[0] === 'inspect') {
      const format = a[a.indexOf('--format') + 1], service = Object.entries(state.ids).find(([, id]) => id === a.at(-1))?.[0];
      if (format.includes('State.Status')) return state.exited || state.pgExited && service === 'postgres' ? 'exited' : 'running';
      if (format.includes('State.Health')) return state.noHealth ? 'none' : 'healthy';
      if (format === '{{.Image}}') return service === 'dsa' ? fullId(1) : fullId(2);
      if (format.includes('Config.Image')) return service === 'dsa' ? 'daily-stock-analysis:thesisledger-dev' : 'thesis-ledger:dev';
    }
    if (a[0] === 'exec') { if (state.applyFailure && a.includes('sh')) fail(17); return ''; }
    if (a[0] === 'cp' || a[0] === 'logs') return '';
    if (a[0] === 'buildx') {
      if (a.includes('history')) return state.activeBuilder ? 'Running' : 'Completed';
      if (a[1] === 'inspect') return `Driver: ${state.driver ?? 'docker'}\nEndpoint: local`;
      if (a[1] === 'prune') { if (state.cacheFailure) fail(); return ''; }
      if (a[1] === 'bake') {
        const service = a.at(-1); state.builds.push(service);
        if (state.buildFailure) {
          const text = state.buildFailure(state.builds.length, service);
          if (text) { commandOptions.onOutput?.(text, 'stderr'); fail(1, text); }
        }
        return '';
      }
    }
    if (a[0] === 'compose') {
      let index = 1;
      while (['--env-file', '-f'].includes(a[index])) index += 2;
      const [command, ...rest] = a.slice(index);
      if (command === 'config') return JSON.stringify(state.config);
      if (command === 'ps') return state.ids[rest.at(-1)] ?? '';
      if (command === 'build') return '{}';
      if (command === 'run') { if (state.sqlGenerationFailure) fail(); return 'SELECT 1;'; }
      if (command === 'exec') { if (state.sqlFailure) fail(); return ''; }
      if (command === 'stop' && state.stopFailure) fail();
      if (command === 'up') { if (state.startFailure) fail(); state.exited = false; }
      if (command === 'restart') state.exited = state.healthFailure ?? false;
      return '';
    }
    throw new Error(`未声明 Docker 操作: ${a.join(' ')}`);
  };
  const runtime = new LocalDocker({ root, env: { TMPDIR: temporary, BUILD_SPACE_HOST_PATH: root,
    DSA_SOURCE_DIR: join(temporary, 'daily-stock-analysis'), THESIS_LEDGER_SOURCE_DIR: join(temporary, 'thesis-ledger'),
    HEALTH_TIMEOUT_SECONDS: '1', ...options.env }, run, log: message => state.messages.push(message), sleep: async () => {} });
  return { runtime, state, temporary, root };
}
