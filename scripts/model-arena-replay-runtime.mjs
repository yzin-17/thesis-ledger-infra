// 由 model-arena-replay.mjs 在开发 Server 容器中调用。只读目标库。
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PrismaService } from "./dist/src/platform/prisma.service.js";
import { decryptProviderCredential } from "./dist/src/platform/credential-security.js";
import { createStoredAiProvider } from "./dist/src/ai/ai-provider-runtime.js";
import { routeSnapshotsFromProviderRow } from "./dist/src/ai/ai-provider-readiness.persistence.js";
import { parseAiProviderSettings } from "./dist/src/ai/ai-provider-summary.js";
import { AiProviderRegistry } from "./dist/src/ai/provider-registry.js";
import { prepareModelReceipt } from "./dist/src/ai/ai-model-receipt.js";
import { AiSdkGenerationAdapter } from "./dist/src/ai/ai-sdk-generation.adapter.js";
import { buildGenerationSchemaPrompt } from "./dist/src/ai/ai-generation-schema-prompt.js";
import {
  aiProviderTestSuccessFacts,
  aiProviderTestFailureFacts,
} from "./dist/src/ai/ai-provider-test-facts.js";
import { checkArenaDecision } from "./dist/src/model-arena/arena-decision-rules.js";
import {
  aiGenerationContracts,
  marketInstrumentFactSchema,
  arenaProtocolSchema,
} from "@thesis-ledger/schemas";
import { Prisma } from "@prisma/client";

