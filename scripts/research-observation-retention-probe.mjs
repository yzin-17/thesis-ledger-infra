import assert from 'node:assert/strict';

/** 只操作固定隔离库中的受控报告，不读取或请求任何外部资料。 */
export async function seedObservationVersions(runtime, runId) {
  const { assert: check, randomUUID, PrismaClient, Store, fingerprint, method } = runtime;
  const client = new PrismaClient({ datasourceUrl: 'postgresql://restore_owner@127.0.0.1:5432/restore_db' });
  try {
    const [database] = await client.$queryRawUnsafe('SELECT current_database() AS name, current_user AS owner');
    check.deepEqual(database, { name: 'restore_db', owner: 'restore_owner' });
    check(/^75000000-0000-4000-8000-\d{12}$/.test(runId));
    const run = await client.aiRun.findUniqueOrThrow({ where: { id: runId } });
    check.equal(run.modelMetadata.acceptanceFixture, 'controlled-saved-report-v1');
    check.equal(run.result.version, 2);
    const claim = run.result.inference.claims.find(item => item.kind === 'price-direction');
    check(claim && run.researchOwnerId);
    const store = new Store(client);
    const start = { ownerId: run.researchOwnerId, runId, lineageId: runId,
      artifactFingerprint: fingerprint(run.result), claimId: claim.id,
      windowTradingDays: claim.tradingDays, methodVersion: method };
    const evaluation = { status: 'insufficient_data', reasons: ['calendar_unqualified'],
      window: { tradingDays: claim.tradingDays, startSession: null, endSession: null,
        startCloseAt: null, endCloseAt: null },
      economic: { basis: 'economic-close', currency: null, startPrice: null, endPrice: null,
        returnRate: null, directionMatched: null } };
    const versions = [];
    for (const [index, visibleAt] of ['2026-10-18T09:00:00.000Z', '2026-10-19T09:00:00.000Z',
      '2026-10-18T10:00:00.000Z'].entries()) {
      const input = { ...start, visibleAt, submissionId: randomUUID() };
      check((await store.begin(input)).acquired);
      const saved = await store.finish(input.ownerId, input.submissionId,
        { visibleAt, calendar: { status: 'unavailable', revision: `controlled-retention-${index}` },
          prices: { status: 'unavailable' } }, evaluation);
      check(saved.version && saved.state === 'succeeded'); versions.push(saved);
    }
    const observationId = versions[0].observationId;
    const history = await store.history(start.ownerId, runId, observationId);
    check.equal(history.versions.length, 3);
    return { runId, observationId, firstVersionId: versions[0].version.id,
      currentVersionId: versions[1].version.id, versionCount: 3,
      firstCutoff: '2026-10-18T09:00:00.000Z', currentCutoff: '2026-10-19T09:00:00.000Z',
      realModelRequests: 0, qualifiedSource: false };
  } finally { await client.$disconnect(); }
}

export function observationSeedProgram(fixtures) {
  assert.equal(fixtures.format, 'research-dual-read-fixtures-v1');
  const runId = fixtures.cases.shadow.id;
  assert(/^75000000-0000-4000-8000-\d{12}$/.test(runId));
  return `const {createRequire}=require('node:module');
const appRequire=createRequire('/app/package.json');
const {PrismaClient}=appRequire('@prisma/client');
const {ResearchObservationStore:Store}=appRequire('/app/apps/server/dist/src/research/research-observation.store.js');
const {researchObservationDigest:fingerprint}=appRequire('/app/apps/server/dist/src/research/research-observation-identity.js');
const {RESEARCH_OBSERVATION_METHOD:method}=appRequire('@thesis-ledger/schemas');
const runtime={assert:require('node:assert/strict'),randomUUID:require('node:crypto').randomUUID,PrismaClient,Store,fingerprint,method};
(${seedObservationVersions.toString()})(runtime,${JSON.stringify(runId)})
.then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});`;
}
