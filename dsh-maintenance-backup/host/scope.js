/**
 * 备份范围（跨平台，纯 Node）。
 *
 * 使用 host/native/config.js 解析与备份引擎完全相同的配置，再用 host/native/scope.js
 * 统计文件数/大小/可读性，保证「面板显示的范围」与「实际打包的范围」一致。
 * 面板里禁用的条目写入插件运行态；备份引擎直接读取同一份状态。
 */

import { join } from 'node:path';

import { loadNativeConfig } from './native/config.js';
import { buildScopeReport } from './native/scope.js';

const CACHE_MS = 20000;

/**
 * @param {ReturnType<import('./core.js').createCore>} core
 * @param {{ getKeep: () => number }} options
 */
export function createScope(core, options) {
  let cache = null;
  let inflight = null;

  function disabledFilePath() {
    return join(core.paths.dataDir, 'disabled-entries.json');
  }

  /** 把当前禁用条目写成 JSON 文件（供旧 sync.sh/scope.sh 用户共用），返回路径。 */
  function syncDisabledFile() {
    const list = Array.isArray(core.getState().disabledEntries) ? core.getState().disabledEntries : [];
    const file = disabledFilePath();
    core.writeJson(file, list);
    return file;
  }

  async function collect() {
    const keep = Math.max(1, Math.min(20, Number(options.getKeep()) || 5));
    const config = await loadNativeConfig(core, { keep });
    const report = await buildScopeReport({
      core,
      config: { ...config, keep },
      keep,
      platform: core.platform,
    });
    report.disabledEntries = Array.isArray(core.getState().disabledEntries)
      ? core.getState().disabledEntries
      : [];
    cache = { at: core.now(), report };
    core.updateState({
      lastScopeSummary: {
        files: report.totals.files,
        bytes: report.totals.bytes,
        entries: report.entries.length,
        at: cache.at,
        source: report.source || null,
      },
    });
    return report;
  }

  async function get({ refresh = false } = {}) {
    if (!refresh && cache && core.now() - cache.at < CACHE_MS) return cache.report;
    if (inflight) return inflight;
    inflight = collect().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    disabledFilePath,
    syncDisabledFile,
    get,

    async setEnabled(src, enabled) {
      const state = core.getState();
      const set = new Set(Array.isArray(state.disabledEntries) ? state.disabledEntries : []);
      const previous = [...set];
      if (enabled) set.delete(src);
      else set.add(src);
      core.updateState({ disabledEntries: [...set] });
      cache = null;
      syncDisabledFile();
      try {
        return { ok: true, scope: await get({ refresh: true }) };
      } catch (error) {
        core.updateState({ disabledEntries: previous });
        syncDisabledFile();
        throw error;
      }
    },

    invalidate() {
      cache = null;
    },
  };
}
