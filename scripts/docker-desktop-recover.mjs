import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRun = (command, args, timeout) => spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
const defaultFreeBytes = () => {
  const stats = statfsSync(homedir(), { bigint: true });
  return Number(stats.bavail * stats.bsize);
};

function forceStopAndStart(docker, availableBytes, steps) {
  const stop = docker(['desktop', 'stop', '--force', '--timeout', '45'], 55000);
  if (stop.status !== 0) return { availableBytes, action: '强制停止失败，停止后续操作', engineReady: false, restarted: false, forcedStop: false, steps };
  const start = docker(['desktop', 'start', '--timeout', '45'], 55000);
  if (start.status !== 0) return { availableBytes, action: '强制停止后启动失败，停止后续操作', engineReady: false, restarted: false, forcedStop: true, steps };
  const after = docker(['info', '--format', '{{.ServerVersion}}'], 8000);
  return { availableBytes, action: '已执行显式强制停止及一次启动', engineReady: after.status === 0, restarted: true, forcedStop: true, steps };
}

export function recoverDockerDesktop({ execute = false, forceStop = false, run = defaultRun, freeBytes = defaultFreeBytes } = {}) {
  const availableBytes = freeBytes();
  if (!Number.isFinite(availableBytes) || availableBytes <= 0) throw new Error('磁盘余量未知或为零，停止恢复');
  const processes = run('/bin/ps', ['-axo', 'pid,args'], 8000);
  if (processes.status !== 0) throw new Error('无法核对活动更新进程，停止恢复');
  const activeUpdates = processes.stdout.split('\n').filter(line => /(?:^|[\s/])(?:update|sync-code)\.sh(?:\s|$)/.test(line));
  if (activeUpdates.length) throw new Error('存在活动更新进程，停止引擎恢复');
  const steps = [];
  function docker(args, timeout) {
    const result = run('docker', args, timeout);
    steps.push({ args, code: result.status, error: result.error?.message, stderr: result.stderr?.trim() });
    return result;
  }
  const before = docker(['info', '--format', '{{.ServerVersion}}'], 8000);
  if (before.status === 0) return { availableBytes, action: '无需恢复', engineReady: true, restarted: false, steps };
  if (!execute) return { availableBytes, action: forceStop ? '待显式执行强制停止及一次启动' : '待确认执行一次 Docker Desktop 引擎重启', engineReady: false, restarted: false, steps };
  if (forceStop) return forceStopAndStart(docker, availableBytes, steps);
  const restart = docker(['desktop', 'restart', '--timeout', '45'], 55000);
  if (restart.status !== 0) return { availableBytes, action: '引擎重启失败，不再重试', engineReady: false, restarted: false, steps };
  const after = docker(['info', '--format', '{{.ServerVersion}}'], 8000);
  return { availableBytes, action: '已执行一次引擎重启', engineReady: after.status === 0, restarted: true, steps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--execute', '--force-stop'].includes(arg))) throw new Error('用法：node scripts/docker-desktop-recover.mjs [--execute] [--force-stop]');
  const result = recoverDockerDesktop({ execute: args.includes('--execute'), forceStop: args.includes('--force-stop') });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  if (args.includes('--execute') && !result.engineReady) process.exitCode = 1;
}
