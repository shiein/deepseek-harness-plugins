/**
 * 定时策略与文件监听。
 *
 * 策略事实来源：profile 的 cordis.patch.yml（通过 ctx.configEditor 写入覆盖层，因此策略
 * 本身也会进备份快照）；运行态副本落在 ~/.dsh-maintenance/state.json，用于面板即时展示
 * 与 configEditor 不可用时的降级。还原后重启时，patch 中的配置优先。
 */

import { watch } from 'node:fs';
import { join } from 'node:path';

import { IS_MACOS, IS_WINDOWS } from './platform.js';

const DEFAULT_SCHEDULE = {
  enabled: true,
  intervalMinutes: 60,
  keep: 5,
  watch: true,
  debounceSeconds: 60,
};

const ALLOWED_INTERVALS = [15, 60, 360, 1440];

/** @param {unknown} value */
function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

/** @param {Record<string, unknown>|null|undefined} raw */
export function normalizeSchedule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SCHEDULE.enabled,
    intervalMinutes: (() => {
      const minutes = toInt(source.intervalMinutes, DEFAULT_SCHEDULE.intervalMinutes);
      if (ALLOWED_INTERVALS.includes(minutes)) return minutes;
      return Math.max(5, Math.min(10080, minutes));
    })(),
    keep: Math.max(1, Math.min(10, toInt(source.keep, DEFAULT_SCHEDULE.keep))),
    watch: typeof source.watch === 'boolean' ? source.watch : DEFAULT_SCHEDULE.watch,
    debounceSeconds: Math.max(15, Math.min(3600, toInt(source.debounceSeconds, DEFAULT_SCHEDULE.debounceSeconds))),
  };
}

/**
 * @param {{
 *   core: ReturnType<import('./core.js').createCore>,
 *   ctx: any,
 *   getConfig: () => Record<string, unknown>,
 *   onBackup: (options: {trigger: string}) => void,
 * }} deps
 */
export function createSchedule({ core, ctx, getConfig, onBackup }) {
  const configSchedule = normalizeSchedule(getConfig()?.schedule);
  const configHasSchedule = Boolean(getConfig()?.schedule && typeof getConfig().schedule === 'object');
  let current = configHasSchedule
    ? configSchedule
    : normalizeSchedule(core.getState().schedule || DEFAULT_SCHEDULE);
  let source = configHasSchedule ? 'profile-patch' : core.getState().scheduleSource || 'local';
  let nextRunAt = null;
  let timer = null;
  let watchers = [];
  let debounceTimer = null;
  let suspendUntil = 0;
  let disposed = false;

  if (configHasSchedule) {
    core.updateState({ schedule: current, scheduleSource: 'profile-patch' });
  } else if (!core.getState().schedule) {
    core.updateState({ schedule: current, scheduleSource: 'local' });
  }

  function periodMs() {
    return Math.max(5, current.intervalMinutes) * 60 * 1000;
  }

  function publicSchedule() {
    return {
      ...current,
      persistedTo: source === 'profile-patch' ? 'profile-patch' : 'local',
      nextRunAt,
      allowedIntervals: ALLOWED_INTERVALS,
    };
  }

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function arm() {
    clearTimer();
    if (!current.enabled || disposed) {
      nextRunAt = null;
      return;
    }
    nextRunAt = core.now() + periodMs();
    timer = setInterval(() => {
      nextRunAt = core.now() + periodMs();
      if (disposed) return;
      if (core.isBusy()) return;
      onBackup({ trigger: 'schedule' });
    }, periodMs());
    if (typeof timer.unref === 'function') timer.unref();
  }

  function closeWatchers() {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    watchers = [];
  }

  /** 与 DEFAULT_EXCLUDES 一致：这些目录的变化不会进入快照，不应触发备份。 */
  const NOISE_SEGMENT = /(^|[\\/])(node_modules|\.git|\.turbo)([\\/]|$)/;

  function onFsEvent(_eventType, filename) {
    if (disposed || core.now() < suspendUntil) return;
    if (typeof filename === 'string' && filename !== '' && NOISE_SEGMENT.test(filename)) return;
    if (!current.enabled || !current.watch) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed || core.isBusy()) return;
      core.log('检测到文件变更，触发备份', 'info');
      onBackup({ trigger: 'watch' });
    }, Math.max(15, current.debounceSeconds) * 1000);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  function syncWatchers() {
    closeWatchers();
    if (!current.watch || disposed) return;
    const roots = [core.paths.workspace, join(core.paths.dshHome, 'profiles')];
    // Node 的递归 fs.watch 在 Windows/macOS 可用；Linux 上退化为非递归监听根目录
    const recursive = IS_WINDOWS || IS_MACOS;
    for (const root of roots) {
      try {
        const watcher = watch(root, { recursive }, onFsEvent);
        watcher.on('error', (error) => core.log(`文件监听失败(${root}): ${error?.message || error}`, 'warn'));
        watchers.push(watcher);
      } catch (error) {
        core.log(`无法监听 ${root}: ${error?.message || error}`, 'warn');
      }
    }
    if (watchers.length > 0) core.log(`已监听 ${watchers.length} 个目录（变更后 ${current.debounceSeconds}s 触发备份）`);
  }

  async function persistToPatch(next) {
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : null;
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') return false;
    const entries = editor.entries() || [];
    const entry = entries.find((item) => {
      if (!item) return false;
      const id = item.id ?? item.options?.id ?? item.patchId;
      const name = item.name ?? item.options?.name;
      return id === 'dsh-maintenance-backup' || name === '@local/dsh-maintenance-backup';
    });
    if (!entry) return false;
    await editor.edit(entry, (currentConfig) => ({ ...(currentConfig || {}), schedule: next }));
    return true;
  }

  return {
    get: publicSchedule,

    /** @param {Record<string, unknown>} patch */
    async update(patch) {
      const next = normalizeSchedule({ ...current, ...patch });
      current = next;
      core.updateState({ schedule: next, scheduleSource: source });
      core.writeJson(join(core.paths.dataDir, 'schedule.json'), next);
      arm();
      syncWatchers();
      let persisted = false;
      try {
        persisted = await persistToPatch(next);
      } catch (error) {
        core.log(`写入 profile 配置失败，策略仅保存在本地: ${error?.message || error}`, 'warn');
      }
      source = persisted ? 'profile-patch' : 'local';
      core.updateState({ scheduleSource: source });
      return publicSchedule();
    },

    start() {
      arm();
      syncWatchers();
      core.log(`定时备份${current.enabled ? `已启用（每 ${current.intervalMinutes} 分钟）` : '已停用'}，监听=${current.watch}`);
    },

    suspend(ms) {
      suspendUntil = core.now() + Math.max(0, Number(ms) || 0);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },

    dispose() {
      disposed = true;
      clearTimer();
      closeWatchers();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },

    keep() {
      return current.keep;
    },
  };
}
