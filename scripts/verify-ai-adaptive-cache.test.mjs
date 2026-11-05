import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveCacheFixturePlan } from "./verify-ai-adaptive-cache.mjs";

test("隔离Redis计划禁止拉取、网络、持久卷与目标资源变更", () => {
  const image = "sha256:" + "a".repeat(64),
    id = "11111111-1111-4111-8111-111111111111";
  const plan = adaptiveCacheFixturePlan(image, id);
  assert.equal(plan.name, `thesis-ledger-ai-adaptive-${id}`);
  for (const required of [
    "--pull=never",
    "--network=none",
    "--read-only",
    image,
  ])
    assert(plan.args.includes(required));
  for (const forbidden of [
    "--volume",
    "-v",
    "--mount",
    "--privileged",
    "--publish",
    "-p",
  ])
    assert(!plan.args.includes(forbidden));
  assert.equal(plan.args.filter((value) => value === "--tmpfs").length, 2);
  assert(plan.args.includes(`thesis-ledger.ai-adaptive-fixture=${id}`));
});
test("镜像和资源标识必须精确，拒绝模糊标签和外部名称", () => {
  assert.throws(() => adaptiveCacheFixturePlan("redis:latest"));
  assert.throws(() =>
    adaptiveCacheFixturePlan("sha256:" + "a".repeat(64), "production"),
  );
});
