import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeishuHookSource } from '../../thesis-ledger/scripts/cash-notification-mock.contract.mjs';
import { redactNotificationDiagnostic } from './mobile-notification-acceptance.runtime.mjs';

const container = 'thesis-ledger-dev-thesis-ledger-1';
const platforms = ['android', 'ios'];
const sha = value => createHash('sha256').update(value).digest('hex');

export function parseMobileNotificationArgs(args) {
  const options = { phase: 'plan', execute: false };
  const seen = new Set();
  for (const arg of args) {
    if (arg === '--execute') {
      assert(!seen.has('execute'), '验收参数不得重复');
      seen.add('execute');
      options.execute = true;
    }
    else {
      const match = /^--(phase|platform|output)=(.+)$/u.exec(arg);
      assert(match, '不支持的手机通知验收参数');
      assert(!seen.has(match[1]), '验收参数不得重复');
      seen.add(match[1]);
      options[match[1]] = match[2];
    }
  }
  assert(['plan', 'prepare', 'deliver', 'inspect', 'cleanup'].includes(options.phase), '不支持该验收阶段');
  assert(!(options.phase === 'plan' && options.execute), '计划阶段不得执行状态变更');
  assert(options.output && isAbsolute(options.output), '必须指定绝对输出目录');
  if (options.phase === 'deliver') assert(platforms.includes(options.platform), '必须指定 Android 或 iOS 平台');
  else assert(!options.platform, '本阶段不接受平台参数');
  return options;
}

export function reserveMobileNotification(state, platform) {
  assert(platforms.includes(platform), '平台不匹配');
  const occupied = state.attempts.filter(row => row.status !== 'not-dispatched');
  assert(!occupied.some(row => row.platform === platform), '本平台许可已使用或结果未知，不得重发');
  assert(occupied.length < 2, '两次外部发送许可已占用');
  const row = { id: randomUUID(), platform, status: 'reserved', reservedAt: new Date().toISOString(), outboundCount: null };
  state.attempts.push(row);
  return row;
}

