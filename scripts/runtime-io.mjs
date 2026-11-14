import { createHash } from 'node:crypto';
import { LocalDocker } from './runtime/docker.mjs';

let runtime;
export function dockerRuntime() { return runtime ??= new LocalDocker().connectSync(); }

// 维护脚本共用的容器执行与字节摘要；业务校验由调用方负责。
export function docker(args, options = {}) {
  return dockerRuntime().dockerSync(args, { encoding: null, timeout: 0, maxBuffer: 128 * 1024 * 1024, ...options });
}

export const inspect = name => JSON.parse(docker(['inspect', name]).toString())[0];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
