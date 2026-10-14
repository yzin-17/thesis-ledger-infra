import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFaultWindow, assertNoOtherResearch } from './journal-target-recovery.mjs';

const ready = () => ({ status: 'running', attempt: 1, requests: [{ requestId: '00000000-0000-4000-8000-000000000001', state: 'dispatching' }] });
test('第一次单请求在途可注入故障', () => assert.doesNotThrow(() => assertFaultWindow(ready())));
for (const change of [{ status: 'succeeded' }, { status: 'failed' }, { attempt: 2 }, { requests: [] }, { requests: [{ requestId: 'bad', state: 'dispatching' }] }, { requests: [{ requestId: '00000000-0000-4000-8000-000000000001', state: 'prepared' }] }]) {
  test(`拒绝不安全窗口 ${JSON.stringify(change)}`, () => assert.throws(() => assertFaultWindow({ ...ready(), ...change })));
}
test('拒绝其他在途研究任务', () => { assert.doesNotThrow(() => assertNoOtherResearch(0)); assert.throws(() => assertNoOtherResearch(1)); });
