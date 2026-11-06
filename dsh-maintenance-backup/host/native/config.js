/**
 * 原生备份引擎 —— 同步配置解析（跨平台，不依赖 bash）。
 *
 * 唯一事实来源的优先级（与 docs/WINDOWS-PORT.md 一致）：
 *   1. `~/.dsh-sync/config.json`（便携配置，Windows 推荐）；
 *   2. 否则解析 `~/.dsh-sync/config.sh`（macOS 现状，兼容原有自定义）；
 *   3. 否则内置默认条目（与当前 config.sh 相同的 11 项，Windows 首次运行即用）。
 *
 * 无论来源如何，都会合并 `~/.dsh/profiles/<profile>/package.json` 里
 * `link:` / `file:` 的本地插件（dest = `workspace/<basename>`，父目录已覆盖则跳过）。
 * 解析/读取失败只写 warning 并回退默认值，绝不让备份因为配置问题崩溃。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PLATFORM, homeDirectory, pathInside } from '../platform.js';

/** 夸克网盘 / dsh 目录 FID（与 ~/.dsh-sync/config.sh 一致，允许环境变量覆盖）。 */
const DEFAULT_DSH_FID = '210e76226f274d749cfc712725c72c68';
/** 夸克网盘 / dsh/_archive 归档目录 FID。 */
const DEFAULT_ARCHIVE_FID = 'e3462aa31eb849dca82a96d8153dc41e';
const DEFAULT_KEEP = 5;
const KEEP_MIN = 1;
const KEEP_MAX = 10;

/** 通用排除规则（rsync 与指纹计算共用，与 config.sh 一致）。 */
export const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store', '.turbo', '*.log', '*.tmp'];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const MIN_LOCAL_SPEC_PREFIXES = ['link:', 'file:'];

/**
 * 判断"绝对路径"：除主机语义外，也接受 Windows 盘符/UNC 形式，
 * 便于在 macOS 上做 Windows 配置模拟（不落到 resolve(cwd)）。
 * @param {string} value
 */
function isAbsolutePath(value) {
  const text = String(value || '');
  return isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

/** @param {*} value */
function clampKeep(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_KEEP;
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, number));
}

/**
 * 安全的 warning 出口：core 可能是测试里的最小桩。
 * @param {{ log?: Function }|null|undefined} core
 * @param {string} message
 */
function warn(core, message) {
  try {
    core?.log?.(message, 'warn');
  } catch {
    /* 日志失败不影响配置解析 */
  }
}

/**
 * 展开配置里的 `$HOME` / `${HOME}` / `~`，不做任何 shell 求值。
 * @param {string} value
 * @param {string} home
 */
export function expandConfigPath(value, home) {
  if (typeof value !== 'string' || !value) return '';
  let text = value.trim();
  if (!text) return '';
  text = text.replace(/\$\{HOME\}/g, home);
  text = text.replace(/\$HOME(?![A-Za-z0-9_])/g, home);
  if (text === '~') text = home;
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = `${home}${text.slice(1)}`;
  return text;
}

/**
 * 统一包内路径：正斜杠、去掉首尾分隔符；空值兜底为 `workspace/<basename>`。
 * @param {string} dest
 * @param {string} src
 */
