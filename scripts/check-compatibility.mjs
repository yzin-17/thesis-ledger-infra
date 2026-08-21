import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'compatibility.json'), 'utf8'));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(manifest.schemaVersion === 1, 'compatibility.json schemaVersion must be 1');
assert(manifest.thesisLedger?.version === '0.1.0', 'Unexpected ThesisLedger baseline');
assert(manifest.dsa?.dataContractVersion === 1, 'DSA Data Contract must remain V1');
assert(manifest.dsa?.controlContractVersion === 1, 'DSA Control Contract must remain V1');
assert(
  /^v\d+\.\d+\.\d+-thesisledger\.\d+$/u.test(manifest.dsa?.forkVersion ?? ''),
  'DSA forkVersion must use upstream-version + thesisledger revision',
);

try {
  const thesisLedgerPackage = JSON.parse(
    await readFile(resolve(root, '../thesis-ledger/package.json'), 'utf8'),
  );
  assert(
    thesisLedgerPackage.version === manifest.thesisLedger.version,
    `ThesisLedger version mismatch: matrix=${manifest.thesisLedger.version}, repo=${thesisLedgerPackage.version}`,
  );
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (manifest.release?.requireImmutableImageDigest) {
  for (const name of ['THESIS_LEDGER_IMAGE', 'DSA_IMAGE']) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    assert(
      /@sha256:[0-9a-f]{64}$/u.test(value),
      `${name} must reference an immutable sha256 digest`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      status: 'passed',
      thesisLedger: manifest.thesisLedger.version,
      dsaFork: manifest.dsa.forkVersion,
      dataContractVersion: manifest.dsa.dataContractVersion,
      controlContractVersion: manifest.dsa.controlContractVersion,
    },
    null,
    2,
  ),
);
