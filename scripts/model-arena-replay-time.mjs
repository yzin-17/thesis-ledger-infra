// 回放宿主把本模块和执行器一起送入目标 Server；定向测试导入同一份校验。
export class ReplayTimeError extends Error {}

// 来源回执可精确到微秒，Date.parse 只保留毫秒。
function atOrBefore(value, cutoff) {
  const left = Date.parse(value);
  const right = Date.parse(cutoff);
  if (left !== right) return left < right;
  const remainder = (iso) =>
    (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? "")
      .slice(3)
      .replace(/0+$/, "");
  return remainder(value) <= remainder(cutoff);
}

export function validateReplayTime(packet, facts, timeZone) {
  const cutoff = Date.parse(packet.asOf);
  if (
    !Number.isFinite(cutoff) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(packet.asOf) ||
    !atOrBefore(packet.asOf, new Date().toISOString())
  )
    throw new ReplayTimeError("回放截止时间须是已经到达的时刻");
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone });
  const day = dayOf.format(cutoff);
  const session = packet.closedSession;
  let closingFact;
  if (session !== undefined) {
    const bar = session?.bar;
    const identity = session?.identity;
    if (
      bar?.completionStatus !== "complete" ||
      identity?.timeframe !== "1d" ||
      identity.adjustment !== "none" ||
      identity.symbol !== session.symbol ||
      !/^[a-f0-9]{64}$/.test(session.inputFingerprint) ||
      !atOrBefore(bar.availableAt, packet.asOf) ||
      !atOrBefore(bar.timestamp, packet.asOf) ||
      dayOf.format(Date.parse(bar.timestamp)) !== day
    )
      throw new ReplayTimeError("缺少截止前已采集的当日完整日线回执");
    const matching = facts.filter(
      (f) =>
        f.kind === "daily_bar" && f.symbol === session.symbol && f.date === day,
    );
    closingFact = matching[0];
    if (
      matching.length !== 1 ||
      Date.parse(closingFact.observedAt) !== Date.parse(bar.timestamp) ||
      Date.parse(closingFact.availableAt) !== Date.parse(bar.availableAt) ||
      !["open", "high", "low", "close"].every(
        (key) => closingFact[key] === String(bar[key]),
      )
    )
      throw new ReplayTimeError("回放当日日线与来源回执不一致");
  }
  for (const f of facts) {
    if (f.kind === "news") {
      if (!(
        atOrBefore(f.publishedAt, packet.asOf) &&
        atOrBefore(f.availableAt, packet.asOf)
      ))
        throw new ReplayTimeError("回放新闻的发布时间或材料可用时间晚于截止");
    } else {
      if (f !== closingFact && f.date >= day)
        throw new ReplayTimeError("回放行情或报告超过允许的日期");
      if (session && !atOrBefore(f.availableAt, packet.asOf))
        throw new ReplayTimeError("收盘回放材料在截止前尚不可用");
    }
  }
  return day;
}
