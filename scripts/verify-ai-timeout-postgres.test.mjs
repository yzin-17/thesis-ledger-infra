import assert from "node:assert/strict";
import test from "node:test";
import {
  timeoutPostgresPlan,
  assertTimeoutFixture,
} from "./verify-ai-timeout-postgres.mjs";

const id = "11111111-1111-4111-8111-111111111111",
  image = `sha256:${"a".repeat(64)}`;
test("隔离计划只复用精确镜像，随机localhost端口，不挂载目标卷", () => {
  const plan = timeoutPostgresPlan(image, id);
  assert(plan.args.includes("--pull=never"));
  assert(plan.args.includes("127.0.0.1::5432"));
  assert(plan.args.includes("--read-only"));
  assert.equal(plan.args.filter((arg) => arg === "--tmpfs").length, 3);
  for (const forbidden of [
    "--volume",
    "-v",
    "--mount",
    "--privileged",
    "--network=host",
  ])
    assert(!plan.args.includes(forbidden));
  assert.throws(() => timeoutPostgresPlan("postgres:latest"));
  assert.throws(() => timeoutPostgresPlan(image, "production"));
});
test("清理和恢复必须核对精确所有权及隔离挂载，拒绝目标资源", () => {
  const plan = timeoutPostgresPlan(image, id);
  const value = {
    Name: `/${plan.name}`,
    Image: image,
    Config: { Labels: { "thesis-ledger.ai-timeout-fixture": id } },
    HostConfig: { NetworkMode: "bridge", ReadonlyRootfs: true },
    Mounts: [{ Type: "tmpfs" }],
  };
  assert.equal(assertTimeoutFixture(value, plan.name), id);
  assert.throws(() =>
    assertTimeoutFixture(value, "thesis-ledger-dev-postgres-1"),
  );
  assert.throws(() =>
    assertTimeoutFixture({ ...value, Config: { Labels: {} } }, plan.name),
  );
  assert.throws(() =>
    assertTimeoutFixture({ ...value, Mounts: [{ Type: "volume" }] }, plan.name),
  );
});
