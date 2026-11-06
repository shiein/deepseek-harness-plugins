/**
 * 备份任务编排（跨平台）。
 *
 * 实际流水线在 `host/native/backup.js`（纯 Node：指纹 → 打包 → 扫描 → 上传 → 滚动归档），
 * 不再依赖 bash / rsync / macOS 专有命令。这里负责：
 * - 全局互斥（backup/restore 共用锁）；
 * - 任务状态（阶段、进度、日志、结果）并持久化到 task.json；
 * - 取消（AbortController）。
 */

import { loadNativeConfig } from './native/config.js';
import { runNativeBackup } from './native/backup.js';

const STAGE_META = {
  prepare: { label: '准备', progress: 6 },
  pack: { label: '打包', progress: 30 },
  scan: { label: '敏感信息扫描', progress: 48 },
  upload: { label: '上传网盘', progress: 62 },
  archive: { label: '归档旧快照', progress: 88 },
  done: { label: '完成', progress: 100 },
  skip: { label: '无变更', progress: 100 },
  error: { label: '失败', progress: 100 },
};

const STAGE_ORDER = ['prepare', 'pack', 'scan', 'upload', 'archive', 'done'];

/**
 * @param {ReturnType<import('./core.js').createCore>} core
 * @param {ReturnType<import('./quark.js').createQuark>} quark
 */
