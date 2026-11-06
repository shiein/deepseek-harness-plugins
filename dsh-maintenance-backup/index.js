/**
 * 网盘备份维护 —— Host 插件入口。
 *
 * 职责：
 * - 挂载 loopback JSON API（连接状态、备份范围、立即备份、快照、还原、策略、重启）；
 * - 定时器 + fs.watch 变更监听（策略写进 profile 的 cordis.patch.yml）；
 * - 备份链路走 host/native/ 纯 Node 引擎（macOS / Windows 同一套，不调用 sync.sh）；
 * - 启动时检测 restore-pending.json 并收尾两阶段还原。
 */

import { join } from 'node:path';

import { createCore } from './host/core.js';
import { createQuark } from './host/quark.js';
import { createScope } from './host/scope.js';
import { createBackup } from './host/backup.js';
import { createSchedule } from './host/schedule.js';
import { createRestoreEngine } from './host/restore.js';
import { createSyncTools } from './host/sync-tools.js';
import { createRoutes } from './host/routes.js';
import { platformInfo } from './host/platform.js';
import { loadNativeConfig } from './host/native/config.js';

export const name = 'dsh-maintenance-backup';

/** 浏览器 HTTP 载体：Web GUI 路由与页面都由它提供。 */
export const inject = ['webServer'];

export function apply(ctx, config = {}) {
  const core = createCore(ctx);
  const quark = createQuark(core);
  const platform = platformInfo();
  core.log(`平台: ${platform.label}；Node: ${platform.node.source}；tar: ${platform.tar}`);
  const syncTools = createSyncTools(core);
  syncTools.ensure();

  /** @type {ReturnType<typeof createSchedule>} */
  let schedule;
  const backup = createBackup(core, quark);

  schedule = createSchedule({
    core,
    ctx,
    getConfig: () => config,
    onBackup: ({ trigger }) => {
      if (core.isBusy()) return;
      void backup.start({ force: false, trigger, keep: schedule.keep() });
    },
  });

  const scope = createScope(core, { getKeep: () => schedule.keep() });

  const restore = createRestoreEngine({
    core,
    quark,
    logger: (message, level) => core.log(message, level),
    // 还原目标按当前 config.sh 的 src→dest 映射解析（避免把 workspace/plugins 放到错误目录）
    resolveSources: async () => {
      const report = await scope.get();
      return report.entries.map((entry) => ({ src: entry.src, dest: entry.dest }));
    },
    // 快照目录 / 归档目录与备份上传目录同源（~/.dsh-sync 配置）
    resolveFolders: async () => {
      const config = await loadNativeConfig(core);
      return { dshFid: config.dshFid, archiveFid: config.archiveFid };
    },
  });

  const routes = createRoutes({ core, quark, scope, backup, schedule, restore, syncTools, ctx, config });

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    core.log(`已挂载 ${routes.length} 个本地接口`);
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, 'dsh-maintenance-backup: routes');

  // 启动收尾：上次还原是否已完成 / 中断，清理 staging 并写回面板状态
  void (async () => {
    try {
      const outcome = await restore.finalizeOnStartup();
      if (outcome?.result) {
        core.log(`上次还原收尾完成: ${JSON.stringify(outcome.result).slice(0, 300)}`);
      }
    } catch (error) {
      core.log(`还原收尾失败: ${error?.message || error}`, 'warn');
    }
  })();

  schedule.start();

  const launchdPlist = join(core.paths.home, 'Library', 'LaunchAgents', 'com.aesc.dsh-sync.plist');
  if (core.pathExists(launchdPlist)) {
    core.log('检测到 launchd 任务 com.aesc.dsh-sync 仍存在，请按 README 卸载，避免与插件定时重复', 'warn');
  }

  ctx.effect(
    () => () => {
      schedule.dispose();
      backup.dispose();
    },
    'dsh-maintenance-backup: timers',
  );
}
