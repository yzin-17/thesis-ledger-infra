import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shell 入口保持兼容，实际职责由同目录的 Node 模块承担。
export function checkRuntime(root) {
  const violations = [];
  const scripts = join(root, 'scripts');
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['fixtures', '__pycache__'].includes(entry.name)) continue;
      const path = join(directory, entry.name), label = relative(root, path);
      if (entry.isDirectory()) { visit(path); continue; }
      if (entry.name.endsWith('.py')) violations.push(`${label} 引入 Python 实现`);
      if (!entry.name.endsWith('.sh')) continue;
      if (entry.name.endsWith('.test.sh')) { violations.push(`${label} 的测试应由 Vitest 直接运行`); continue; }
      const source = readFileSync(path, 'utf8');
      const match = /^#!\/bin\/sh\nexec node "\$\(dirname "\$0"\)\/([a-z0-9.-]+\.mjs)"(?: [a-z0-9-]+)? "\$@"\n$/.exec(source);
      if (!match || !existsSync(join(directory, match[1]))) violations.push(`${label} 必须只转发到现有 Node 入口`);
    }
  }
  visit(scripts);
  return violations;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Node 运行时及 Shell 入口门禁通过');
}
