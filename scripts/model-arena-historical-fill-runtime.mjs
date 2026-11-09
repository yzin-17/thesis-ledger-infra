// 只由维护入口装载；check 只读，rehearse 全事务回滚，apply 仅写独立回放比赛。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrismaService } from './dist/src/platform/prisma.service.js';
import { arenaBookSchema, arenaMarkSchema, arenaProtocolSchema, marketInstrumentFactSchema } from '@thesis-ledger/schemas';
import { checkArenaDecision } from './dist/src/model-arena/arena-decision-rules.js';
import { executeAtArenaOpen } from './dist/src/model-arena/arena-open-execution.js';
import { ArenaRoundReports } from './dist/src/model-arena/arena-round-report.js';
const [mode, raw, confirmedPlan] = process.argv.slice(2);
assert(['check', 'rehearse', 'apply', 'repair-report'].includes(mode));
const input = JSON.parse(raw), { receipt, reserved, opening: o, hashes } = input;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idFor = value => {
  const h = hash(value);
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
};
const db = new PrismaService();
const rolledBack = new Error('已验证回滚');
let report;
try {
  const source = await db.modelArena.findUniqueOrThrow({ where: { id: receipt.plan.arenaId }, include: { rounds: true, entrants: true } });
  const originalProtocol = arenaProtocolSchema.parse(source.protocol), packet = reserved.packet;
  assert.deepEqual(receipt.plan, reserved.plan);
  assert.equal(packet.arenaId, source.id);
  assert.equal(source.rounds.length, 0, '原回放已进入其他执行流程，停止');
  assert(['draft', 'paused'].includes(source.state));
  const facts = marketInstrumentFactSchema.array().parse(packet.facts);
  const decisionDay = validateReplayTime(packet, facts, originalProtocol.timeZone);
  assert.equal(decisionDay, '2026-11-06', '维护入口仅覆盖已授权的冻结决策日');
  assert.equal(o.symbol, '600036.SH', '维护入口仅覆盖招商银行');
  assert.equal(o.tradingDate, '2026-11-09', '维护入口仅覆盖已核实的历史开盘');
  assert.equal(receipt.plan.asOf, packet.asOf);
  assert(source.entrants.every(e => e.cash.toFixed() === originalProtocol.initialCash), '原始回放必须仍为空仓初始现金');
  assert.equal(facts.find(f => f.kind === 'daily_bar' && f.date === decisionDay)?.close, o.previousClose, '前收盘与原封存日线不符');
  assert.equal(originalProtocol.instruments.length, 1);
  assert.equal(originalProtocol.instruments[0].symbol, o.symbol);
  assert.equal(o.version, 'historical-opening-reconstruction-v1');
  assert.equal(o.purpose, 'initial-cash-buy-only-replay');
  assert.equal(o.modelCalls, 0);
  assert.equal(o.feeModel, 'original-arena-fixed-v1');
  assert.equal(input.historicalQuote.sessionContext.marketSession.latestCompletedTradingDate, decisionDay);
  assert.equal(o.tradingDate, new Intl.DateTimeFormat('en-CA', { timeZone: originalProtocol.timeZone }).format(new Date(o.openAt)));
  assert(Date.parse(packet.asOf) < Date.parse(o.openAt) && Date.parse(o.openAt) < Date.parse(o.sourceAvailableAt)
    && Date.parse(o.sourceAvailableAt) <= Date.parse(o.qualifiedAt) && Date.parse(o.qualifiedAt) <= Date.now());
  assert.equal(receipt.results.length, originalProtocol.entrants.length);
  const key = { ...hashes, version: 'arena-historical-fill-v1' };
  const arenaId = idFor(key), roundId = idFor([key, 'round']);
  assert.notEqual(arenaId, source.id);
  const zero = { requests: 0, tokens: 0, costMicros: 0 };
  const p = arenaProtocolSchema.parse({ ...originalProtocol, title: '招商银行 · 历史成交回放（复用11月6日决策）',
    startsOn: decisionDay, endsOn: decisionDay, budget: zero,
    entrants: originalProtocol.entrants.map(e => ({ ...e, budget: zero })) });
  const book = arenaBookSchema.parse({ asOf: packet.asOf, cash: p.initialCash, nav: p.initialCash, positions: [] });
  const openingFact = { symbol: o.symbol, openAt: o.openAt, price: o.price, lot: o.lot, tick: o.tick,
    upperLimit: o.upperLimit, lowerLimit: o.lowerLimit, sourceRef: hashes.opening,
    sellable: '0', buyBlocked: null, sellBlocked: 'historical_initial_buy_only' };
  const rows = p.entrants.map(e => {
    const matches = receipt.results.filter(r => r.providerId === e.providerId && r.model === e.model);
    assert.equal(matches.length, 1);
    const r = matches[0];
    assert.equal(r.status, 'valid'); assert.equal(r.modelIdentity.accepted, true);
    const decision = checkArenaDecision(r.decision, p, book, facts);
    assert(decision.actions.every(a => a.action === 'observe' || (a.action === 'target' && a.weightBps > 0)));
    const result = executeAtArenaOpen(p, book, decision, o.openAt, [openingFact]);
    assert(result.fills.every(f => f.side === 'buy'));
    return { entrantId: idFor([key, e.providerId, e.model]), reservationId: idFor([key, 'reservation', e.providerId, e.model]),
      providerId: e.providerId, model: e.model, receipt: r, decision, result };
  });
  const plan = { version: key.version, sourceArenaId: source.id, arenaId, roundId, protocol: p, hashes,
    decisionAt: packet.asOf, executionAt: o.openAt, evidenceQualifiedAt: o.qualifiedAt,
    rows: rows.map(r => ({ model: r.model, providerId: r.providerId, fills: r.result.fills, cash: r.result.cash, reasons: r.result.reasons })),
    additionalModelCalls: 0 };
  const planSha = hash(plan);
  const closeMarks = arenaMarkSchema.array().parse(rows.map(r => ({ entrantId: r.entrantId, book, reason: null })));
  report = { planSha, ...plan };
  if (mode !== 'check') {
    assert.equal(confirmedPlan, planSha, '必须确认同一份已核查计划的摘要');
    await db.$transaction(async tx => {
      const counts = async () => ({ trades: await tx.trade.count(), positions: await tx.position.count(), ledgerEvents: await tx.ledgerEvent.count() });
      const protectedBefore = await counts();
      const existing = await tx.modelArena.findUnique({ where: { id: arenaId } });
      if (existing) {
        assert.deepEqual(existing.protocol, p);
        const saved = await tx.arenaRound.findUniqueOrThrow({ where: { id: roundId }, include: { packet: true, reservations: { include: { fills: true } } } });
        assert.equal(saved.openingFacts.replayPlanSha, planSha);
        assert.equal(saved.reservations.length, rows.length);
        for (const r of rows) {
          const actual = saved.reservations.find(a => a.id === r.reservationId);
          assert(actual && actual.execution.cash === r.result.cash);
          assert.deepEqual(actual.fills.map(f => [f.symbol, f.side, f.quantity.toFixed(), f.price.toFixed(), f.fee.toFixed()]),
            r.result.fills.map(f => [f.symbol, f.side, f.quantity, f.price, f.fee]));
        }
        if (mode === 'repair-report') {
          assert.equal(saved.packet.promptVersion, 'historical-original-decisions-v1');
          assert.deepEqual(saved.packet.closeMarks, [{ symbol: o.symbol, price: o.previousClose }], '仅修复本入口首次发布的已知字段格式错误');
          await tx.arenaResearchPacket.update({ where: { roundId }, data: { closeMarks } });
          report.repairedReport = true;
        } else assert.deepEqual(saved.packet.closeMarks, closeMarks);
        report.alreadyImported = true;
      } else {
        assert.notEqual(mode, 'repair-report', '只允许修复已存在的精确目标');
        const now = new Date();
        await tx.modelArena.create({ data: { id: arenaId, ownerId: source.ownerId, state: 'ended', protocol: p,
          remaining: zero, startedAt: now, endedAt: now } });
        await tx.arenaRound.create({ data: { id: roundId, arenaId, tradingDate: decisionDay, outcome: { state: 'sealed' },
          openingFacts: { facts: [openingFact], missing: {}, replayPlanSha: planSha, historicalReconstruction: o, sourceArenaId: source.id },
          packet: { create: { asOf: new Date(packet.asOf), fingerprint: receipt.plan.fingerprint,
            promptVersion: 'historical-original-decisions-v1', facts, closeMarks } } } });
        for (const r of rows) {
          await tx.arenaEntrant.create({ data: { id: r.entrantId, arenaId, providerId: r.providerId, model: r.model, cash: r.result.cash, remaining: zero } });
          await tx.arenaReservation.create({ data: { id: r.reservationId, arenaId, roundId, entrantId: r.entrantId,
            amount: zero, privateBook: book, decisionState: r.result.fills.length ? 'decision' : 'observe', decision: r.decision,
            requestId: r.receipt.requestId, requestAudit: { ...r.receipt, reusedHistoricalReceipt: true, additionalModelCalls: 0, sourceReceiptSha256: hashes.receipt },
            settledAt: now, executionAt: now, execution: { version: 1, openAt: o.openAt, facts: [openingFact], cash: r.result.cash,
              reasons: r.result.reasons, historicalReconstruction: true, replayPlanSha: planSha },
            fills: { create: r.result.fills.map(f => ({ ...f, executedAt: new Date(o.openAt) })) } } });
        }
      }
      const originalAfter = await tx.modelArena.findUniqueOrThrow({ where: { id: source.id }, include: { rounds: true, entrants: true } });
      assert.deepEqual(originalAfter, source, '原比赛必须保持不变');
      assert.deepEqual(await counts(), protectedBefore, '真实与影子账本计数必须保持不变');
      const reports = new ArenaRoundReports(tx);
      const actualReport = await reports.read(source.ownerId, arenaId, roundId);
      assert.equal(actualReport.entries.flatMap(e => e.fills).length, rows.flatMap(r => r.result.fills).length);
      report.reportContractVerified = true;
      report.protectedCounts = protectedBefore;
      if (mode === 'rehearse') throw rolledBack;
    }, { isolationLevel: 'Serializable', timeout: 15000 });
  }
} catch (error) {
  if (error !== rolledBack) throw error;
  report.rehearsalRolledBack = true;
  assert.equal(await db.modelArena.count({ where: { id: report.arenaId } }), 0);
} finally { await db.$disconnect(); }
console.log(JSON.stringify(report));
