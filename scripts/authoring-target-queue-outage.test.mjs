import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoInflightWork,
  assertQueueRejected,
} from "./authoring-target-queue-outage.mjs";

test("故障窗口拒绝任何在途任务", () => {
  assertNoInflightWork({
    authoring: 0,
    backtest: 0,
    research: 0,
    automation: 0,
  });
  for (const kind of ["authoring", "backtest", "research", "automation"]) {
    assert.throws(() => assertNoInflightWork({ [kind]: 1 }));
  }
});
test("队列故障必须明确拒绝，不能接受或隐式降级", () => {
  assertQueueRejected({ status: 503, body: { code: "AUTHORING_UNAVAILABLE" } });
  assert.throws(() =>
    assertQueueRejected({
      status: 202,
      body: { code: "AUTHORING_UNAVAILABLE" },
    }),
  );
  assert.throws(() =>
    assertQueueRejected({ status: 503, body: { code: "OTHER_ERROR" } }),
  );
});
