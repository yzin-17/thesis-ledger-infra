import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'compatibility.json'), 'utf8'));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(manifest.schemaVersion === 1, 'thesis-ledger-infra-compatibility-manifest-v1 is required');
assert(manifest.thesisLedger?.version === '0.1.0', 'Unexpected ThesisLedger baseline');
assert(manifest.dsa?.dataContract === 'dsa-data-v1', 'Expected dsa-data-v1');
assert(manifest.dsa?.controlContract === 'dsa-control-v1', 'Expected dsa-control-v1');
assert(manifest.dsa?.runtimeProfile === 'dsa-data-runtime-v1', 'DSA runtime profile must be dsa-data-runtime-v1');
assert(manifest.marketV3 === undefined, 'Legacy parallel Market contract is not supported');
assert(manifest.release?.requireContractSmoke === true, 'Release requires contract smoke');
assert(manifest.release?.requireProtocolSmoke === true, 'Release requires protocol smoke');
assert(manifest.release?.requireBusinessSmoke === true, 'Release requires business smoke');
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
      dataContract: manifest.dsa.dataContract,
      controlContract: manifest.dsa.controlContract,
      runtimeProfile: manifest.dsa.runtimeProfile,
      releaseRequirements: manifest.release,
    },
    null,
    2,
  ),
);
