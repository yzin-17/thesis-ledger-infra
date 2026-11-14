import { spawn, spawnSync } from 'node:child_process';

export class CommandFailure extends Error {
  constructor(binary, code, stdout = '', stderr = '') {
    super(`${binary} 命令失败，退出码 ${code}`);
    this.code = code;
    Object.defineProperties(this, { stdout: { value: stdout }, stderr: { value: stderr } });
  }
}

// 同步用于短维护命令或显式文件流；输出编码由调用方声明，二进制不经字符串转换。
export function createSyncRunner({ env = process.env } = {}) {
  return (binary, args = [], options = {}) => {
    const { stream, ...settings } = options;
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      ...(stream ? { stdio: ['pipe', 'inherit', 'inherit'] } : {}), ...settings, env: { ...env, ...options.env } });
    if (result.status !== 0 || result.error) throw new CommandFailure(binary,
      result.error?.code === 'ENOENT' ? 127 : result.status || 1, result.stdout, result.stderr);
    return result.stdout ?? (options.encoding === null ? Buffer.alloc(0) : '');
  };
}

// 参数始终作为独立 argv 传递，不通过 Shell 拼接或求值。
export function createRunner({ env = process.env, signal } = {}) {
  return (binary, args = [], options = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CommandFailure(binary, 130)); return; }
    const grouped = process.platform !== 'win32';
    const child = spawn(binary, args, {
      cwd: options.cwd, env: { ...env, ...options.env }, detached: grouped,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: options.timeout ?? 0,
    });
    const terminate = () => {
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    };
    const abort = () => { failure = new CommandFailure(binary, 130); terminate(); };
    let stdout = '', stderr = '', size = 0, settled = false, failure;
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const collect = (kind, chunk) => {
      if (failure) return;
      size += Buffer.byteLength(chunk);
      if (!options.stream && size > (options.maxBuffer ?? 32 * 1024 * 1024)) {
        failure = new Error('命令输出超过受控上限');
        terminate();
        return;
      }
      const value = chunk;
      if (kind === 'stdout') stdout = options.stream ? (stdout + value).slice(-64_000) : stdout + value;
      else stderr = options.stream ? (stderr + value).slice(-64_000) : stderr + value;
      try {
        options.onOutput?.(value, kind);
        if (options.stream) (kind === 'stdout' ? process.stdout : process.stderr).write(chunk);
      } catch (error) { failure = error; terminate(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { failure = error; terminate(); } });
    child.on('error', error => {
      failure = new CommandFailure(binary, error.code === 'ENOENT' ? 127 : 1);
      if (!child.pid) finish(failure);
    });
    child.on('close', code => {
      if (failure) finish(failure);
      else if (code !== 0) finish(new CommandFailure(binary, code ?? 1, stdout, stderr));
      else finish(null, stdout);
    });
    child.stdin.end(options.input);
  });
}

export function runCli(main, args) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, abort);
  return main(args, { signal: controller.signal }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = controller.signal.aborted ? 130 : (Number.isInteger(error.code) && error.code > 0 && error.code < 256 ? error.code : 1);
  }).finally(() => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, abort);
  });
}
