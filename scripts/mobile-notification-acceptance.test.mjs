import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMobileNotificationArgs, reserveMobileNotification, compareNotificationProtection } from './mobile-notification-acceptance.mjs';
import { notificationTransportObserver, redactNotificationDiagnostic, assertOwnedNotificationConfig,
  isConfirmedNotificationReceipt } from './mobile-notification-acceptance.runtime.mjs';

const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only';
const options = { method: 'POST', redirect: 'error', body: '{"msg_type":"text"}' };

test('拒绝未知、重复参数和不明确的平台／输出边界', () => {
  for (const args of [[], ['--output=relative'], ['--output=/tmp/test', '--phase=wrong'],
    ['--output=/tmp/test', '--phase=deliver'], ['--output=/tmp/test', '--platform=android'],
    ['--output=/tmp/test', '--phase=plan', '--phase=prepare'],
    ['--output=/tmp/test', '--execute'], ['--output=/tmp/test', '--unsafe=true']]) {
    assert.throws(() => parseMobileNotificationArgs(args));
  }
  assert.equal(parseMobileNotificationArgs(['--output=/tmp/test', '--phase=deliver', '--platform=ios']).execute, false);
});

test('两平台各一份许可，保留未知占用且拒绝重复发送', () => {
  const state = { attempts: [] };
  const android = reserveMobileNotification(state, 'android');
  assert.throws(() => reserveMobileNotification(state, 'android'));
  android.status = 'failed-or-unknown';
  assert.throws(() => reserveMobileNotification(state, 'android'));
  reserveMobileNotification(state, 'ios');
  assert.throws(() => reserveMobileNotification(state, 'ios'));
  assert.equal(state.attempts.length, 2);
});

test('已证明零出站的本地失败保留历史并释放出站占用', () => {
  const state = { attempts: [] };
  reserveMobileNotification(state, 'android').status = 'not-dispatched';
  reserveMobileNotification(state, 'android');
  reserveMobileNotification(state, 'ios');
  assert.equal(state.attempts.length, 3);
  assert.throws(() => reserveMobileNotification(state, 'android'));
});

test('原业务逐行多重集比较拒绝丢失，允许本轮新增记录', () => {
  const before = { table: { count: 2, rows: ['a', 'a'] } };
  assert.equal(compareNotificationProtection(before, { table: { count: 3, rows: ['a', 'a', 'new'] } }).passed, true);
  assert.equal(compareNotificationProtection(before, { table: { count: 3, rows: ['a', 'new', 'other'] } }).passed, false);
});

test('观察器保留原传输和响应，同时阻止第二次外部 POST', async () => {
  let calls = 0;
  const observer = notificationTransportObserver(url, async (actualUrl, actualOptions) => {
    calls += 1;
    assert.equal(actualUrl, url);
    assert.equal(actualOptions, options);
    return new Response('{"code":0,"msg":"success"}', { status: 200 });
  });
  const response = await observer.fetch(url, options);
  assert.equal((await response.json()).code, 0);
  assert.equal(isConfirmedNotificationReceipt(observer.events[0]), true);
  await assert.rejects(observer.fetch(url, options));
  assert.equal(calls, 1);
});

test('错误目标、方法和重定向策略在出站前拒绝', async () => {
  let calls = 0;
  const observer = notificationTransportObserver(url, async () => { calls += 1; });
  await assert.rejects(observer.fetch(url + '-other', options));
  await assert.rejects(observer.fetch(url, { ...options, method: 'GET' }));
  await assert.rejects(observer.fetch(url, { ...options, redirect: 'follow' }));
  assert.equal(calls, 0);
});

test('传输未知占用一次许可，错误回执脱敏且不自动重发', async () => {
  let calls = 0;
  const observer = notificationTransportObserver(url, async () => {
    calls += 1;
    throw new Error('transport failed ' + url);
  });
  await assert.rejects(observer.fetch(url, options));
  await assert.rejects(observer.fetch(url, options));
  assert.equal(calls, 1);
  assert.equal(observer.events.length, 1);
  assert(!JSON.stringify(observer.events).includes(url));
});

test('裸 HTTP 成功、空／错误业务码不能取得供应商成功资格', () => {
  for (const businessCode of [null, undefined, '', ' ', false, 1, 'error'])
    assert.equal(isConfirmedNotificationReceipt({ httpStatus: 200, businessCode }), false);
  assert.equal(isConfirmedNotificationReceipt({ httpStatus: 500, businessCode: 0 }), false);
  assert.equal(isConfirmedNotificationReceipt({ httpStatus: 200, businessCode: '0' }), true);
});

test('清理必须匹配停用配置、验收所有权、平台和本轮标识', () => {
  const config = { type: 'notification', enabled: false,
    settings: { acceptance: { owner: 'mobile-notification-live', runId: 'run', platform: 'ios' } } };
  assert.doesNotThrow(() => assertOwnedNotificationConfig(config, 'run', 'ios'));
  assert.throws(() => assertOwnedNotificationConfig({ ...config, enabled: true }, 'run', 'ios'));
  assert.throws(() => assertOwnedNotificationConfig(config, 'other', 'ios'));
  assert.throws(() => assertOwnedNotificationConfig(config, 'run', 'android'));
});

test('供应商地址不会进入公开诊断', () => {
  assert(!redactNotificationDiagnostic({ error: url }, url).includes(url));
  assert(!redactNotificationDiagnostic('other ' + url).includes(url));
});
