import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkInfraDependencies } from './check-boundaries.mjs';

test('部署实现允许本仓依赖，拒绝直接加载应用实现或外部包', () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-dependencies-'));
  try {
    mkdirSync(join(root, 'scripts'));
    const file = join(root, 'scripts', 'entry.mjs');
    writeFileSync(file, "import fs from 'node:fs';\nexport { run } from './owned.mjs';\n");
    assert.deepEqual(checkInfraDependencies(root), []);
    writeFileSync(file, "import { PrismaService } from '../../app/dist/prisma.js';\nimport pkg from 'application-internal';\n");
    assert.equal(checkInfraDependencies(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Shell、Python、SQL 与子目录也禁止承载应用实现细节', () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-ownership-'));
  try {
    mkdirSync(join(root, 'scripts/nested'), { recursive: true });
    writeFileSync(join(root, 'scripts/nested/entry.sh'), 'echo data_provider');
    writeFileSync(join(root, 'scripts/cleanup.py'), 'root = "sdk-source"');
    writeFileSync(join(root, 'scripts/permissions.sql'), 'REVOKE UPDATE ON LedgerEvent FROM app;');
    assert.equal(checkInfraDependencies(root).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('部署实现拒绝持有应用 SQLite 和研究演练程序', () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-restoration-ownership-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/restore.mjs'), "const name='stock_analysis.db'; const label='io.thesisledger.f01'; export const archiveProgram='application code';\n");
    assert.equal(checkInfraDependencies(root).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