function docker(args, options = {}) {
  return spawnSync('docker', ['--context', 'desktop-linux', ...args], {
    encoding: 'utf8', timeout: 45_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
}
function targetIdentity() {
  const result = docker(['inspect', container]);
  assert.equal(result.status, 0, '无法读取验收目标');
  const [info] = JSON.parse(result.stdout);
  assert.equal(info.Config.Labels['com.docker.compose.project'], 'thesis-ledger-dev');
  assert.equal(info.Config.Labels['com.docker.compose.service'], 'thesis-ledger');
  assert.equal(info.State.Status, 'running', '验收目标没有运行');
  assert.equal(info.State.Health?.Status, 'healthy', '验收目标不健康');
  return { id: info.Id, image: info.Image };
}
function invokeRuntime(source, payload) {
  const result = docker(['exec', '-i', '-e', 'MOBILE_NOTIFY_ACCEPTANCE_RUNNER=1', container,
    'node', '--input-type=module', '--eval', source], { input: JSON.stringify(payload) });
  const line = result.stdout?.split('\n').findLast(value => value.startsWith('MOBILE_NOTIFICATION_RESULT '));
  if (!line) return { ok: false, outcomeUnknown: true, exitCode: result.status,
    error: '运行器未返回完整回执；保留已占用许可，不自动重发' };
  return { ...JSON.parse(line.slice('MOBILE_NOTIFICATION_RESULT '.length)), exitCode: result.status };
}
function saveState(file, state) {
  const temporary = file + '.' + randomUUID();
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

export function compareNotificationProtection(before, after) {
  const differences = {};
  for (const [table, original] of Object.entries(before)) {
    const remaining = new Map();
    for (const hash of after[table]?.rows ?? []) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
    let missing = 0;
    for (const hash of original.rows) {
      const available = remaining.get(hash) ?? 0;
      if (!available) missing += 1;
      else remaining.set(hash, available - 1);
    }
    differences[table] = { originalRows: original.count, retainedRows: original.count - missing,
      changedOrMissing: missing, addedRows: (after[table]?.count ?? 0) - original.count };
  }
  return { passed: Object.values(differences).every(row => row.changedOrMissing === 0), tables: differences };
}

export async function runMobileNotificationAcceptance(options) {
  const output = resolve(options.output);
  if (!options.execute && options.phase !== 'inspect') {
    return { phase: options.phase, execute: false, platforms, maxOutboundRequests: 2,
      maxRequestsPerPlatform: 1, productionNotificationRoutingEnabled: false, output };
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const lockFile = resolve(output, 'notification-operation.lock');
  const lock = openSync(lockFile, 'wx', 0o600);
  try {
    const file = resolve(output, 'notification-state.json');
    const source = readFileSync(new URL('./mobile-notification-acceptance.runtime.mjs', import.meta.url), 'utf8');
    let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (options.phase === 'prepare') {
      assert(!state?.prepared, '验收已准备，不能覆盖原预算台账');
      const credential = parseFeishuHookSource(readFileSync(resolve(homedir(), '.zshrc'), 'utf8'));
      if (!state) {
        const runId = randomUUID();
        state = { version: 1, runId, credentialSource: '~/.zshrc:FEISHU_HOOK',
          credentialSha256: sha(credential), runtimeSha256: sha(source), target: targetIdentity(), attempts: [],
          plans: Object.fromEntries(platforms.map(platform => [platform, {
            provider: `mobile-notify-${platform}-${runId.slice(0, 8)}`, deliveryId: randomUUID(),
          }])) };
        const baseline = invokeRuntime(source, { ...state, phase: 'snapshot' });
        assert(baseline.ok, baseline.error ?? '保护基线读取失败');
        state.baseline = baseline.protectedTables;
        saveState(file, state);
      }
      assert.equal(sha(credential), state.credentialSha256, '所选接收目标发生变化');
      const prepared = invokeRuntime(source, { ...state, phase: 'prepare', credential });
      writeFileSync(resolve(output, 'notification-prepare.json'), JSON.stringify(prepared, null, 2) + '\n');
      assert(prepared.ok, prepared.error ?? '验收配置准备失败');
      state.prepared = true;
      saveState(file, state);
      return { prepared: true, runId: state.runId, plans: state.plans, maxOutboundRequests: 2 };
    }
    assert(state?.prepared, '必须先完成独立验收配置准备');
    assert.equal(sha(source), state.runtimeSha256, '运行器输入变化，必须先复核已占用预算与协议');
    assert.deepEqual(targetIdentity(), state.target, '目标容器或镜像已变化');
    if (options.phase === 'deliver') {
      const attempt = reserveMobileNotification(state, options.platform);
      saveState(file, state);
      const result = invokeRuntime(source, { ...state, phase: 'deliver', platform: options.platform });
      let status = 'failed-or-unknown';
      if (result.outboundCount === 0) {
        status = 'not-dispatched';
      } else if (result.accepted) {
        status = 'accepted';
      }
      Object.assign(attempt, { completedAt: new Date().toISOString(), outboundCount: result.outboundCount ?? null,
        status });
      saveState(file, state);
      writeFileSync(resolve(output, `notification-${options.platform}-${attempt.id}.json`), JSON.stringify(result, null, 2) + '\n');
      assert(result.ok && result.accepted, result.error ?? '本次未满足真实供应商及持久回执要求，停止本平台发送');
      return result;
    }
    const result = invokeRuntime(source, { ...state, phase: options.phase });
    assert(result.ok, result.error ?? '验收检查失败');
    result.protection = compareNotificationProtection(state.baseline, result.protectedTables);
    writeFileSync(resolve(output, `notification-${options.phase}.json`), JSON.stringify(result, null, 2) + '\n');
    assert(result.protection.passed, '原业务记录变化，保留当前事实，不回写原数据');
    if (options.phase === 'cleanup') {
      assert.equal(result.remaining.length, 0, '临时验收配置清理未完成');
      state.cleaned = true;
      saveState(file, state);
    }
    return { phase: options.phase, deliveries: result.deliveries.map(row => ({
      id: row.id, status: row.status, attemptCount: row.attemptCount, subjectId: row.subjectId,
    })), remaining: result.remaining, protectionPassed: result.protection.passed };
  } finally {
    closeSync(lock);
    unlinkSync(lockFile);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMobileNotificationAcceptance(parseMobileNotificationArgs(process.argv.slice(2)));
    console.log(redactNotificationDiagnostic(result));
  } catch (error) {
    console.error(redactNotificationDiagnostic({ error: error.message }));
    process.exitCode = 1;
  }
}
