/**
 * 跨平台目录镜像（替代 rsync -a --delete），用于还原 apply / rollback。
 *
 * - 只依赖 node:fs/promises，可在 macOS / Windows / Linux 上运行；
 * - 支持与原本 rsync 相同的 exclude 语义（名字、后缀、相对路径模式，含子树）；
 * - 复制文件/目录/符号链接，保留 mtime 与（POSIX）权限位；
 * - 删除目标目录中快照不存在的文件，但跳过被 exclude 的路径；
 * - Windows 上符号链接创建失败会记为 warning，不中断整体还原。
 */

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { IS_WINDOWS } from './platform.js';

/** @param {string} pattern */
function globToRegExp(pattern) {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * 把 rsync 风格 exclude 列表编译成 `(relativePath) => boolean`。
 * 规则：
 * - 含 `/` 的模式按相对路径匹配，也匹配其子树（`quarkclouddrive/deepseek`）；
 * - `*.log` 这类后缀匹配任意文件；
 * - 其他名字匹配任意路径段（`node_modules`、`.git`）。
 * @param {string[]} patterns
 */
export function compileExcludes(patterns = []) {
  const compiled = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalized = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) continue;
    if (normalized.includes('/')) {
      compiled.push({ kind: 'path', re: globToRegExp(normalized) });
    } else if (normalized.startsWith('*.')) {
      compiled.push({ kind: 'suffix', suffix: normalized.slice(1) });
    } else {
      compiled.push({ kind: 'segment', name: normalized });
    }
  }
  return (relativePath) => {
    const text = String(relativePath || '').split(sep).join('/');
    if (!text) return false;
    const segments = text.split('/');
    for (const item of compiled) {
      if (item.kind === 'suffix') {
        if (segments.some((segment) => segment.endsWith(item.suffix))) return true;
        continue;
      }
      if (item.kind === 'segment') {
        if (segments.includes(item.name)) return true;
        continue;
      }
      for (let length = 1; length <= segments.length; length += 1) {
        if (item.re.test(segments.slice(0, length).join('/'))) return true;
      }
    }
    return false;
  };
}

/** @param {string} path */
async function lstatSafe(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** @param {string} path */
async function removePath(path) {
  const info = await lstatSafe(path);
  if (!info) return;
  if (info.isDirectory()) {
    await rmdir(path).catch(async () => {
      // 非空目录（并发写入等）时递归删除
      const { rm } = await import('node:fs/promises');
      await rm(path, { recursive: true, force: true });
    });
    return;
  }
  await unlink(path).catch(() => {});
}

/**
 * 遍历目录，返回相对路径 -> 条目信息；不跟随符号链接。
 * @param {string} root
 * @param {(relativePath: string) => boolean} isExcluded
 */
async function collectTree(root, isExcluded) {
  /** @type {Map<string, {type:'file'|'dir'|'symlink', size:number, mtimeMs:number, atimeMs:number, mode:number}>} */
  const entries = new Map();
  /** @type {Array<{dir:string, rel:string, depth:number}>} */
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    let list;
    try {
      list = await readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      if (current.depth === 0) throw new Error(`无法读取目录 ${current.dir}: ${error?.message || error}`);
      continue;
    }
    for (const item of list) {
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
      if (isExcluded(rel)) continue;
      const abs = join(current.dir, item.name);
      let info;
      try {
        info = await lstat(abs);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        entries.set(rel, { type: 'symlink', size: 0, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, mode: info.mode });
      } else if (info.isDirectory()) {
        if (current.depth < 80) stack.push({ dir: abs, rel, depth: current.depth + 1 });
        entries.set(rel, { type: 'dir', size: 0, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, mode: info.mode });
      } else if (info.isFile()) {
        entries.set(rel, { type: 'file', size: info.size, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, mode: info.mode });
      }
    }
  }
  return entries;
}

/**
 * 把 source 目录镜像到 target：
 * - 复制 source 中（未被 exclude 的）所有文件/目录/符号链接；
 * - 删除 target 中 source 不存在的文件/目录（被 exclude 的保留）；
 * - source 不存在时抛错，由调用方决定是否跳过。
 *
 * @param {{
 *   source: string,
 *   target: string,
 *   excludes?: string[],
 *   signal?: AbortSignal,
 *   onLog?: (message: string, level?: string) => void,
 *   onProgress?: (info: { files: number, bytes: number }) => void,
 * }} input
 */
