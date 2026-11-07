// 只读取本机开发环境的新闻。每个消费入口各读一页，模型执行不在此入口中。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const symbol = "600036.SH";
const expectedSource = "hithink-news-stock-timeline";
function checkPage(page) {
  assert.equal(page.instrument.symbol, symbol);
  assert.equal(page.source?.providerId, "hithink");
  assert.equal(page.source?.upstreamSource, expectedSource);
  assert(["available", "partial"].includes(page.status));
  assert(page.items.length > 0 && page.items.length <= 5);
  assert(
    Number.isInteger(page.upstreamAttempts) &&
      page.upstreamAttempts >= 0 &&
      page.upstreamAttempts <= 1,
  );
  assert.equal(page.errors.length, 0);
}

async function targetResearch() {
  const { DsaClient } =
    await import("./dist/src/integration/dsa/dsa.client.js");
  const { MarketNewsReader } =
    await import("./dist/src/market/market-news-reader.js");
  const { MarketInstrumentEvidence } =
    await import("./dist/src/market/market-instrument-evidence.js");
  const reader = new MarketNewsReader(new DsaClient());
  let page, query;
  const observed = {
    read: async (input, signal) => {
      assert.equal(query, undefined);
      assert.equal(input.instrument.symbol, symbol);
      assert.equal(input.limit, 5);
      query = input;
      page = await reader.read(input, signal);
      return page;
    },
  };
  const market = new MarketInstrumentEvidence(
    null,
    null,
    null,
    null,
    observed,
    null,
  );
  const facts = await market.recentNews(
    {
      market: "CN",
      timeZone: "Asia/Shanghai",
      instruments: [{ symbol, assetType: "STOCK" }],
    },
    new Date(Date.now() + 15_000),
  );
  checkPage(page);
  assert(facts.length > 0);
  return { query, page, facts };
}

async function detailPage(dir) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto("http://127.0.0.1:5197/market-data");
    await page.getByRole("tab", { name: "标的目录" }).click();
    await page
      .getByRole("textbox", { name: "搜索已同步标的" })
      .fill(symbol.split(".")[0]);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("button", { name: "查看 " + symbol + " 行情" })
      .click();
    const dialog = page.getByRole("dialog");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/market-data/news" &&
          r.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: "标的新闻", exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    const result = await response.json();
    checkPage(result);
    const region = dialog.getByRole("region", { name: "新闻检索结果" });
    await region.getByText(/HiThink 同花顺/).waitFor();
    for (const item of result.items) {
      const link = region.getByRole("link", { name: item.title, exact: true });
      assert.equal(
        await link.getAttribute("href"),
        item.originalUrl ?? item.url,
      );
    }
    await page.screenshot({
      path: fileURLToPath(new URL("instrument-detail.png", dir)),
    });
    return result;
  } finally {
    await browser.close();
  }
}

async function collect(arenaId) {
  assert.match(arenaId ?? "", /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  const container = "thesis-ledger-dev-thesis-ledger-1";
  const format =
    '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Health.Status}}';
  const identity = execFileSync(
    "docker",
    ["inspect", "--format", format, container],
    { encoding: "utf8" },
  ).trim();
  assert.match(
    identity,
    /^[a-f\d]{64}\|thesis-ledger-dev\|thesis-ledger\|healthy$/,
  );
  const res = await fetch(
    "http://127.0.0.1:3000/api/v1/model-arenas/" + arenaId,
  );
  assert.equal(res.status, 200);
  const { protocol } = await res.json();
  assert.deepEqual(
    protocol.instruments.map((i) => i.symbol),
    [symbol],
  );
  const root = new URL(
    "../../thesis-ledger/.recovery-artifacts/arena-news/",
    import.meta.url,
  );
  mkdirSync(root, { recursive: true });
  const dir = new URL(
    "consumers-" + new Date().toISOString().replace(/:/g, "-") + "/",
    root,
  );
  mkdirSync(dir, { mode: 0o700 });
  const save = (name, obj) =>
    writeFileSync(new URL(name, dir), JSON.stringify(obj, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  save("arena-protocol.json", protocol);
  const ui = await detailPage(dir);
  save("instrument-detail-live.json", ui);
  const raw = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-w",
      "/app/apps/server",
      identity.split("|")[0],
      "node",
      "--input-type=module",
      "-",
      "--research",
    ],
    {
      input: readFileSync(new URL(import.meta.url)),
      encoding: "utf8",
      timeout: 25_000,
    },
  );
  const arena = JSON.parse(raw);
  save("arena-source-live.json", arena);
  const matched = arena.facts.filter((f) =>
    ui.items.some(
      (i) =>
        f.ref === symbol + ":" + i.id &&
        f.title === i.title &&
        f.publisher === i.publisher &&
        f.url === (i.originalUrl ?? i.url) &&
        Date.parse(f.publishedAt) === Date.parse(i.publishedAt),
    ),
  );
  assert(matched.length > 0);
  console.log(
    JSON.stringify({
      directory: fileURLToPath(dir),
      detail: ui.items.length,
      research: arena.facts.length,
      matched: matched.length,
      detailAttempts: ui.upstreamAttempts,
      researchAttempts: arena.page.upstreamAttempts,
    }),
  );
}

if (process.argv[2] === "--research")
  console.log(JSON.stringify(await targetResearch()));
else await collect(process.argv[2]);
