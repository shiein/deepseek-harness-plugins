/**
 * 直接驱动备份模块（不经过 HTTP/插件装载）验证 sync.sh 编排、日志阶段解析与结果。
 *   node test/backup-driver.mjs            # 真实备份（上传到网盘，滚动保留 5 份）
 *   node test/backup-driver.mjs --dry      # 只检查环境，不启动备份
 *
 * 注意：会占用插件运行态锁并写入 ~/.dsh-maintenance/task.json；结束后释放。
 */

import { createCore } from '../host/core.js';
import { createQuark } from '../host/quark.js';
import { createBackup } from '../host/backup.js';

const fakeCtx = {
  get: () => undefined,
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

const core = createCore(fakeCtx);
const quark = createQuark(core);
const backup = createBackup(core, quark);

if (process.argv.includes('--dry')) {
  console.log('env ok:', JSON.stringify({ syncScript: core.paths.syncScript, cli: core.paths.cliPath }));
  process.exit(0);
}

const started = await backup.start({ force: true, trigger: 'manual', keep: 5 });
if (!started.ok) {
  console.error('busy:', JSON.stringify(started.task || null));
  process.exit(1);
}
console.log('task started:', started.task.id);
const deadline = Date.now() + 5 * 60 * 1000;
let task = started.task;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  task = backup.status();
  console.log(
    `[${new Date().toISOString()}]`,
    task.phase,
    task.stage,
    `${task.progress}%`,
    task.stageLabel,
    'logLines=' + (task.logTail?.length || 0),
  );
  if (task.phase !== 'running') break;
}
console.log('result:', JSON.stringify(task.result, null, 2));
console.log('error:', task.error);
console.log('warnings:', JSON.stringify(task.warnings || []));
console.log('log tail:', JSON.stringify((task.logTail || []).slice(-8), null, 2));
backup.dispose();
if (task.phase !== 'success' && task.phase !== 'skipped') process.exit(1);
console.log('BACKUP DRIVER PASS');
