import { join } from 'node:path';
import { createSyncRunner } from './runtime/process.mjs';

export function runApplicationCommand(application, args, options = {}) {
  return createSyncRunner()('bash', [join(application, 'scripts/local-deployment.sh'), ...args], {
    encoding: null, timeout: 0, maxBuffer: 128 * 1024 * 1024, ...options,
  });
}

export function callApplicationContract(application, operation, ...args) {
  try {
    return JSON.parse(createSyncRunner()(process.execPath,
      [join(application, 'scripts/deployment/runtime-contract.mjs'), operation], {
        input: JSON.stringify(args), encoding: 'utf8', timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      }));
  } catch (error) {
    throw new Error(`应用运行合同校验失败：${error.stderr?.toString().trim() || '命令或响应无效'}`);
  }
}