export function normalizeDestination(dest, src) {
  const text = String(dest || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (text) return text;
  const base = basename(String(src || ''));
  return base ? `workspace/${base}` : 'workspace';
}

/**
 * 把绝对路径展开成"包内相对 exclude"：
 * 若 pruneAbs 恰好等于条目根目录，返回 `{ whole: true }`（整条跳过）。
 * @param {string} src
 * @param {string[]} pruneAbs
 * @param {NodeJS.Platform} [platform]
 * @returns {{ whole: boolean, excludes: string[] }}
 */
export function pruneExcludesFor(src, pruneAbs, platform = PLATFORM) {
  /** @type {string[]} */
  const excludes = [];
  const entrySrc = String(src || '');
  if (!entrySrc) return { whole: false, excludes };
  for (const raw of Array.isArray(pruneAbs) ? pruneAbs : []) {
    const target = String(raw || '');
    if (!target) continue;
    if (!pathInside(entrySrc, target, platform)) continue;
    let relativePath = '';
    try {
      relativePath = relative(entrySrc, target);
    } catch {
      relativePath = '';
    }
    if (!relativePath || relativePath === '.') return { whole: true, excludes: [] };
    excludes.push(relativePath.split(sep).join('/'));
  }
  return { whole: false, excludes };
}

/**
 * 用于去重的路径键：Windows 大小写不敏感且统一正斜杠，POSIX 保持大小写。
 * @param {string} value
 * @param {NodeJS.Platform} platform
 */
function pathKey(value, platform) {
  const text = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * 默认 pruneAbs + 配置里的 pruneAbs 合并（按平台语义去重，默认项始终保留）。
 * @param {string[]} defaults
 * @param {string[]} configured
 * @param {NodeJS.Platform} platform
 */
function mergePruneAbs(defaults, configured, platform) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const target of [...defaults, ...configured]) {
    if (typeof target !== 'string' || !target) continue;
    const key = pathKey(target, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * 解析 config.json。
 * @param {string} file
 * @param {{ home: string, defaults: { entries: Array<{src:string,dest:string}>, pruneAbs: string[], excludes: string[], keep: number, dshFid: string, archiveFid: string }, addWarning: (message: string) => void }} context
 */
function parseConfigJsonFile(file, context) {
  const { home, defaults, addWarning } = context;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`config.json 不是合法 JSON（${error?.message || error}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('config.json 顶层必须是对象');
  }
  const rawEntries = data.entries;
  let entries;
  if (rawEntries === undefined) {
    entries = defaults.entries;
  } else if (!Array.isArray(rawEntries)) {
    throw new Error('config.json 的 entries 必须是数组');
  } else {
    entries = [];
    rawEntries.forEach((item, index) => {
      const parsed = normalizeEntry(item, { home, index });
      if (parsed) entries.push(parsed);
      else addWarning(`config.json 第 ${index + 1} 个条目无效，已忽略`);
    });
    if (entries.length === 0) throw new Error('config.json 的 entries 为空');
  }
  return {
    dshFid: normalizeFid(data.dshFid, defaults.dshFid),
    archiveFid: normalizeFid(data.archiveFid, defaults.archiveFid),
    keep: clampKeep(data.keep ?? defaults.keep),
    entries,
    pruneAbs: normalizePathList(data.pruneAbs, { home, fallback: defaults.pruneAbs }),
    excludes: normalizePatternList(data.excludes, defaults.excludes),
  };
}

/** @param {unknown} value @param {string} fallback */
function normalizeFid(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

/**
 * @param {unknown} list
 * @param {{ home: string, fallback: string[] }} options
 */
function normalizePathList(list, options) {
  if (!Array.isArray(list)) return [...options.fallback];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const expanded = expandConfigPath(item, options.home);
    if (!expanded) continue;
    const absolute = isAbsolutePath(expanded) ? expanded : resolve(options.home, expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out.length > 0 ? out : [...options.fallback];
}

/** @param {unknown} list @param {string[]} fallback */
function normalizePatternList(list, fallback) {
  if (!Array.isArray(list)) return [...fallback];
  const out = list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length > 0 ? out : [...fallback];
}

/**
 * 归一化一个条目（config.json 的 `{src,dest}` / `"src|dest"` 两种写法都接受）。
 * @param {unknown} item
 * @param {{ home: string, index: number }} options
 * @returns {{ src: string, dest: string }|null}
 */
function normalizeEntry(item, options) {
  let rawSrc = '';
  let rawDest = '';
  if (typeof item === 'string') {
    const separator = item.indexOf('|');
    rawSrc = separator >= 0 ? item.slice(0, separator) : item;
    rawDest = separator >= 0 ? item.slice(separator + 1) : '';
  } else if (item && typeof item === 'object' && !Array.isArray(item)) {
    rawSrc = typeof item.src === 'string' ? item.src : typeof item.source === 'string' ? item.source : '';
    rawDest = typeof item.dest === 'string' ? item.dest : typeof item.destination === 'string' ? item.destination : '';
  }
  const expanded = expandConfigPath(rawSrc, options.home);
  if (!expanded) return null;
  const absolute = isAbsolutePath(expanded) ? expanded : resolve(options.home, expanded);
  return { src: absolute, dest: normalizeDestination(rawDest, absolute) };
}

/** 去掉引号外注释，保留引号内 `#`。 @param {string} line */
function stripLineComment(line) {
  let out = '';
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\' && index + 1 < line.length) {
        out += line[index + 1];
        index += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

/** @param {string} text 去掉引号并处理 `\"`。 @returns {string} */
function parseScalarToken(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  let out = '';
  for (let index = 1; index < value.length; index += 1) {
    const ch = value[index];
    if (quote === '"' && ch === '\\' && index + 1 < value.length) {
      out += value[index + 1];
      index += 1;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  throw new Error('引号未闭合');
}

/** 找数组结尾的右括号（引号内不算）。 @param {string} text @returns {number} */
function findArrayClose(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ')') return index;
  }
  return -1;
}

/** 把数组内容切成 token（按空白分隔，支持单/双引号）。 @param {string} body */
function tokenizeArray(body) {
  /** @type {string[]} */
  const items = [];
  let token = '';
  let quote = '';
  const flush = () => {
    const value = token.trim();
    if (value) items.push(parseScalarToken(value));
    token = '';
  };
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (quote) {
      token += ch;
      if (quote === '"' && ch === '\\' && index + 1 < body.length) {
        token += body[index + 1];
        index += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    token += ch;
  }
  flush();
  return items;
}

/**
 * 行式解析 config.sh：只认 `NAME=value` / `NAME=( ... )`，不执行任何命令。
 * 支持多行数组、单双引号、行内注释。
 * @param {string} text
 * @returns {Record<string, string|string[]>}
 */
export function parseShellConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  /** @type {Record<string, string|string[]>} */
  const values = {};
  let index = 0;
  while (index < lines.length) {
    const cleaned = stripLineComment(lines[index]).trim();
    index += 1;
    if (!cleaned) continue;
    const match = cleaned.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const name = match[1];
    const rest = match[2].trim();
    if (!rest.startsWith('(')) {
      values[name] = parseScalarToken(rest);
      continue;
    }
    let body = rest.slice(1);
    let close = findArrayClose(body);
    let guard = 0;
    while (close < 0) {
      if (index >= lines.length || guard > 2000) {
        throw new Error(`${name} 数组缺少右括号`);
      }
      body += `\n${stripLineComment(lines[index])}`;
      index += 1;
      guard += 1;
      close = findArrayClose(body);
    }
    values[name] = tokenizeArray(body.slice(0, close));
  }
  return values;
}

/**
 * 解析 config.sh 文件。
 * @param {string} file
 * @param {{ home: string, defaults: { entries: Array<{src:string,dest:string}>, pruneAbs: string[], excludes: string[], keep: number, dshFid: string, archiveFid: string }, addWarning: (message: string) => void }} context
 */
function parseConfigShFile(file, context) {
  const { home, defaults, addWarning } = context;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 config.sh（${error?.message || error}）`);
  }
  const values = parseShellConfig(text);
  const rawEntries = values.SYNC_ENTRIES;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error('config.sh 中没有可用的 SYNC_ENTRIES 数组');
  }
  /** @type {Array<{src:string,dest:string}>} */
  const entries = [];
  for (const token of rawEntries) {
    const separator = token.indexOf('|');
    if (separator < 0) {
      addWarning(`config.sh 条目格式应为 "本地路径|包内路径"，已忽略：${token}`);
      continue;
    }
    const rawSrc = token.slice(0, separator);
    const rawDest = token.slice(separator + 1);
    const expanded = expandConfigPath(rawSrc, home);
    if (!expanded) continue;
    const absolute = isAbsolutePath(expanded) ? expanded : resolve(home, expanded);
    entries.push({ src: absolute, dest: normalizeDestination(rawDest, absolute) });
  }
  if (entries.length === 0) throw new Error('config.sh 的 SYNC_ENTRIES 全部无效');
  return {
    dshFid: normalizeFid(values.QUARK_DSH_FID, defaults.dshFid),
    archiveFid: normalizeFid(values.QUARK_ARCHIVE_FID, defaults.archiveFid),
    keep: clampKeep(values.KEEP ?? defaults.keep),
    entries,
    pruneAbs: normalizePathList(expandAll(values.PRUNE_ABS, home), { home, fallback: defaults.pruneAbs }),
    excludes: normalizePatternList(expandAll(values.EXCLUDES, home), defaults.excludes),
  };
}

/** @param {unknown} list @param {string} home */
function expandAll(list, home) {
  if (!Array.isArray(list)) return list;
  return list.map((item) => (typeof item === 'string' ? expandConfigPath(item, home) : item));
}

/** @param {{ home: string, dshHome: string, workspace: string, syncDir: string }} paths */
function defaultEntries(paths) {
  const { dshHome, workspace, syncDir } = paths;
  return [
    { src: join(dshHome, 'profiles'), dest: 'dsh-home/profiles' },
    { src: join(dshHome, 'skills'), dest: 'dsh-home/skills' },
    { src: join(dshHome, 'agent-assets'), dest: 'dsh-home/agent-assets' },
    { src: join(dshHome, 'plugins'), dest: 'dsh-home/plugins' },
    { src: join(dshHome, '.agent-presets'), dest: 'dsh-home/.agent-presets' },
    { src: join(dshHome, 'llm-deepseek'), dest: 'dsh-home/llm-deepseek' },
    { src: join(dshHome, 'dsh-claude-style'), dest: 'dsh-home/dsh-claude-style' },
    { src: join(workspace, 'dsh', 'plugins'), dest: 'workspace/plugins' },
    { src: join(workspace, 'dsh-page-preview'), dest: 'workspace/dsh-page-preview' },
    { src: join(workspace, 'overview', 'dsh-agent-usage'), dest: 'workspace/dsh-agent-usage' },
    { src: syncDir, dest: 'dsh-sync' },
  ];
}

/** @param {{ dshHome: string, syncDir: string }} paths */
function defaultPruneAbs(paths) {
  const skillDir = join(paths.dshHome, 'skills', 'quarkclouddrive');
  return [join(skillDir, 'deepseek'), join(skillDir, 'browse'), join(paths.syncDir, 'state'), join(paths.syncDir, 'logs')];
}

/**
 * 从 profiles 下各 profile 的 package.json 里的 link:/file: 依赖发现本地插件目录。
 * @param {{ dshHome: string, home: string, platform: NodeJS.Platform, entries: Array<{src:string,dest:string,discovered:boolean}>, addWarning: (message: string) => void }} context
 */
function discoverLinkedEntries(context) {
  const { dshHome, home, platform, entries } = context;
  const profilesDir = join(dshHome, 'profiles');
  let dirs = [];
  try {
    dirs = readdirSync(profilesDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return;
  }
  for (const dirName of dirs) {
    const packageFile = join(profilesDir, dirName, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object') continue;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const spec of Object.values(deps)) {
        if (typeof spec !== 'string') continue;
        const prefix = MIN_LOCAL_SPEC_PREFIXES.find((item) => spec.startsWith(item));
        if (!prefix) continue;
        const rawTarget = spec.slice(prefix.length).trim();
        if (!rawTarget) continue;
        const expanded = expandConfigPath(rawTarget, home);
        if (!expanded) continue;
        const target = isAbsolutePath(expanded) ? expanded : resolve(profilesDir, dirName, expanded);
        if (!isDirectory(target)) continue;
        // 与 sync.sh 相同的去重：已存在，或已被父级条目覆盖
        const covered = entries.some((entry) => {
          if (entry.src === target) return true;
          return pathInside(entry.src, target, platform);
        });
        if (covered) continue;
        entries.push({ src: target, dest: normalizeDestination('', target), discovered: true });
      }
    }
  }
}

/** @param {string} target */
function isDirectory(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 加载同步配置。
 *
 * @param {ReturnType<import('../core.js').createCore>} core
 * @param {{
 *   platform?: NodeJS.Platform,
 *   keep?: number,
 *   home?: string,
 *   workspace?: string,
 *   dshHome?: string,
 *   syncDir?: string,
 * }} [options] 测试注入：平台与各根目录
 * @returns {Promise<{
 *   source: 'config.json'|'config.sh'|'defaults',
 *   dshFid: string,
 *   archiveFid: string,
 *   keep: number,
 *   entries: Array<{src:string,dest:string,discovered:boolean}>,
 *   pruneAbs: string[],
 *   excludes: string[],
 *   disabledEntries: string[],
 *   warnings: string[],
 *   paths: { home: string, dshHome: string, workspace: string, syncDir: string, platform: NodeJS.Platform, configFile: string, configShFile: string },
 * }>}
 */
export async function loadNativeConfig(core, options = {}) {
  const platform = options.platform || PLATFORM;
  const corePaths = core?.paths || {};
  const explicitHome = options.home !== undefined;
  const home = options.home ?? corePaths.home ?? homeDirectory();
  const dshHome =
    options.dshHome ?? (explicitHome ? join(home, '.dsh') : corePaths.dshHome) ?? join(home, '.dsh');
  const workspace =
    options.workspace ?? (explicitHome ? join(home, 'Documents', 'workspace') : corePaths.workspace) ??
    join(home, 'Documents', 'workspace');
  const syncDir =
    options.syncDir ?? (explicitHome ? join(home, '.dsh-sync') : corePaths.syncDir) ?? join(home, '.dsh-sync');

  const paths = { home, dshHome, workspace, syncDir, platform };
  const defaults = {
    dshFid: process.env.DSH_SYNC_DSH_FID || DEFAULT_DSH_FID,
    archiveFid: process.env.DSH_SYNC_ARCHIVE_FID || DEFAULT_ARCHIVE_FID,
    keep: DEFAULT_KEEP,
    entries: defaultEntries(paths),
    pruneAbs: defaultPruneAbs(paths),
    excludes: [...DEFAULT_EXCLUDES],
  };
  const configFile = join(syncDir, 'config.json');
  const configShFile = join(syncDir, 'config.sh');

  /** @type {string[]} */
  const warnings = [];
  const addWarning = (message) => {
    warnings.push(message);
    warn(core, message);
  };
  const context = { home, defaults, addWarning };

  let source = 'defaults';
  let loaded;
  try {
    if (existsSync(configFile)) {
      loaded = parseConfigJsonFile(configFile, context);
      source = 'config.json';
    } else if (existsSync(configShFile)) {
      loaded = parseConfigShFile(configShFile, context);
      source = 'config.sh';
    } else {
      loaded = defaults;
      source = 'defaults';
    }
  } catch (error) {
    addWarning(`同步配置解析失败，已回退内置默认配置：${error?.message || error}`);
    loaded = defaults;
    source = 'defaults';
  }

  /** @type {Array<{src:string,dest:string,discovered:boolean}>} */
  const entries = (Array.isArray(loaded.entries) ? loaded.entries : defaults.entries).map((entry) => ({
    src: entry.src,
    dest: normalizeDestination(entry.dest, entry.src),
    discovered: Boolean(entry.discovered),
  }));

  discoverLinkedEntries({ dshHome, home, platform, entries, addWarning });

  const disabled = core?.getState?.()?.disabledEntries;
  const disabledEntries = (Array.isArray(disabled) ? disabled : []).filter((item) => typeof item === 'string' && item);

  return {
    source,
    dshFid: normalizeFid(loaded.dshFid, defaults.dshFid),
    archiveFid: normalizeFid(loaded.archiveFid, defaults.archiveFid),
    keep: clampKeep(options.keep ?? loaded.keep ?? defaults.keep),
    entries,
    pruneAbs: mergePruneAbs(
      defaults.pruneAbs,
      Array.isArray(loaded.pruneAbs) ? loaded.pruneAbs : [],
      platform,
    ),
    excludes: Array.isArray(loaded.excludes) ? loaded.excludes : [...defaults.excludes],
    disabledEntries,
    warnings,
    paths: {
      home,
      dshHome,
      workspace,
      syncDir,
      platform,
      configFile,
      configShFile,
    },
  };
}
