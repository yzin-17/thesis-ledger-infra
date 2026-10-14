import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecoveryArguments,
  assertOwnedFaultWindow,
  assertAuthoringRecovery,
} from "./authoring-target-recovery.mjs";

const prefix = "nla6_20261006_1234abcd.";
const before = {
  username: `${prefix}alice`,
  status: "running",
  attempt: 1,
  invocations: [
    {
      requestId: "only-request",
      facts: [{ kind: "dispatching", sequence: 1 }],
    },
  ],
};
test("只接受精确开发目标和标记范围", () => {
  assert.deepEqual(
    parseRecoveryArguments([
      "--confirm=thesis-ledger-dev/thesis_ledger",
      "--operation=11111111-1111-4111-8111-111111111111",
      `--owner-prefix=${prefix}`,
    ]),
    { id: "11111111-1111-4111-8111-111111111111", prefix },
  );
  assert.throws(() =>
    parseRecoveryArguments([
      "--confirm=production",
      "--operation=invalid",
      `--owner-prefix=${prefix}`,
    ]),
  );
});
test("非标记用户、晚到结果、重复 attempt 和重复调用均拒绝注入", () => {
  assertOwnedFaultWindow(before, prefix);
  for (const patch of [
    { username: "other.alice" },
    { status: "succeeded" },
    { attempt: 2 },
    { invocations: [] },
    { invocations: [...before.invocations, ...before.invocations] },
    {
      invocations: [
        { requestId: "only-request", facts: [{ kind: "received" }] },
      ],
    },
  ])
    assert.throws(() =>
      assertOwnedFaultWindow({ ...before, ...patch }, prefix),
    );
});
test("恢复必须失败未知，保持调用标识及 attempt", () => {
  const after = {
    ...before,
    status: "failed",
    outcome: {
      externalResult: "unknown",
      errorCode: "AUTHORING_RESULT_UNKNOWN",
      usage: null,
      cost: {
        status: "unknown",
        amount: null,
        currency: null,
        source: null,
        pricingVersion: null,
      },
    },
    invocations: [
      {
        requestId: "only-request",
        facts: [{ kind: "dispatching" }, { kind: "unknown" }],
      },
    ],
  };
  assertAuthoringRecovery(before, after);
  for (const patch of [
    { status: "running" },
    { attempt: 2 },
    { outcome: { externalResult: "received" } },
    {
      outcome: {
        ...after.outcome,
        usage: { status: "reported", inputTokens: 0, outputTokens: 0 },
      },
    },
    {
      outcome: {
        ...after.outcome,
        cost: { ...after.outcome.cost, amount: "0", currency: "USD" },
      },
    },
    {
      invocations: [
        { requestId: "another-request", facts: [{ kind: "unknown" }] },
      ],
    },
  ])
    assert.throws(() =>
      assertAuthoringRecovery(before, { ...after, ...patch }),
    );
});
