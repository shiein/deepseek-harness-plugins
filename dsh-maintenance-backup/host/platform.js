/**
 * 跨平台运行环境适配（macOS / Windows / Linux）。
 *
 * - 路径默认值（Windows 的 Documents 可能被 OneDrive 重定向）；
 * - Node / tar / bash 可执行文件解析（DSH Windows 上没有系统 node、但有 Electron Node-mode）；
 * - 子进程环境（PATH 分隔符、HOME/USERPROFILE、ELECTRON_RUN_AS_NODE）；
 * - 跨平台路径包含判断（Windows 盘符 + 大小写不敏感）。
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep, win32 } from 'node:path';

export const PLATFORM = process.platform;
export const IS_WINDOWS = PLATFORM === 'win32';
export const IS_MACOS = PLATFORM === 'darwin';
export const PATH_SEPARATOR = IS_WINDOWS ? '\\' : '/';

/** @returns {string} */
export function homeDirectory() {
  try {
    return homedir();
  } catch {
    return IS_WINDOWS ? process.env.USERPROFILE || 'C:\\Users\\Public' : process.env.HOME || '/tmp';
  }
}

/** 默认 DSH_HOME。 */
export function defaultDshHome(home = homeDirectory()) {
  return process.env.DSH_HOME || join(home, '.dsh');
}

/**
 * 默认工作区目录。Windows 上优先使用已存在的 `%USERPROFILE%\Documents\workspace`，
 * 其次 OneDrive 重定向后的 Documents，最后退回默认路径（用户可用 DSH_WORKSPACE_DIR 覆盖）。
 * @param {string} home
 */
export function defaultWorkspaceDir(home = homeDirectory(), options = {}) {
  const windows = (options.platform || PLATFORM) === 'win32';
  if (process.env.DSH_WORKSPACE_DIR) return process.env.DSH_WORKSPACE_DIR;
  const candidates = [join(home, 'Documents', 'workspace')];
  if (windows) {
    for (const envName of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = process.env[envName];
      if (root) candidates.push(join(root, 'Documents', 'workspace'));
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

/** 默认同步脚本目录。 */
export function defaultSyncDir(home = homeDirectory()) {
  return process.env.DSH_SYNC_DIR || join(home, '.dsh-sync');
}

/** @param {string} command @param {string|undefined} pathValue */
function findOnPath(command, pathValue) {
  const pathText = pathValue || '';
  for (const dir of pathText.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 解析运行 Node 脚本的方式。
 *
 * DSH Desktop 的 Host 进程本身是 Electron（Node mode）。Windows 上不一定有独立的 `node`，
 * 因此依次尝试：
 *   1. DSH_DESKTOP_NODE_EXECUTABLE（DSH 自己给 pnpm 用的运行时 node）
 *   2. DSH_NODE_EXECUTABLE
 *   3. PATH 上的 node
 *   4. 当前 Electron 可执行文件 + ELECTRON_RUN_AS_NODE=1
 *   5. PATH 上的 node.exe（最后兜底）
 *
 * @returns {{ command: string, env: Record<string,string>, source: string }}
 */
export function resolveNodeCommand(env = process.env) {
  const explicit = env.DSH_DESKTOP_NODE_EXECUTABLE || env.DSH_NODE_EXECUTABLE;
  if (explicit && existsSync(explicit)) {
    return { command: explicit, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'env-node' };
  }
  const onPath = findOnPath(IS_WINDOWS ? 'node.exe' : 'node', env.PATH || env.Path);
  if (onPath) {
    return { command: onPath, env: {}, source: 'path' };
  }
  if (process.versions.electron) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'electron-node-mode' };
  }
  return { command: IS_WINDOWS ? 'node.exe' : 'node', env: {}, source: 'fallback' };
}

/**
 * 解析 tar：macOS/Linux 用系统 tar；Windows 10 1803+ 自带 System32\tar.exe（bsdtar）。
 * 可用 DSH_MAINTENANCE_TAR 覆盖。
 */
export function resolveTarCommand(env = process.env) {
  if (env.DSH_MAINTENANCE_TAR) return env.DSH_MAINTENANCE_TAR;
  if (IS_WINDOWS) {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    const candidate = join(systemRoot, 'System32', 'tar.exe');
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
    return 'tar.exe';
  }
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return 'tar';
}

/** POSIX 上的 bash（用于可选的 sync.sh 引擎）；Windows 返回 null。 */
export function resolveBashCommand(env = process.env) {
  if (IS_WINDOWS) return null;
  if (env.DSH_MAINTENANCE_BASH) return env.DSH_MAINTENANCE_BASH;
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  const onPath = findOnPath('bash', env.PATH);
  return onPath || null;
}

/**
 * 平台相关的子进程环境：补齐 HOME/USERPROFILE、规范化 PATH、注入 Node 运行时变量。
 * @param {Record<string,string|undefined>} baseEnv
 * @param {{ home?: string, dshHome?: string, nodeEnv?: Record<string,string> }} [options]
 */
export function buildChildEnv(baseEnv = process.env, options = {}) {
  const windows = (options.platform || PLATFORM) === 'win32';
  const home = options.home || homeDirectory();
  const env = { ...baseEnv };
  env.HOME = home;
  if (windows) env.USERPROFILE = env.USERPROFILE || home;
  if (options.dshHome) env.DSH_HOME = options.dshHome;

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const joinPath = windows ? win32.join : join;
  const pathDelimiter = windows ? ';' : delimiter;
  const extraDirs = [];
  if (windows) {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    extraDirs.push(
      joinPath(systemRoot, 'System32'),
      joinPath(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    );
  } else {
    extraDirs.push(
      join(home, '.local', 'share', 'mise', 'shims'),
      join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
  }
  const merged = [...extraDirs, currentPath].filter(Boolean).join(pathDelimiter);
  env[pathKey] = merged;
  if (options.nodeEnv) Object.assign(env, options.nodeEnv);
  return env;
}

/** @param {string} value */
function stripTrailingSeparators(value) {
  if (!value) return value;
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  return value.replace(/[\\/]+$/, '');
}

/**
 * 判断 child 是否位于 parent 之下（跨平台：Windows 大小写不敏感、兼容正/反斜杠）。
 * @param {string} parent
 * @param {string} child
 * @param {'win32'|'darwin'|'linux'} [platform]
 */
export function pathInside(parent, child, platform = PLATFORM) {
  if (!parent || !child) return false;
  const windows = platform === 'win32';
  const normalize = (value) => {
    let text = resolve(value);
    if (windows) {
      text = text.replace(/\//g, '\\').toLowerCase();
    }
    return stripTrailingSeparators(text);
  };
  const parentText = normalize(parent);
  const childText = normalize(child);
  if (childText === parentText) return true;
  const separator = windows ? '\\' : sep;
  return childText.startsWith(parentText.endsWith(separator) ? parentText : `${parentText}${separator}`);
}

/** 展示用平台名称。 */
export function platformLabel() {
  if (IS_WINDOWS) return 'Windows';
  if (IS_MACOS) return 'macOS';
  return PLATFORM;
}

/** 诊断信息。 */
export function platformInfo() {
  const node = resolveNodeCommand();
  return {
    platform: PLATFORM,
    label: platformLabel(),
    home: homeDirectory(),
    workspace: defaultWorkspaceDir(),
    node: { command: node.command, source: node.source },
    tar: resolveTarCommand(),
    bash: resolveBashCommand(),
    pathSeparator: PATH_SEPARATOR,
  };
}