export function createBackup(core, quark) {
  /** @type {{ task: object, controller: AbortController, cancelRequested: boolean }|null} */
  let running = null;
  let disposeRequested = false;

  function createTask(trigger, force) {
    return {
      id: core.uuid(),
      kind: 'backup',
      phase: 'running',
      stage: 'prepare',
      stageLabel: '准备',
      progress: 2,
      startedAt: core.now(),
      finishedAt: null,
      error: null,
      result: null,
      logTail: [],
      trigger: trigger || 'manual',
      force: Boolean(force),
      warnings: [],
      engine: 'native',
    };
  }

  function applyEvent(task, event) {
    if (!event || typeof event !== 'object') return false;
    let changed = false;
    const { stage, label, progress, line } = event;
    if (line) {
      task.logTail.push(String(line));
      if (task.logTail.length > 160) task.logTail.splice(0, task.logTail.length - 160);
      changed = true;
    }
    if (stage && STAGE_META[stage]) {
      const currentIndex = STAGE_ORDER.indexOf(task.stage);
      const nextIndex = STAGE_ORDER.indexOf(stage);
      // done/skip/error 总是允许；其他阶段不允许倒退
      if (nextIndex === -1 || nextIndex >= currentIndex || stage === 'done') {
        if (task.stage !== stage) changed = true;
        task.stage = stage;
        task.stageLabel = label || STAGE_META[stage].label;
      }
      const incoming =
        typeof progress === 'number' ? Math.round(progress) : STAGE_META[stage].progress;
      const next = Math.max(task.progress || 0, Math.min(100, incoming));
      if (next !== task.progress) changed = true;
      task.progress = next;
    }
    return changed;
  }

  function finishTask(task, patch) {
    Object.assign(task, patch);
    task.finishedAt = task.finishedAt || core.now();
    task.progress = 100;
    core.setTask(task);
    const success = task.phase === 'success';
    const skipped = task.phase === 'skipped';
    const lastBackup = {
      id: task.id,
      trigger: task.trigger,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      ok: success,
      skipped,
      snapshotName: task.result?.snapshotName || null,
      sizeMB: task.result?.sizeMB ?? null,
      archived: task.result?.archived || 0,
      durationMs: task.result?.durationMs || task.finishedAt - task.startedAt,
      partial: Boolean(task.result?.partial),
      error: task.error,
      stageLabel: task.stageLabel,
      engine: task.engine,
    };
    core.updateState({ lastBackup });
    core.log(
      `备份${success ? '成功' : skipped ? '跳过（无变更）' : '失败'}: ${
        task.result?.snapshotName || task.error || ''
      }`,
      task.phase === 'failed' ? 'error' : 'info',
    );
    core.releaseLock('backup');
  }

  async function runTask(task, options) {
    const controller = running?.controller;
    const onEvent = (event) => {
      const changed = applyEvent(task, event);
      if (!changed) return;
      // 进度持久化只是给面板看的；一次写盘失败（如 Windows 文件被占用）不能中断备份本身
      try {
        core.setTask(task);
      } catch (error) {
        core.log(`任务进度写盘失败（已忽略）: ${error?.message || error}`, 'warn');
      }
    };
    try {
      const config = await loadNativeConfig(core, { keep: options.keep });
      const result = await runNativeBackup({
        core,
        quark,
        config,
        keep: options.keep,
        force: options.force,
        trigger: options.trigger,
        signal: controller?.signal,
        onEvent,
      });
      if (result?.skipped) {
        task.result = {
          skipped: true,
          durationMs: result.durationMs ?? core.now() - task.startedAt,
          trigger: task.trigger,
          fileCount: result.fileCount ?? null,
        };
        task.warnings = result.warnings || task.warnings;
        finishTask(task, { phase: 'skipped', stage: 'skip', stageLabel: '无变更' });
      } else {
        task.result = {
          skipped: false,
          snapshotName: result.snapshotName || null,
          sizeMB: result.sizeMB ?? null,
          archived: result.archived || 0,
          partial: Boolean(result.partial),
          durationMs: result.durationMs ?? core.now() - task.startedAt,
          trigger: task.trigger,
          fileCount: result.fileCount ?? null,
          totalBytes: result.totalBytes ?? null,
          sidecarName: result.sidecarName || null,
        };
        task.warnings = result.warnings || task.warnings;
        finishTask(task, { phase: 'success', stage: 'done', stageLabel: '完成' });
      }
    } catch (error) {
      const cancelled = running?.cancelRequested || controller?.signal?.aborted || disposeRequested;
      task.error = cancelled ? '已取消' : String(error?.message || error);
      task.warnings = task.warnings || [];
      task.stage = 'error';
      task.stageLabel = cancelled ? '已取消' : '失败';
      task.finishedAt = core.now();
      task.progress = 100;
      core.setTask(task);
      core.updateState({
        lastBackup: {
          id: task.id,
          trigger: task.trigger,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          ok: false,
          skipped: false,
          error: task.error,
          stageLabel: task.stageLabel,
          engine: task.engine,
        },
      });
      core.log(`备份失败: ${task.error}`, 'error');
      core.releaseLock('backup');
    } finally {
      running = null;
    }
  }

  return {
    /**
     * @param {{force?: boolean, trigger?: string, keep?: number}} [options]
     */
    start(options = {}) {
      if (running) return Promise.resolve({ ok: false, busy: true, task: running.task });
      if (core.getLock()) return Promise.resolve({ ok: false, busy: true, task: core.getTask() });
      const lock = core.acquireLock('backup');
      if (!lock) return Promise.resolve({ ok: false, busy: true, task: core.getTask() });
      const task = createTask(options.trigger, options.force);
      const controller = new AbortController();
      running = { task, controller, cancelRequested: false };
      core.setTask(task);
      core.log(`开始备份（trigger=${task.trigger} force=${task.force}）`);
      // 后台执行，HTTP 立即返回任务
      void runTask(task, {
        force: Boolean(options.force),
        trigger: task.trigger,
        keep: options.keep || 5,
      });
      return Promise.resolve({ ok: true, task });
    },

    status() {
      if (running) return running.task;
      const task = core.getTask();
      if (task && task.kind === 'backup' && task.phase === 'running') {
        // 原生引擎在插件进程内运行；插件重载/进程退出后任务不可能继续
        task.phase = 'failed';
        task.error = '任务被中断（插件重载或进程退出）';
        task.stage = 'error';
        task.stageLabel = '已中断';
        task.finishedAt = task.finishedAt || core.now();
        core.setTask(task);
      }
      return task;
    },

    cancel() {
      if (!running) return { ok: false, error: '没有正在运行的备份' };
      running.cancelRequested = true;
      try {
        running.controller.abort();
      } catch {
        /* ignore */
      }
      return { ok: true, task: running.task };
    },

    last() {
      return core.getState().lastBackup || null;
    },

    /** 插件卸载 / 重载：取消进行中的原生任务（不会留下孤儿进程）。 */
    dispose() {
      disposeRequested = true;
      if (running) {
        try {
          running.cancelRequested = true;
          running.controller.abort();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
