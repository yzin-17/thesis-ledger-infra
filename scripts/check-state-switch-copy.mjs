import { LocalDocker } from './runtime/docker.mjs';
import { DatabaseUpdate } from './runtime/database.mjs';
import { verifyRecordedStateSwitchCopies } from './runtime/state-switch.mjs';

const [file, token] = process.argv.slice(2);
if (!file || !token || process.argv.length !== 4) throw new Error('需要切换包和已登记的隔离副本身份');
const runtime = await new LocalDocker().connect();
runtime.configureCompose();
const database = new DatabaseUpdate(runtime, 'all');
await database.initialize();
try {
  await runtime.locked(async () => verifyRecordedStateSwitchCopies(runtime, database, file, token));
  console.log('已核对隔离 SQLite 和文件树。');
} catch (error) {
  process.stderr.write(`副本读回失败 ${error.message}\n${error.stderr?.toString() ?? ''}\n`);
  process.exitCode = 1;
}
