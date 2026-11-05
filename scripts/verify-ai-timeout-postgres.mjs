import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { docker, inspect, target } from "./research-state-backup.mjs";

const label = "thesis-ledger.ai-timeout-fixture";
const database = "ai_provider_concurrency_fixture";
const role = "fixture_owner";
const appRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../thesis-ledger",
);

export function timeoutPostgresPlan(image, id = randomUUID()) {
  assert(/^sha256:[a-f0-9]{64}$/u.test(image), "必须复用本地精确镜像");
  assert(/^[a-f0-9-]{36}$/u.test(id), "隔离资源必须使用UUID");
  const name = `thesis-ledger-ai-timeout-${id}`;
  return {
    id,
    name,
    image,
    args: [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      "--network",
      "bridge",
      "--publish",
      "127.0.0.1::5432",
      "--read-only",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,size=512m",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/var/run/postgresql",
      "-e",
      `POSTGRES_DB=${database}`,
      "-e",
      `POSTGRES_USER=${role}`,
      "-e",
      `POSTGRES_PASSWORD=fixture-${id}`,
      image,
    ],
  };
}
export function assertTimeoutFixture(value, name) {
  assert(
    /^thesis-ledger-ai-timeout-[a-f0-9-]{36}$/u.test(name),
    "拒绝操作目标资源",
  );
  const id = name.slice("thesis-ledger-ai-timeout-".length);
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Config.Labels[label], id);
  assert(/^sha256:[a-f0-9]{64}$/u.test(value.Image));
  assert.equal(value.HostConfig.NetworkMode, "bridge");
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert(
    value.Mounts.every((mount) => mount.Type === "tmpfs"),
    "禁止持久卷或宿主挂载",
  );
  return id;
}
const owned = (name) => {
  const value = inspect(name);
  assertTimeoutFixture(value, name);
  return value;
};
const sql = (name, input) => {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      name,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      role,
      "-d",
      database,
      "-Atq",
    ],
    { input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    `隔离SQL失败：${String(result.stderr).slice(-1500)}`,
  );
  return result.stdout.trim();
};
const cleanup = (name) => {
  const value = owned(name);
  docker(["rm", "-f", value.Id]);
};
async function testDatabase(name) {
  const value = owned(name),
    port = value.NetworkSettings.Ports["5432/tcp"]?.[0];
  assert.equal(port?.HostIp, "127.0.0.1");
  assert(/^\d+$/u.test(port.HostPort));
  const id = assertTimeoutFixture(value, name);
  assert.equal(
    sql(name, "SELECT current_database() || ':' || current_user"),
    `${database}:${role}`,
  );
  const migrations = resolve(appRoot, "apps/server/prisma/migrations");
  const directories = readdirSync(migrations)
    .filter((item) => /^\d{14}_/u.test(item))
    .sort();
  assert(directories.length > 0, "缺少migration输入");
  assert.equal(
    sql(name, 'SELECT version FROM "SchemaVersion" WHERE id=1'),
    directories.at(-1),
  );
  const schema = readFileSync(
    resolve(appRoot, "apps/server/prisma/schema.prisma"),
    "utf8",
  );
  const expected = [
    ...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gmu),
  ].map((match) => /@@map\("([^"]+)"\)/u.exec(match[2])?.[1] ?? match[1]);
  expected.push(
    ...JSON.parse(
      readFileSync(
        resolve(appRoot, "apps/server/prisma/raw-owned-tables.json"),
        "utf8",
      ),
    ).tables.map((table) => table.name),
  );
  const actual = JSON.parse(
    sql(
      name,
      "SELECT coalesce(json_agg(tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'",
    ),
  );
  assert.deepEqual(
    [...new Set(expected)].filter((table) => !actual.includes(table)),
    [],
    "隔离结构缺表",
  );
  const url = `postgresql://${role}:fixture-${id}@127.0.0.1:${port.HostPort}/${database}`;
  const env = {
    ...process.env,
    AI_EXECUTION_DATABASE_URL: url,
    AI_PROVIDER_DATABASE_URL: url,
    RESEARCH_QUERY_DATABASE_URL: url,
  };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "CLOUDFLARE_API_KEY",
  ])
    delete env[key];
  const files = readdirSync(resolve(appRoot, "apps/server/test/ai"))
    .filter(
      (item) =>
        (item.includes("postgres") ||
          item === "ai-research-process-recovery.integration.test.ts") &&
        item.endsWith(".test.ts"),
    )
    .sort();
  const output = await new Promise((done, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--no-file-parallelism",
        ...files.map((file) => `test/ai/${file}`),
      ],
      {
        cwd: resolve(appRoot, "apps/server"),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
    child.stderr.on("data", (chunk) => {
      text += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const summary = text
        .split("\n")
        .filter((line) =>
          /Test Files|Tests |Duration|FAIL|Error:|expected|Assertion|❯/u.test(
            line,
          ),
        );
      if (code === 0) done(summary.join("\n"));
      else reject(new Error(summary.slice(-70).join("\n")));
    });
  });
  return {
    migrations: directories.length,
    head: directories.at(-1),
    testFiles: files.length,
    summary: output,
  };
}

export async function verifyTimeoutPostgres(resumeName) {
  const source = inspect(`${target}-postgres-1`);
  const plan = timeoutPostgresPlan(source.Image);
  const name = resumeName ?? plan.name;
  let created = Boolean(resumeName),
    success = false;
  try {
    if (resumeName) owned(name);
    else {
      docker(plan.args);
      created = true;
      for (let i = 0; i < 100; i += 1) {
        const state = owned(name);
        assert.equal(state.State.Running, true, "隔离PostgreSQL退出");
        try {
          sql(name, "SELECT 1");
          break;
        } catch {
          if (i === 99) throw new Error("隔离PostgreSQL未就绪");
          await wait(100);
        }
      }
      assert.equal(
        sql(name, "SELECT current_database() || ':' || current_user"),
        `${database}:${role}`,
      );
      const root = resolve(appRoot, "apps/server/prisma/migrations");
      for (const file of readdirSync(root)
        .filter((item) => /^\d{14}_/u.test(item))
        .sort())
        sql(name, readFileSync(resolve(root, file, "migration.sql")));
    }
    const result = await testDatabase(name);
    success = true;
    return { ...result, isolated: true, targetMutated: false, cleaned: true };
  } catch (error) {
    if (created)
      console.error(
        JSON.stringify({
          isolatedFixtureRetained: name,
          resume: `node scripts/verify-ai-timeout-postgres.mjs --resume ${name}`,
          cleanup: `node scripts/verify-ai-timeout-postgres.mjs --cleanup ${name}`,
        }),
      );
    throw error;
  } finally {
    if (created && success) cleanup(name);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, name, extra] = process.argv.slice(2);
  assert(
    extra === undefined && ["--run", "--resume", "--cleanup"].includes(mode),
    "使用--run、--resume <fixture>或--cleanup <fixture>",
  );
  if (mode === "--run") assert(name === undefined);
  else assert(name);
  if (mode === "--cleanup") cleanup(name);
  else
    console.log(
      JSON.stringify(
        await verifyTimeoutPostgres(mode === "--resume" ? name : undefined),
      ),
    );
}
