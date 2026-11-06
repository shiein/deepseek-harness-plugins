/**
 * 原生备份引擎 —— 备份范围报告（纯 Node，替代 ~/.dsh-sync/scope.sh）。
 *
 * 输出与旧 `scope.sh` / `scope-report.cjs` 同构（字段见 docs/CONTRACT.md Scope），
 * 统计时应用 excludes 与 pruneAbs，标注 exists / readable / warning / discovered / disabled。
 * 性能：profiles 下的 node_modules（286MB）被 excludes 剪枝，实际只遍历约 4.5k 个文件。
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { compileExcludes } from '../mirror.js';
import { PLATFORM, homeDirectory } from '../platform.js';
import { pruneExcludesFor } from './config.js';

const MAX_FILES = 200000;
const MAX_DEPTH = 40;

const NOTES = [
  '扩展名 .log/.tmp、node_modules、.git、.DS_Store、.turbo 不会进入快照。',
  '云端只保留最新 KEEP 份 tar.gz，超出的连同 sidecar 清单一并移入 dsh/_archive；夸克 CLI 没有删除能力，_archive 需在夸克 App 内手动清空。',
  '还原后若插件工程被覆盖，需要在对应目录执行 pnpm install 重装 node_modules。',
  '配置中的 link:/Users/<用户名>/... 是绝对路径，换机还原后需要核对。',
];

/**
 * 读取目录树统计文件数与字节数（不跟随符号链接）。
 * @param {string} root
 * @param {(relativePath: string) => boolean} isExcluded
 */
async function inspectTree(root, isExcluded) {
  let files = 0;
  let bytes = 0;
  let depthWarnings = 0;
  /** @type {Array<{dir:string, rel:string, depth:number}>} */
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length > 0 && files < MAX_FILES) {
    const current = stack.pop();
    let list;
    try {
      list = await readdir(current.dir, { withFileTypes: true });
    } catch {
      depthWarnings += 1;
      continue;
    }
    for (const item of list) {
      if (files >= MAX_FILES) break;
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
      if (isExcluded(rel)) continue;
      const abs = join(current.dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (current.depth < MAX_DEPTH) stack.push({ dir: abs, rel, depth: current.depth + 1 });
        continue;
      }
      if (!item.isFile()) continue;
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      files += 1;
      bytes += info.size;
    }
  }
  return { files, bytes, depthWarnings };
}

/**
 * @param {string} src
 * @param {(relativePath: string) => boolean} isExcluded
 */
async function inspectEntry(src, isExcluded) {
  let dirInfo;
  try {
    dirInfo = await stat(src);
  } catch {
    return { exists: false, readable: false, files: 0, bytes: 0, warning: '路径不存在' };
  }
  if (!dirInfo.isDirectory()) {
    return { exists: true, readable: false, files: 0, bytes: 0, warning: '不是目录' };
  }
  try {
    await readdir(src);
  } catch {
    return {
      exists: true,
      readable: false,
      files: 0,
      bytes: 0,
      warning: '无读取权限（插件运行在 DSH 进程内，正常应可读）',
    };
  }
  const stats = await inspectTree(src, isExcluded);
  return {
    exists: true,
    readable: true,
    files: stats.files,
    bytes: stats.bytes,
    warning: stats.depthWarnings > 0 ? `${stats.depthWarnings} 个子目录读取失败` : null,
  };
}

/**
 * 与旧 scope-report.cjs 相同的"被排除项"展示列表。
 * @param {{ excludes: string[], pruneAbs: string[], home: string, dshHome: string }} options
 */
function buildExcludedList(options) {
  /** @type {Array<{path:string, reason:string}>} */
  const excluded = [];
  for (const target of options.pruneAbs) {
    excluded.push({ path: target, reason: '运行时状态目录（整体排除，避免上传触发自身变化）' });
  }
  for (const pattern of options.excludes) {
    excluded.push({ path: pattern, reason: '通用忽略规则' });
  }
  excluded.push({ path: join(options.dshHome, '.credentials.yaml'), reason: 'API 密钥，永不备份' });
  for (const runtime of ['sessions', 'attachments', 'storages', 'cache', 'page-preview', 'dsh-runtimes']) {
    excluded.push({ path: join(options.home, '.dsh', runtime), reason: 'DSH 运行态，不在备份范围' });
  }
  return excluded;
}

/**
 * 生成备份范围报告。
 *
 * @param {{
 *   core?: ReturnType<import('../core.js').createCore>,
 *   config: Awaited<ReturnType<import('./config.js').loadNativeConfig>>,
 *   keep?: number,
 *   platform?: NodeJS.Platform,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   generatedAt: number,
 *   keep: number,
 *   dshFid: string,
 *   archiveFid: string,
 *   entries: Array<{src:string,dest:string,label:string,exists:boolean,readable:boolean,files:number,bytes:number,discovered:boolean,disabled:boolean,warning:string|null}>,
 *   excluded: Array<{path:string,reason:string}>,
 *   notes: string[],
 *   totals: {files:number,bytes:number,enabledEntries:number},
 *   source: string,
 * }>}
 */
export async function buildScopeReport({ core, config, keep, platform } = {}) {
  const source = config?.source || 'defaults';
  const entriesConfig = Array.isArray(config?.entries) ? config.entries : [];
  const excludes = Array.isArray(config?.excludes) ? config.excludes : [];
  const pruneAbs = Array.isArray(config?.pruneAbs) ? config.pruneAbs : [];
  const disabledSet = new Set(
    (Array.isArray(config?.disabledEntries) ? config.disabledEntries : []).filter((item) => typeof item === 'string'),
  );
  const paths = config?.paths || {};
  const home = paths.home || core?.paths?.home || homeDirectory();
  const dshHome = paths.dshHome || core?.paths?.dshHome || join(home, '.dsh');
  const platformValue = platform || paths.platform || PLATFORM;
  const keepValue = Math.min(10, Math.max(1, Math.trunc(Number(keep ?? config?.keep ?? 5)) || 5));

  /** @type {Array<Record<string, unknown>>} */
  const entries = [];
  const totals = { files: 0, bytes: 0, enabledEntries: 0 };

  for (const rawEntry of entriesConfig) {
    const src = String(rawEntry?.src || '');
    const dest = String(rawEntry?.dest || '');
    const disabled = disabledSet.has(src);
    const prune = pruneExcludesFor(src, pruneAbs, platformValue);
    const isExcluded = compileExcludes([...excludes, ...prune.excludes]);
    const stats = prune.whole
      ? { exists: true, readable: true, files: 0, bytes: 0, warning: '整棵目录被运行时排除规则跳过' }
      : await inspectEntry(src, isExcluded);
    const entry = {
      src,
      dest,
      label: basename(src) || src,
      exists: stats.exists,
      readable: stats.readable,
      files: stats.files,
      bytes: stats.bytes,
      discovered: Boolean(rawEntry?.discovered),
      disabled,
      warning: stats.warning,
    };
    entries.push(entry);
    if (!disabled) {
      totals.files += entry.files;
      totals.bytes += entry.bytes;
      if (entry.exists && entry.readable) totals.enabledEntries += 1;
    }
  }

  const generatedAt = typeof core?.now === 'function' ? core.now() : Date.now();
  return {
    ok: true,
    generatedAt,
    keep: keepValue,
    dshFid: String(config?.dshFid || ''),
    archiveFid: String(config?.archiveFid || ''),
    entries,
    excluded: buildExcludedList({ excludes, pruneAbs, home, dshHome }),
    notes: [...NOTES],
    totals,
    source,
  };
}
