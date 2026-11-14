import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSyncRunner } from './process.mjs';

export function updateLockPath(checksum, env) {
  if (!/^\d+$/.test(checksum)) throw new Error('更新锁标识无效。');
  return join(env.TMPDIR || '/tmp', `thesis-ledger-update-${process.getuid()}-${checksum}.lock`);
}

export function ownsUpdateLock(path, parent = pid => createSyncRunner()('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 5000 }), expected) {
  try {
    const owner = readFileSync(join(path, 'pid'), 'utf8').trim();
    if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(Number(owner)) || expected !== undefined && owner !== expected) return false;
    let pid = process.ppid;
    const visited = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (String(pid) === owner) return true;
      if (pid <= 1 || visited.has(pid)) return false;
      visited.add(pid);
      const next = parent(pid).trim();
      if (!/^[1-9][0-9]*$/.test(next) || !Number.isSafeInteger(Number(next))) return false;
      pid = Number(next);
    }
  } catch { /* 未知祖先或读取失败均拒绝。 */ }
  return false;
}

export class UpdateLock {
  constructor(path) { this.path = path; this.owned = false; }
  acquire() {
    try { mkdirSync(this.path); } catch { throw new Error(`已有更新锁或目录不可用: ${this.path}`); }
    try { writeFileSync(join(this.path, 'pid'), `${process.pid}\n`, { flag: 'wx' }); }
    catch (error) { rmdirSync(this.path); throw error; }
    this.owned = true;
  }
  release() {
    if (!this.owned) return;
    if (readFileSync(join(this.path, 'pid'), 'utf8').trim() !== String(process.pid)) throw new Error('更新锁归属发生变化。');
    unlinkSync(join(this.path, 'pid')); rmdirSync(this.path); this.owned = false;
  }
  run(action) {
    let value;
    try { value = action(); } catch (error) { this.release(); throw error; }
    if (value && typeof value.then === 'function') return Promise.resolve(value).finally(() => this.release());
    this.release(); return value;
  }
}