const [mode, raw, reservedPlan] = process.argv.slice(2);
const packet = JSON.parse(raw);
const db = new PrismaService();
async function replay() {
  assert(["--check", "--run"].includes(mode));
  const arena = await db.modelArena.findUniqueOrThrow({
    where: { id: packet.arenaId },
    include: { entrants: true, rounds: true },
  });
  const p = arenaProtocolSchema.parse(arena.protocol);
  assert.equal(arena.rounds.length, 0);
  assert.deepEqual(arena.remaining, p.budget);
  assert.equal(p.startsOn, p.endsOn);
  assert.equal(p.entrants.length, 2);
  assert.equal(p.budgetCurrency, "USD");
  assert.equal(p.budget.requests, 2);
  assert(p.budget.tokens <= 40000 && p.budget.costMicros <= 2800);
  const facts = marketInstrumentFactSchema.array().min(1).parse(packet.facts);
  const day = validateReplayTime(packet, facts, p.timeZone);
  assert(facts.every((f) => p.instruments.some((i) => i.symbol === f.symbol)));
  if (arena.state === "draft") {
    assert(
      packet.closedSession && p.endsOn === day && p.instruments.length === 1,
    );
    assert.equal(packet.closedSession.symbol, p.instruments[0].symbol);
    assert.equal(
      await db.arenaOccurrence.count({ where: { arenaId: arena.id } }),
      0,
    );
  } else {
    assert.equal(arena.state, "paused");
  }
  const book = {
    asOf: packet.asOf,
    cash: p.initialCash,
    nav: p.initialCash,
    positions: [],
  };
  const contract = aiGenerationContracts.arenaDecision;
  let newsCoverage;
  if (packet.newsStatus !== undefined) {
    assert.equal(p.instruments.length, 1, "多标的输入不能复用单一新闻查询状态");
    assert(["available", "partial", "unavailable"].includes(packet.newsStatus));
    const itemCount = facts.filter((f) => f.kind === "news").length;
    assert(packet.newsStatus !== "unavailable" || itemCount === 0);
    newsCoverage = {
      symbol: p.instruments[0].symbol,
      status: packet.newsStatus,
      itemCount,
    };
  }
  const body = {
    asOf: packet.asOf,
    instruments: p.instruments,
    maxPositionBps: p.maxPositionBps,
    fees: p.fees,
    currency: p.currency,
    ownBook: book,
    ...(newsCoverage ? { newsCoverage } : {}),
    facts: facts.map((fact) => {
      if (packet.closedSession || fact.kind === "news") return fact;
      const { availableAt, ...historicalFact } = fact;
      return historicalFact;
    }),
  };
  const context = packet.closedSession
    ? "你在收盘后独立研究下一次开盘的模拟决策，只能使用截止时已经取得的行情与新闻。材料中含已结束交易日的完整日线。说明理由和失效条件，列出支持实际判断的材料 ref，结合新闻时保留其原始引用。"
    : "你在盘前回放中独立决策，只使用提供的既往行情和资讯。行情从当前历史库提取，未提供本日开盘或后续数据。";
  const messages = [
    {
      role: "system",
      content:
        context +
        "逐个标的给出动作、中文理由、证据引用和失效条件，只引用材料中的 ref。空仓用 observe 或 target，weightBps 为净值万分比，单标的不得超过 maxPositionBps。\n" +
        buildGenerationSchemaPrompt(contract.schema),
    },
    { role: "user", content: JSON.stringify(body) },
  ];
  const inputs = Buffer.byteLength(JSON.stringify(messages)) + 256;
  const registry = new AiProviderRegistry();
  const rows = await db.providerConfig.findMany({
    where: { name: { in: p.entrants.map((e) => e.providerId) } },
  });
  const providers = [],
    snapshots = [];
  for (const row of rows) {
    assert(row.enabled);
    const provider = await createStoredAiProvider(
      row,
      {
        readCredential: async (r) =>
          decryptProviderCredential(r.encryptedCredentials).credential,
      },
      180000,
    );
    assert(provider);
    providers.push(provider);
    snapshots.push(
      ...routeSnapshotsFromProviderRow(
        row,
        parseAiProviderSettings(row.settings),
        row.health,
      ),
    );
  }
  registry.replace(providers, snapshots);
  let tokens = 0,
    costMicros = 0;
  const jobs = p.entrants.map((e) => {
    const stored = arena.entrants.find(
      (x) => x.providerId === e.providerId && x.model === e.model,
    );
    assert(stored);
    assert.deepEqual(stored.remaining, e.budget);
    const { provider, execution } = registry.strictReadyContract({
      providerId: e.providerId,
      model: e.model,
      contract: contract.ref,
      budgetAuthorized: true,
    });
    assert.equal(execution.liveValidation.status, "passed");
    assert.notEqual(execution.requestOptions?.outputTokenLimit, "upstream");
    const runtime = provider.sdkRuntime();
    const price = provider.metadata.modelPricing[e.model];
    assert(
      runtime &&
        price.costCurrency === p.budgetCurrency &&
        price.costPer1kInput != null &&
        price.costPer1kOutput != null,
    );
    const reserved = new Prisma.Decimal(price.costPer1kInput)
      .times(e.maxInputTokens)
      .plus(new Prisma.Decimal(price.costPer1kOutput).times(e.maxOutputTokens))
      .times(1000)
      .ceil()
      .toNumber();
    assert(
      inputs <= e.maxInputTokens &&
        e.maxInputTokens <= 16000 &&
        e.maxOutputTokens <= 4000 &&
        e.budget.requests === 1 &&
        e.budget.tokens >= e.maxInputTokens + e.maxOutputTokens &&
        reserved <= e.budget.costMicros,
    );
    costMicros += reserved;
    tokens += e.maxInputTokens + e.maxOutputTokens;
    return { e, execution, price, runtime, reserved };
  });
  assert(tokens <= p.budget.tokens && costMicros <= p.budget.costMicros);
  const identities = await Promise.all(
    jobs.map((j) => prepareModelReceipt(j.runtime, j.e.model)),
  );
  const plan = {
    arenaId: arena.id,
    asOf: packet.asOf,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(messages))
      .digest("hex"),
    models: jobs.map((j) => j.e.model),
    reservations: jobs.map(({ e, reserved }) => ({
      providerId: e.providerId,
      model: e.model,
      requests: 1,
      inputTokens: e.maxInputTokens,
      outputTokens: e.maxOutputTokens,
      costMicros: reserved,
    })),
    requests: jobs.length,
    tokens,
    costMicros,
    inputByteGuard: inputs,
  };
  if (mode === "--check") return plan;
  assert.deepEqual(
    plan,
    JSON.parse(reservedPlan),
    "全员额度或输入已变化，本轮停止派发",
  );
  const sdk = new AiSdkGenerationAdapter();
  const results = await Promise.all(
    jobs.map(async ({ e, execution, price, runtime }, index) => {
      const requestId = randomUUID(),
        base = { requestId, providerId: e.providerId, model: e.model };
      let res;
      try {
        res = await sdk.generate({
          requestId,
          providerId: e.providerId,
          model: e.model,
          baseURL: runtime.baseURL,
          apiKey: runtime.apiKey,
          authMode: runtime.authMode,
          adapter: execution.adapter,
          mode: execution.mode,
          compatibilityExtensionProfile:
            execution.compatibilityExtensionProfile,
          requestOptions: execution.requestOptions,
          transport: "stream",
          contract: contract.ref,
          schema: contract.schema,
          messages,
          maxOutputTokens: e.maxOutputTokens,
          timeout: { totalMs: 200000 },
          signal: AbortSignal.timeout(200000),
        });
      } catch (err) {
        return {
          ...base,
          status: "failed",
          code: err.fact?.code ?? "provider_error",
          ...aiProviderTestFailureFacts(err),
        };
      }
      const accounting = aiProviderTestSuccessFacts(
        { modelPricing: { [e.model]: price } },
        e.model,
        res,
      );
      const modelIdentity = await identities[index].verify(res.actualModel);
      if (!modelIdentity.accepted)
        return {
          ...base,
          ...accounting,
          status: "invalid",
          code: "model_identity_unverified",
          modelIdentity,
          output: res.output,
        };
      try {
        return {
          ...base,
          ...accounting,
          status: "valid",
          modelIdentity,
          decision: checkArenaDecision(res.output, p, book, facts),
        };
      } catch {
        return {
          ...base,
          ...accounting,
          status: "invalid",
          output: res.output,
        };
      }
    }),
  );
  return { plan, results };
}
try {
  console.log(JSON.stringify(await replay()));
} catch (error) {
  console.log(
    JSON.stringify({
      failed: "preflight",
      code: error.name,
      check: error.code,
      ...(error instanceof ReplayTimeError ? { reason: error.message } : {}),
    }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
