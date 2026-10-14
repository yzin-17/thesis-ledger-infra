import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUndispatched,
  assertDeliveryTerminal,
} from "./authoring-target-delivery.mjs";
test("未派发恢复只接受标记用户的 attempt0 且没有模型调用", () => {
  const prefix = "nla6_20261006_1234abcd.";
  const row = {
    username: `${prefix}alice`,
    status: "queued",
    attempt: 0,
    invocations: 0,
  };
  assertUndispatched(row, prefix);
  for (const patch of [
    { username: "other.alice" },
    { status: "running" },
    { attempt: 1 },
    { invocations: 1 },
  ])
    assert.throws(() => assertUndispatched({ ...row, ...patch }, prefix));
});
test("有限补投必须派发一次并保持成功或明确失败终态，未知费用不能记零", () => {
  const row = {
    status: "failed",
    attempt: 1,
    deliveryAttempts: 1,
    invocations: [
      {
        requestedModel: "selected",
        facts: [{ kind: "dispatching" }, { kind: "unknown" }],
      },
    ],
    outcome: {
      externalResult: "unknown",
      errorCode: "AUTHORING_RESULT_UNKNOWN",
      cost: { status: "unknown", amount: null, currency: null },
    },
  };
  assertDeliveryTerminal(row, "selected");
  assertDeliveryTerminal(
    { ...row, status: "succeeded", outcome: { externalResult: "received" } },
    "selected",
  );
  for (const patch of [
    { status: "running" },
    { attempt: 2 },
    { deliveryAttempts: 2 },
    { invocations: [] },
    {
      invocations: [
        { requestedModel: "selected", facts: [{ kind: "unknown" }] },
      ],
    },
    { outcome: { ...row.outcome, externalResult: "not_sent" } },
    {
      outcome: {
        ...row.outcome,
        cost: { status: "unknown", amount: "0", currency: "USD" },
      },
    },
  ]) {
    assert.throws(() =>
      assertDeliveryTerminal({ ...row, ...patch }, "selected"),
    );
  }
  assert.throws(() => assertDeliveryTerminal(row, "other-model"));
});
