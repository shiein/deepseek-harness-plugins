/**
 * Host 模块冒烟测试（不依赖插件安装）：
 *   node test/host-smoke.mjs
 * 只做只读操作：读取连接状态、扫描备份范围、验证策略模块；不上传、不还原。
 */

import { createCore } from '../host/core.js';
import { createQuark } from '../host/quark.js';
import { createScope } from '../host/scope.js';
import { createSchedule } from '../host/schedule.js';

const fakeCtx = {
  get: () => undefined,
  logger: {
    info: (message) => console.log('[log]', message),
    warn: (message) => console.log('[warn]', message),
    error: (message) => console.log('[error]', message),
  },
};

const core = createCore(fakeCtx);
const quark = createQuark(core);
const schedule = createSchedule({
  core,
  ctx: fakeCtx,
  getConfig: () => ({}),
  onBackup: () => {},
});
const scope = createScope(core, { getKeep: () => schedule.keep() });

console.log('paths:', JSON.stringify(core.paths, null, 2));

const connection = await quark.getUserInfo();
console.log('connection:', JSON.stringify(connection, null, 2));

const report = await scope.get({ refresh: true });
console.log(
  'scope:',
  JSON.stringify(
    {
      entries: report.entries.map((e) => ({
        src: e.src,
        dest: e.dest,
        files: e.files,
        bytes: e.bytes,
        discovered: e.discovered,
        readable: e.readable,
      })),
      totals: report.totals,
      excluded: report.excluded.length,
    },
    null,
    2,
  ),
);

console.log('schedule:', JSON.stringify(schedule.get(), null, 2));
await schedule.update({ intervalMinutes: 15, keep: 5 });
console.log('schedule after update:', JSON.stringify(schedule.get(), null, 2));
schedule.dispose();
console.log('SMOKE PASS');
