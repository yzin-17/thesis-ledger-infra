import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 部署脚本仅引用本仓实现或 Node 内置模块；应用能力通过维护命令调用。
export function checkInfraDependencies(root) {
  const violations = [];
  const policy = JSON.parse(readFileSync(new URL('./deployment-ownership.json', import.meta.url), 'utf8'));
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'fixtures' || entry.name === '__pycache__') continue;
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(mjs|sh|py|sql)$/.test(entry.name) && !entry.name.includes('.test.')) files.push(file);
    }
  }
  visit(resolve(root, 'scripts'));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const marker of policy.applicationImplementationMarkers) {
      if (source.includes(marker)) violations.push(`${relative(root, file)} 含应用内部实现标识: ${marker}`);
    }
    if (!file.endsWith('.mjs')) continue;
    const imports = [
      ...source.matchAll(/^(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g),
    ];
    for (const [, specifier] of imports) {
      if (specifier.startsWith('node:')) continue;
      const target = resolve(dirname(file), specifier);
      if (specifier.startsWith('.') && (target === root || target.startsWith(root + sep))) continue;
      violations.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkInfraDependencies(root);
  if (violations.length) {
    console.error('部署脚本依赖越界：\n' + violations.join('\n'));
    process.exitCode = 1;
  } else console.log('部署脚本依赖边界通过');
}
