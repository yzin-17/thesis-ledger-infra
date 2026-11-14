import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const infraRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
export const imageReferences = { dsa: 'daily-stock-analysis:thesisledger-dev', 'thesis-ledger': 'thesis-ledger:dev' };
const baseImages = {
  dsa: [['rust:1.94.1-slim-bookworm', 'thesis-ledger-local-rust:1.94.1-slim-bookworm'],
    ['python:3.11-slim-bookworm', 'thesis-ledger-local-python:3.11-slim-bookworm']],
  'thesis-ledger': [['node:24-alpine', 'thesis-ledger-local-node:24-alpine']],
};
export function selectTarget(target = 'all') {
  if (!['all', 'dsa', 'thesis-ledger'].includes(target)) throw new Error(`不支持的更新目标: ${target}`);
  return target === 'all' ? ['dsa', 'thesis-ledger'] : [target];
}
export const selectedImages = target => selectTarget(target).flatMap(service => baseImages[service]);
export const selectedServices = target => selectTarget(target).flatMap(service =>
  service === 'thesis-ledger' ? ['thesis-ledger', 'backtest-worker'] : [service]);
export function booleanOption(env, name, fallback = false) {
  const value = env[name] ?? String(fallback);
  if (['true', '1', 'yes'].includes(value)) return true;
  if (['false', '0', 'no'].includes(value)) return false;
  throw new Error(`${name} 必须是 true/false。`);
}
export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} 必须为 1～${maximum} 的整数。`);
  }
  return Number(value);
}
export function environmentFile(root, env) {
  const path = env.ENV_FILE ? resolve(root, env.ENV_FILE)
    : ['.env', '.env.example'].map(name => join(root, name)).find(existsSync);
  if (!path || !statSync(path).isFile()) throw new Error('环境文件不存在。');
  return path;
}
export function readConfiguration(env = process.env, extraProtected = []) {
  const protectedReferences = [...new Set([...(env.BUILD_PROTECTED_IMAGES ?? '').split(/\s+/).filter(Boolean), ...extraProtected])];
  if (protectedReferences.some(id => !imageIdPattern.test(id))) throw new Error('保护镜像必须为完整 SHA256 ID');
  return { protectedReferences };
}