export async function mirrorDirectory(input) {
  const { source, target, excludes = [], signal, onLog, onProgress } = input;
  const isExcluded = compileExcludes(excludes);
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  const sourceInfo = await stat(sourceRoot).catch(() => null);
  if (!sourceInfo || !sourceInfo.isDirectory()) {
    throw new Error(`源目录不存在或不是目录：${sourceRoot}`);
  }

  const sourceEntries = await collectTree(sourceRoot, isExcluded);
  /** @type {Array<{scope:'file'|'dir'|'symlink', rel:string, message:string}>} */
  const warnings = [];
  /** @type {Array<{scope:string, rel:string, message:string}>} */
  const errors = [];
  let copiedFiles = 0;
  let copiedBytes = 0;

  await mkdir(targetRoot, { recursive: true });

  // 先建目录，再复制文件/链接（保证空目录也存在）
  const dirs = [...sourceEntries.entries()]
    .filter(([, info]) => info.type === 'dir')
    .map(([rel]) => rel)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const rel of dirs) {
    if (signal?.aborted) throw new Error('已取消');
    const abs = join(targetRoot, rel);
    const existing = await lstatSafe(abs);
    try {
      if (existing && !existing.isDirectory()) await removePath(abs);
      await mkdir(abs, { recursive: true });
    } catch (error) {
      errors.push({ scope: 'dir', rel, message: String(error?.message || error) });
    }
  }

  for (const [rel, info] of sourceEntries) {
    if (info.type === 'dir') continue;
    if (signal?.aborted) throw new Error('已取消');
    const sourceAbs = join(sourceRoot, rel);
    const targetAbs = join(targetRoot, rel);
    const existing = await lstatSafe(targetAbs);
    try {
      if (existing) {
        // 目标不是普通文件（目录 / 符号链接 / 其他）时先移除：copyFile 会跟随符号链接，
        // 直接覆盖会把快照内容写到链接指向的、目标目录以外的文件。
        if (info.type === 'file' && !existing.isFile()) await removePath(targetAbs);
        else if (info.type === 'symlink' && !existing.isSymbolicLink()) await removePath(targetAbs);
      }
      await mkdir(dirname(targetAbs), { recursive: true });
      if (info.type === 'file') {
        await copyFile(sourceAbs, targetAbs);
        try {
          await utimes(targetAbs, info.atimeMs / 1000, info.mtimeMs / 1000);
        } catch {
          /* 某些文件系统不支持改时间 */
        }
        if (!IS_WINDOWS) {
          try {
            await chmod(targetAbs, info.mode & 0o777);
          } catch {
            /* ignore */
          }
        }
        copiedFiles += 1;
        copiedBytes += info.size;
        if (copiedFiles % 200 === 0) onProgress?.({ files: copiedFiles, bytes: copiedBytes });
      } else {
        if (existing) await removePath(targetAbs);
        const linkTarget = await readlink(sourceAbs);
        try {
          await symlink(linkTarget, targetAbs, IS_WINDOWS ? 'junction' : undefined);
        } catch (error) {
          warnings.push({ scope: 'symlink', rel, message: `创建符号链接失败：${error?.message || error}` });
        }
      }
    } catch (error) {
      errors.push({ scope: info.type, rel, message: String(error?.message || error) });
    }
  }

  // 删除 target 中 source 不存在的条目
  let removed = 0;
  /** @param {string} dir @param {string} relPrefix */
  const prune = async (dir, relPrefix) => {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list) {
      if (signal?.aborted) throw new Error('已取消');
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (isExcluded(rel)) continue;
      const abs = join(dir, item.name);
      if (sourceEntries.has(rel)) {
        if (item.isDirectory()) await prune(abs, rel);
        continue;
      }
      try {
        if (item.isDirectory()) {
          // 先递归清理；若目录里还有被 exclude 的受保护子树（如 sessions/），保留目录骨架
          await prune(abs, rel);
          const remaining = await readdir(abs);
          if (remaining.length === 0) {
            await rmdir(abs);
            removed += 1;
          }
        } else {
          await removePath(abs);
          removed += 1;
        }
      } catch (error) {
        errors.push({ scope: 'delete', rel, message: String(error?.message || error) });
      }
    }
  };
  await prune(targetRoot, '');

  onProgress?.({ files: copiedFiles, bytes: copiedBytes });
  return {
    files: copiedFiles,
    bytes: copiedBytes,
    removed,
    warnings,
    errors,
    sourceEntries: sourceEntries.size,
  };
}

/**
 * 只统计目录（不复制），用于安全副本/差异展示。
 * @param {string} root
 * @param {string[]} excludes
 */
export async function summarizeTree(root, excludes = []) {
  const isExcluded = compileExcludes(excludes);
  const entries = await collectTree(resolve(root), isExcluded);
  let files = 0;
  let bytes = 0;
  for (const info of entries.values()) {
    if (info.type !== 'file') continue;
    files += 1;
    bytes += info.size;
  }
  return { files, bytes, entries: entries.size };
}
