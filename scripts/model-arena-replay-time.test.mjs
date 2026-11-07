import assert from "node:assert/strict";
import test from "node:test";
import { validateReplayTime } from "./model-arena-replay-time.mjs";

const asOf = "2020-11-06T14:16:11.355Z";
const earlier = "2020-11-06T00:06:15.000Z";
const later = "2020-11-06T14:16:11.356Z";
const zone = "Asia/Shanghai";
const news = { kind: "news", publishedAt: earlier, availableAt: asOf };

test("发布时间与可用时间分别检查，等于截止可入包，一条晚到就退回全包", () => {
  const check = (facts) => validateReplayTime({ asOf }, facts, zone);
  assert.equal(check([news, { ...news, publishedAt: asOf }]), "2020-11-06");
  assert.throws(
    () => check([news, { ...news, availableAt: later }]),
    /可用时间/,
  );
  assert.throws(() => check([{ ...news, publishedAt: later }]), /发布时间/);
  assert.throws(() => check([{ ...news, availableAt: undefined }]), /可用时间/);
  assert.throws(
    () => check([{ ...news, availableAt: asOf.replace(".355Z", ".355001Z") }]),
    /可用时间/,
  );
  assert.equal(
    check([{ ...news, publishedAt: asOf.replace(".355Z", ".355000Z") }]),
    "2020-11-06",
  );
});

const timestamp = "2020-11-06T00:00:00+08:00";
const symbol = "600036.SH";
const closedSession = {
  symbol,
  inputFingerprint: "1".repeat(64),
  identity: { symbol, timeframe: "1d", adjustment: "none" },
  bar: {
    timestamp,
    availableAt: earlier,
    completionStatus: "complete",
    open: 10,
    high: 11,
    low: 9,
    close: 10,
  },
};
const daily = {
  kind: "daily_bar",
  symbol,
  date: "2020-11-06",
  observedAt: new Date(timestamp).toISOString(),
  availableAt: earlier,
  open: "10",
  high: "11",
  low: "9",
  close: "10",
};

test("收盘场景只接受与已采集完整日线逐项一致的当日行情", () => {
  const check = (facts, source = closedSession) =>
    validateReplayTime({ asOf, closedSession: source }, facts, zone);
  assert.equal(check([daily, news]), "2020-11-06");
  assert.throws(() => check([{ ...daily, close: "12" }]), /回执不一致/);
  assert.throws(
    () =>
      check([daily], {
        ...closedSession,
        bar: { ...closedSession.bar, completionStatus: "partial" },
      }),
    /完整日线/,
  );
  assert.throws(
    () =>
      check([daily], {
        ...closedSession,
        bar: { ...closedSession.bar, availableAt: later },
      }),
    /完整日线/,
  );
  assert.throws(
    () => check([daily, { ...daily, date: "2020-11-05", availableAt: later }]),
    /尚不可用/,
  );
  assert.throws(
    () => validateReplayTime({ asOf }, [daily], zone),
    /允许的日期/,
  );
});
