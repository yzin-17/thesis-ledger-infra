import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const owner = 'mobile-notification-live';
const marker = 'MOBILE_NOTIFICATION_RESULT ';

export const isConfirmedNotificationReceipt = receipt => receipt?.httpStatus === 200 &&
  (receipt.businessCode === 0 || receipt.businessCode === '0');

export function redactNotificationDiagnostic(value, credential = '') {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (credential) text = text.replaceAll(credential, '[已脱敏]');
  return text.replace(/https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[^\s"'<>\\]+/gu, '[已脱敏通知地址]');
}

export function notificationTransportObserver(credential, fetcher = globalThis.fetch) {
  const events = [];
  return {
    events,
    async fetch(url, options) {
      assert.equal(String(url), credential, '验收只允许选定接收目标');
      assert.equal(options?.method, 'POST', '验收只允许原发送器的 POST');
      assert.equal(options?.redirect, 'error', '通知不得跟随重定向');
      assert.equal(events.length, 0, '单个平台的出站许可已使用');
      const event = { startedAt: new Date().toISOString(), requestSha256: digest(options.body) };
      events.push(event);
      try {
        const response = await fetcher(url, options);
        const body = await response.clone().text();
        let payload;
        try { payload = JSON.parse(body); } catch { payload = null; }
        Object.assign(event, {
          httpStatus: response.status,
          businessCode: payload?.code ?? payload?.StatusCode ?? null,
          message: String(payload?.msg ?? payload?.StatusMessage ?? '').slice(0, 120),
          responseSha256: digest(body),
          completedAt: new Date().toISOString(),
        });
        return response;
      } catch (error) {
        event.error = redactNotificationDiagnostic(error.message, credential);
        throw error;
      }
    },
  };
}

export function assertOwnedNotificationConfig(config, runId, platform) {
  assert.equal(config.type, 'notification', '配置类型不属于通知验收');
  assert.equal(config.enabled, false, '临时配置必须保持停用');
  assert.equal(config.settings?.acceptance?.owner, owner, '配置所有权不匹配');
  assert.equal(config.settings?.acceptance?.runId, runId, '验收标识不匹配');
  assert.equal(config.settings?.acceptance?.platform, platform, '配置平台不匹配');
}

const protectedTables = [
  'Account', 'AccountLedgerState', 'LedgerEvent', 'Position', 'Trade', 'PortfolioSnapshot',
  'Strategy', 'StrategyVersion', 'BacktestJob', 'AiRun', 'AiToolCall',
  'OptimizationExperiment', 'OptimizationAttempt', 'OptimizationCandidate', 'OptimizationAdoption',
  'StrategyRiskApplication', 'StrategyRiskApplicationAudit', 'RiskRule',
  'ProviderConfig', 'AiInvocation', 'AiInvocationFact', 'AiRoutingSettings', 'NotificationDelivery',
];
const snapshotSql = `SELECT json_build_object(${protectedTables.map(table =>
  `'${table}',(SELECT json_build_object('count',count(*),'rows',coalesce(json_agg(row_hash ORDER BY row_hash),'[]'::json))
    FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM "${table}" t) records)`
).join(',')}) AS snapshot`;

async function executeNotificationAcceptance(input, context) {
  await import('reflect-metadata');
  const [{ PrismaService }, { RedisService }, { DsaClient }, { ProviderHealthService },
    { ProviderConfigService }, { NotificationService, FeishuWebhookProvider }] = await Promise.all([
    import('file:///app/apps/server/dist/src/platform/prisma.service.js'),
    import('file:///app/apps/server/dist/src/platform/redis.service.js'),
    import('file:///app/apps/server/dist/src/integration/dsa/dsa.client.js'),
    import('file:///app/apps/server/dist/src/providers/provider-health.service.js'),
    import('file:///app/apps/server/dist/src/providers/provider-config.service.js'),
    import('file:///app/apps/server/dist/src/notifications/notification.service.js'),
  ]);
  const prisma = new PrismaService();
  const redis = new RedisService();
  const health = new ProviderHealthService(prisma, new DsaClient());
  const configs = new ProviderConfigService(prisma, health);
  const notifications = new NotificationService(prisma, redis, health);
  try {
    await prisma.$connect();
    const [identity] = await prisma.$queryRawUnsafe('SELECT current_database() AS database, current_user AS role');
    assert.equal(identity.database, 'thesis_ledger', '目标数据库身份不匹配');
    assert.equal(identity.role, 'thesis_ledger_app', '目标应用角色不匹配');
    const routes = await notifications.routing();
    assert.deepEqual(routes.routes, [], '正常通知路由已变化，停止本轮验收');

    if (input.phase === 'snapshot') {
      const [row] = await prisma.$queryRawUnsafe(snapshotSql);
      return { identity, routes, protectedTables: row.snapshot };
    }
    if (input.phase === 'prepare') {
      assert(input.credential && digest(input.credential) === input.credentialSha256, '凭据身份不匹配');
      await prisma.$transaction(async transaction => {
        const service = new ProviderConfigService(transaction, health);
        for (const [platform, plan] of Object.entries(input.plans)) {
          assert.equal(await transaction.providerConfig.count({ where: { name: plan.provider } }), 0, '临时名称已被占用');
          await service.save({ name: plan.provider, type: 'notification', enabled: false,
            priority: 99999, capabilities: ['notification'], credentialsRef: input.credential,
            settings: { acceptance: { owner, runId: input.runId, platform } } });
        }
      });
      return { prepared: true, routes };
    }
    if (input.phase === 'deliver') {
      const plan = input.plans[input.platform];
      const config = await prisma.providerConfig.findUniqueOrThrow({ where: { name: plan.provider } });
      assertOwnedNotificationConfig(config, input.runId, input.platform);
      context.credential = await configs.readCredential(config);
      assert.equal(digest(context.credential), input.credentialSha256, '已保存凭据与所选接收目标不一致');
      assert.equal(await prisma.notificationDelivery.count({ where: { id: plan.deliveryId } }), 0, '本平台投递记录已存在');
      const label = input.platform === 'android' ? 'Android' : 'iPhone Air';
      const now = new Date();
      const message = { title: `ThesisLedger ${label} 手机通知验收`,
        body: `平台：${label}\n验收标识：${input.runId}\n时间：${now.toISOString()}\n这是单次验收消息。`,
        severity: 'info', traceId: plan.deliveryId };
      await prisma.notificationDelivery.create({ data: { id: plan.deliveryId,
        subjectType: owner, subjectId: `${input.platform}:${input.runId}`, message,
        channel: 'feishu', provider: plan.provider, severity: 'info', status: 'sending',
        dedupKey: `${owner}:${input.runId}:${input.platform}`, scheduledAt: now } });
      const transport = notificationTransportObserver(context.credential);
      context.events = transport.events;
      const originalFetch = globalThis.fetch;
      let delivery;
      try {
        globalThis.fetch = transport.fetch;
        delivery = await notifications.deliver(plan.deliveryId, message,
          new FeishuWebhookProvider(context.credential, plan.provider), 1);
      } finally { globalThis.fetch = originalFetch; }
      const observations = await prisma.providerHealthCheck.findMany({
        where: { provider: plan.provider, source: 'delivery' }, orderBy: { checkedAt: 'asc' },
      });
      const event = context.events[0];
      return { accepted: context.events.length === 1 && isConfirmedNotificationReceipt(event) &&
          delivery.status === 'delivered' && delivery.attemptCount === 1 && observations.length === 1,
        delivery: { id: delivery.id, status: delivery.status, attemptCount: delivery.attemptCount,
          provider: delivery.provider, subjectId: delivery.subjectId, deliveredAt: delivery.deliveredAt,
          errorCode: delivery.errorCode, lastError: delivery.lastError,
          responseSummary: delivery.responseSummary }, observations };
    }
    if (input.phase === 'inspect' || input.phase === 'cleanup') {
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { id: { in: Object.values(input.plans).map(plan => plan.deliveryId) } },
        orderBy: { scheduledAt: 'asc' },
      });
      if (input.phase === 'cleanup') {
        assert(!deliveries.some(row => row.status === 'sending'), '仍有执行中记录，必须先核对实际结果');
        for (const [platform, plan] of Object.entries(input.plans)) {
          const config = await prisma.providerConfig.findUnique({ where: { name: plan.provider } });
          if (!config) continue;
          assertOwnedNotificationConfig(config, input.runId, platform);
          context.credential = await configs.readCredential(config);
          assert.equal(digest(context.credential), input.credentialSha256, '清理配置凭据身份不匹配');
          await configs.deleteStored(plan.provider, config.updatedAt.toISOString());
        }
      }
      const remaining = await prisma.providerConfig.findMany({
        where: { name: { in: Object.values(input.plans).map(plan => plan.provider) } },
        select: { name: true, enabled: true, type: true },
      });
      const [row] = await prisma.$queryRawUnsafe(snapshotSql);
      return { deliveries, remaining, routes: await notifications.routing(), protectedTables: row.snapshot };
    }
    throw new Error('不支持该验收阶段');
  } finally {
    redis.client.disconnect();
    await prisma.$disconnect();
  }
}

if (process.env.MOBILE_NOTIFY_ACCEPTANCE_RUNNER === '1') {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const context = { credential: input.credential ?? '', events: [] };
  try {
    const result = await executeNotificationAcceptance(input, context);
    process.stdout.write('\n' + marker + redactNotificationDiagnostic({ ok: true, ...result,
      outboundCount: context.events.length, receipts: context.events }, context.credential) + '\n');
  } catch (error) {
    process.stdout.write('\n' + marker + redactNotificationDiagnostic({ ok: false,
      error: error.message, outboundCount: context.events.length, receipts: context.events }, context.credential) + '\n');
    process.exitCode = 1;
  }
}
