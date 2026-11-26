import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { docker, inspect } from './runtime-io.mjs';

const archiveScript = `
local keys = redis.call('KEYS', ARGV[1] .. '*')
table.sort(keys)
local rows = {}
local function hex(bytes)
  return (string.gsub(bytes, '.', function(c) return string.format('%02x', string.byte(c)) end))
end
for _, key in ipairs(keys) do
  local bytes = redis.call('DUMP', key)
  if bytes then
    local item = {key=key, expiresAt=redis.call('PEXPIRETIME', key), payload=hex(bytes)}
    if redis.call('TYPE', key).ok == 'hash' then
      local fields = redis.call('HGETALL', key)
      local canonical = {}
      for index = 1, #fields, 2 do
        canonical[#canonical+1] = hex(fields[index]) .. ':' .. hex(fields[index+1])
      end
      table.sort(canonical)
      item.hashFields = canonical
    end
    rows[#rows + 1] = item
  end
end
return cjson.encode(rows)
`;

function validatePrefix(prefix) {
  assert(/^[a-zA-Z0-9:_-]+:$/.test(prefix), 'Redis 备份需要明确命名空间');
}

export function captureRedisNamespace(container, prefix) {
  validatePrefix(prefix);
  const archive = JSON.parse(docker(['exec', container, 'redis-cli', '--raw', 'EVAL_RO', archiveScript, '0', prefix]));
  if (Array.isArray(archive)) return archive;
  assert.deepEqual(archive, {});
  return [];
}

function restoreCommands(prefix, archive) {
  const seen = new Set();
  const chunks = [];
  let count = 0;
  for (const { key, expiresAt, payload } of archive) {
    assert(key.startsWith(prefix) && !seen.has(key), 'Redis 归档键越界或重复');
    assert((expiresAt === -1 || (Number.isSafeInteger(expiresAt) && expiresAt > 0)) &&
      /^(?:[0-9a-f]{2})+$/.test(payload), 'Redis 归档载荷或有效期无效');
    seen.add(key);
    if (expiresAt !== -1 && expiresAt <= Date.now()) continue;
    count += 1;
    const arguments_ = ['RESTORE', key, expiresAt === -1 ? '0' : String(expiresAt), Buffer.from(payload, 'hex')];
    if (expiresAt !== -1) arguments_.push('ABSTTL');
    chunks.push(Buffer.from('*' + arguments_.length + '\r\n'));
    for (const item of arguments_) {
      const bytes = typeof item === 'string' ? Buffer.from(item) : item;
      chunks.push(Buffer.from('$' + bytes.length + '\r\n'), bytes, Buffer.from('\r\n'));
    }
  }
  return { input: Buffer.concat(chunks), count };
}

export async function withRestoredRedisNamespace(image, prefix, archive, check) {
  validatePrefix(prefix);
  assert(/^sha256:[0-9a-f]{64}$/.test(image), '需要源 Redis 镜像完整身份');
  const owner = randomUUID();
  const name = 'thesis-redis-restore-' + owner;
  const label = 'io.thesisledger.redis-restore';
  const { input, count } = restoreCommands(prefix, archive);
  let id;
  try {
    id = docker(['run', '--pull', 'never', '--detach', '--network', 'none', '--name', name,
      '--label', label + '=' + owner, '--tmpfs', '/data',
      image, 'redis-server', '--save', '', '--appendonly', 'no']).toString().trim();
    assert(/^[0-9a-f]{64}$/.test(id));
    const bound = inspect(id);
    assert.equal(bound.Config.Labels?.[label], owner);
    assert.equal(bound.HostConfig.NetworkMode, 'none');
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      try {
        ready = docker(['exec', id, 'redis-cli', '--raw', 'PING'], { timeout: 2_000 }).toString().trim() === 'PONG';
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert(ready, '隔离 Redis 未就绪');
    assert.equal(docker(['exec', id, 'redis-cli', '--raw', 'DBSIZE']).toString().trim(), '0');
    if (input.length) {
      const result = docker(['exec', '-i', id, 'redis-cli', '--pipe'], { input, timeout: 10_000 }).toString();
      assert.equal(/errors: 0, replies: (\d+)/u.exec(result)?.[1], String(count), '隔离 Redis 恢复未完成');
    }
    const restored = captureRedisNamespace(id, prefix);
    const time = Date.now();
    // 哈希在恢复后可换内部编码及字段顺序，按字节核对排序后的字段和值。
    const values = (rows) => rows.filter((row) => row.expiresAt === -1 || row.expiresAt > time)
      .map(({ key, expiresAt, payload, hashFields }) => ({ key, expiresAt, value: hashFields ?? payload }));
    assert(isDeepStrictEqual(values(restored), values(archive)), '隔离 Redis 恢复后的键、值或绝对有效期变化');
    return await check(id);
  } finally {
    if (id && /^[0-9a-f]{64}$/.test(id)) {
      const bound = inspect(id);
      assert.equal(bound.Name, '/' + name);
      assert.equal(bound.Config.Labels?.[label], owner);
      docker(['rm', '-f', '-v', id]);
    }
  }
}
