/**
 * 网盘备份维护 —— 还原引擎（两阶段还原）。
 *
 * 阶段一 stage：把网盘快照下载到本地暂存区并解压、计算差异。**不修改任何本机还原目标**。
 * 阶段二 apply：先给将覆盖的本机目录做安全副本（tar.gz），再用纯 Node 的目录镜像逐目标应用；
 *              写入 restore/pending.json marker，由宿主重启后在 finalizeOnStartup 收尾。
 *
 * 跨平台（macOS / Windows / Linux）：只依赖 node 内置模块、core 与 quark；
 * tar 用 host/platform.js 的 resolveTarCommand()（Windows 上是 System32\tar.exe），
 * 目录同步用 host/mirror.js 的 mirrorDirectory()（替代 rsync，Windows 无 rsync）。
 * 不读 bash 配置，同步目录 FID 写死并允许环境变量覆盖。
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { mirrorDirectory } from './mirror.js';
import { pathInside, resolveTarCommand } from './platform.js';

/** 夸克网盘 / dsh 目录 FID（与 ~/.dsh-sync/config.sh 保持一致，允许环境变量覆盖）。 */
const DEFAULT_DSH_FID = '210e76226f274d749cfc712725c72c68';
/** 夸克网盘 / dsh/_archive 归档目录 FID（本模块只列 dsh/，归档目录仅用于说明）。 */
const DEFAULT_ARCHIVE_FID = 'e3462aa31eb849dca82a96d8153dc41e';

const SNAPSHOT_RE = /^dsh-snap-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.tar\.gz$/;
const SIDECAR_RE = /^dsh-snap-.+\.manifest\.json$/;
const SNAPSHOT_NAME_RE = /^dsh-snap-[A-Za-z0-9._-]+\.tar\.gz$/;
const STAGING_ID_RE = /^[A-Za-z0-9._-]+$/;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const SNAPSHOT_TTL_MS = 30 * 1000;
const SIDECAR_TTL_MS = 10 * 60 * 1000;
const SOURCES_TTL_MS = 30 * 1000;
const SAMPLE_LIMIT = 100;
const STAGING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const SELF_PREFIX = 'workspace/dsh-maintenance-backup';
const SELF_SKIP_REASON = '维护插件自身不参与还原，避免运行中的代码被替换';

/** 通用排除（快照/差异/安全副本/目录镜像一致）。 */
const BASE_EXCLUDES = ['node_modules', '.git', '.playwright-cli', '.DS_Store', '*.log', '*.tmp', '.turbo'];
const EXCLUDE_CRAWL_NAMES = new Set(['node_modules', '.git', '.playwright-cli', '.DS_Store', '.turbo']);

/** 各 profile 下的运行态子目录：还原时绝不删除/覆盖。 */
const RUNTIME_SUBDIRS = ['sessions', 'attachments', 'storages', 'cache', 'page-preview', 'dsh-runtimes'];

const SCOPE_VALUES = new Set(['all', 'config', 'workspace']);

/** @typedef {{ prefix: string, target: string }} PlannedTarget */
/** @typedef {{ added: number, overwritten: number, deleted: number, unchanged: number }} DiffCounts */

/**
 * 创建一个还原引擎。
 *
 * @param {{
 *   core: ReturnType<import('./core.js').createCore>,
 *   quark: ReturnType<import('./quark.js').createQuark>,
 *   logger?: ((message: string, level?: string) => void) | null,
 *   resolveSources?: (() => Promise<Array<{ src: string, dest: string }>>) | null,
 *   resolveFolders?: (() => Promise<{ dshFid?: string, archiveFid?: string }>) | null,
 *   platform?: NodeJS.Platform
 * }} options
 */
export function createRestoreEngine({ core, quark, logger, resolveSources, resolveFolders, platform = process.platform }) {
  if (!core) throw new Error('createRestoreEngine 缺少 core');
  if (!quark) throw new Error('createRestoreEngine 缺少 quark');

  /** 路径包含判断用的平台（测试可注入 'win32' 验证 Windows 盘符/大小写语义）。 */
  const targetPlatform = platform || process.platform;
  const envDshFid = process.env.DSH_SYNC_DSH_FID || DEFAULT_DSH_FID;
  const envArchiveFid = process.env.DSH_SYNC_ARCHIVE_FID || DEFAULT_ARCHIVE_FID;
  const folderResolver = typeof resolveFolders === 'function' ? resolveFolders : null;

  /**
   * 网盘目录 FID：与备份引擎同源（~/.dsh-sync 配置），避免配置改了上传目录后
   * 快照列表/归档计数仍读内置默认目录。解析失败时回退 env / 内置默认值。
   */
  async function folders() {
    if (folderResolver) {
      try {
        const resolved = await folderResolver();
        const dsh = typeof resolved?.dshFid === 'string' && resolved.dshFid ? resolved.dshFid : envDshFid;
        const archive =
          typeof resolved?.archiveFid === 'string' && resolved.archiveFid ? resolved.archiveFid : envArchiveFid;
        return { dshFid: dsh, archiveFid: archive };
      } catch (error) {
        log(`读取网盘目录配置失败，使用默认目录：${error?.message || error}`, 'warn');
      }
    }
    return { dshFid: envDshFid, archiveFid: envArchiveFid };
  }
  const sourceResolver = typeof resolveSources === 'function' ? resolveSources : null;
  /** @type {{ at: number, list: Array<{ src: string, dest: string }> | null } | null} */
  let sourcesCache = null;

  let snapshotCache = null;
  /** @type {Map<string, unknown>} sidecarFid -> parsed manifest */
  const sidecarCache = new Map();
  /** @type {Map<string, string>} snapshotName -> sidecar filename */
  const sidecarNames = new Map();
  /** 串行化 stage/apply/rollback/finalize，避免同进程内并发互踩。 */
  let workQueue = Promise.resolve();

  function log(message, level = 'info') {
    try {
      if (typeof logger === 'function') logger(message, level);
      else core.log(message, level);
    } catch {
      /* 日志失败不影响业务 */
    }
  }

  function serialize(fn) {
    const run = workQueue.then(fn, fn);
    workQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function errorMessage(error) {
    return String(error?.message ?? error ?? '未知错误');
  }

  /** @param {unknown} value */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function formatBytes(bytes) {
    try {
      return core.formatBytes(bytes);
    } catch {
      return `${Number(bytes) || 0} B`;
    }
  }

  // ---------------------------------------------------------------- 路径安全

  /**
   * 还原目标必须在主目录（或显式配置的同步根）之下：防止路径穿越。
   * @param {string} target 本机目标绝对路径
   * @param {string} label 展示用名称
   * @returns {string} resolve 后的绝对路径
   */
  function assertSafeTarget(target, label) {
    const resolved = resolve(target);
    const homeRoot = resolve(core.paths.home);
    if (resolved !== homeRoot && pathInside(homeRoot, resolved, targetPlatform)) return resolved;
    // 允许通过 env 显式改到主目录之外的同步根，但必须落在其中一个根里
    const roots = [resolve(core.paths.dshHome), resolve(core.paths.workspace), resolve(core.paths.syncDir)];
    for (const root of roots) {
      if (resolved !== root && pathInside(root, resolved, targetPlatform)) {
        log(`还原目标位于主目录之外（${label}: ${resolved}），已按配置的同步根放行`, 'warn');
        return resolved;
      }
    }
    throw new Error(`拒绝操作：还原目标不在允许范围内（${label} → ${target}）`);
  }

  /** @param {string} stagingId */
  function stagingDirFor(stagingId) {
    if (typeof stagingId !== 'string' || !STAGING_ID_RE.test(stagingId) || stagingId === '.' || stagingId === '..') {
      throw new Error(`无效的暂存区 ID：${String(stagingId)}`);
    }
    const root = resolve(core.paths.stagingRoot);
    const dir = resolve(root, stagingId);
    if (dir === root || !pathInside(root, dir, targetPlatform)) {
      throw new Error(`无效的暂存区 ID：${String(stagingId)}`);
    }
    return dir;
  }

  function isReadableDir(dir) {
    try {
      accessSync(dir, fsConstants.R_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 排除/保护规则

  /** @param {string} rel 目标内相对路径 */
  function isExcludedRel(rel) {
    const parts = rel.split('/');
    for (const part of parts) {
      if (EXCLUDE_CRAWL_NAMES.has(part)) return true;
    }
    const name = parts[parts.length - 1] || '';
    if (name === '.DS_Store') return true;
    return /\.(log|tmp)$/i.test(name);
  }

  /**
   * 运行态/密钥保护路径。返回 null 表示不是保护路径。
   * @param {string} prefix 快照内前缀
   * @param {string} rel 目标内相对路径
   * @returns {{ key: string, reason: string } | null}
   */
  function protectedFor(prefix, rel) {
    const parts = rel.split('/');
    if (prefix === 'dsh-home/profiles') {
      if (parts.length >= 2 && RUNTIME_SUBDIRS.includes(parts[1])) {
        return {
          key: `${prefix}/${parts[0]}/${parts[1]}`,
          reason: 'profile 运行态目录（会话/附件/缓存等），还原时保留不删除',
        };
      }
      return null;
    }
    if (prefix === 'dsh-home/skills') {
      if (parts[0] === 'quarkclouddrive' && parts[1] === 'deepseek') {
        return { key: `${prefix}/quarkclouddrive/deepseek`, reason: '夸克 CLI 运行态目录，还原时保留不删除' };
      }
      if (parts[0] === 'quarkclouddrive' && parts[1] === 'browse') {
        return { key: `${prefix}/quarkclouddrive/browse`, reason: '夸克 CLI 浏览缓存目录，还原时保留不删除' };
      }
      return null;
    }
    if (prefix === 'dsh-sync') {
      if (parts[0] === 'state') return { key: `${prefix}/state`, reason: '同步工具运行态目录，还原时保留不删除' };
      if (parts[0] === 'logs') return { key: `${prefix}/logs`, reason: '同步工具日志目录，还原时保留不删除' };
      return null;
    }
    if (prefix === 'dsh-home' && rel === '.credentials.yaml') {
      return { key: 'dsh-home/.credentials.yaml', reason: 'API 密钥文件，永不覆盖/删除' };
    }
    return null;
  }

  /**
   * 目标目录专用的运行态排除模式（tar 与 mirror 共用同一套语义）。
   * @param {string} prefix
   * @returns {string[]}
   */
  function protectedExcludePatterns(prefix) {
    if (prefix === 'dsh-home/profiles') return RUNTIME_SUBDIRS.map((name) => `*/${name}`);
    if (prefix === 'dsh-home/skills') return ['quarkclouddrive/deepseek', 'quarkclouddrive/browse'];
    if (prefix === 'dsh-sync') return ['state', 'logs'];
    return [];
  }

  /** 某个还原目标的完整排除列表（安全副本 tar / mirror 共用）。 */
  function targetExcludes(prefix) {
    return [...BASE_EXCLUDES, ...protectedExcludePatterns(prefix)];
  }

  /** 安全副本 tar 的 `--exclude` 参数。 */
  function excludeArgs(prefix) {
    const args = [];
    for (const pattern of targetExcludes(prefix)) args.push('--exclude', pattern);
    return args;
  }

  // ---------------------------------------------------------------- 快照列表

  /** @param {string} name @returns {number | null} 本地时区 epoch ms */
  function parseSnapshotTime(name) {
    const match = SNAPSHOT_RE.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    const time = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
    return Number.isFinite(time) ? time : null;
  }

  /**
   * 列出 dsh/ 下的快照（缓存 30 秒，refresh 强制刷新）。
   * @param {{ refresh?: boolean }} [options]
   */
  async function listSnapshots(options = {}) {
    const refresh = Boolean(options?.refresh);
    if (!refresh && snapshotCache && core.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
      return snapshotCache.snapshots.slice();
    }
    log('读取网盘快照列表…');
    const { dshFid, archiveFid } = await folders();
    const response = await quark.browseAll(dshFid);
    if (!response?.ok) {
      if (snapshotCache) {
        log(`读取网盘快照列表失败，使用上一份缓存：${response?.msg || '未知错误'}`, 'warn');
        return snapshotCache.snapshots.slice();
      }
      throw new Error(`读取网盘快照列表失败${response?.msg ? `：${response.msg}` : ''}`);
    }
    const entries = Array.isArray(response.entries) ? response.entries : [];
    /** @type {Map<string, any>} */
    const tars = new Map();
    /** @type {Map<string, any>} */
    const sidecars = new Map();
    for (const entry of entries) {
      const name = typeof entry?.filename === 'string' ? entry.filename : typeof entry?.name === 'string' ? entry.name : '';
      const fid = typeof entry?.fid === 'string' ? entry.fid : '';
      if (!name || !fid) continue;
      const size = Number(entry?.size) || 0;
      if (SNAPSHOT_RE.test(name)) tars.set(name, { name, fid, size });
      else if (SIDECAR_RE.test(name)) sidecars.set(name, { name, fid, size });
    }
    sidecarNames.clear();
    const snapshots = [];
    for (const [name, tar] of tars) {
      const base = name.replace(/\.tar\.gz$/, '');
      const sidecarName = `${base}.manifest.json`;
      const sidecar = sidecars.get(sidecarName) || null;
      if (sidecar) sidecarNames.set(name, sidecarName);
      const createdAt = parseSnapshotTime(name);
      snapshots.push({
        name,
        fid: tar.fid,
        size: tar.size,
        createdAt,
        sidecarFid: sidecar ? sidecar.fid : null,
        sidecarSize: sidecar ? sidecar.size : null,
        ageDays: createdAt === null ? null : Math.max(0, (core.now() - createdAt) / 86_400_000),
      });
    }
    snapshots.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.name.localeCompare(a.name));
    snapshotCache = { at: core.now(), snapshots };
    log(`网盘中找到 ${snapshots.length} 份快照（归档目录 ${archiveFid.slice(0, 8)}… 不在列表中）`);
    return snapshots.slice();
  }

  /** @param {string} name */
  async function findSnapshot(name) {
    if (!SNAPSHOT_NAME_RE.test(String(name || ''))) throw new Error(`无效的快照名称：${String(name)}`);
    let snapshots = await listSnapshots({});
    let found = snapshots.find((item) => item.name === name);
    if (!found) {
      snapshots = await listSnapshots({ refresh: true });
      found = snapshots.find((item) => item.name === name);
    }
    if (!found) throw new Error(`网盘中找不到快照 ${name}（可能已被归档或删除）`);
    return found;
  }

  // ---------------------------------------------------------------- sidecar（元数据）

  /**
   * 下载并解析 sidecar（小文件）。失败返回 null。
   * @param {any} snapshot
   * @param {string} outDir
   */
  async function loadSidecar(snapshot, outDir) {
    if (!snapshot?.sidecarFid) return null;
    const cached = sidecarCache.get(snapshot.sidecarFid);
    if (cached && core.now() - cached.at < SIDECAR_TTL_MS) return cached.manifest;
    const hint = sidecarNames.get(snapshot.name) || `${snapshot.name.replace(/\.tar\.gz$/, '')}.manifest.json`;
    const response = await quark.download(snapshot.sidecarFid, outDir, { name: hint });
    if (!response?.ok || !response.path) {
      log(`快照元数据 sidecar 下载失败：${response?.msg || '未知错误'}`, 'warn');
      return null;
    }
    const text = core.readText(response.path);
    if (typeof text !== 'string' || !text.trim()) {
      log('快照元数据 sidecar 内容为空', 'warn');
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      log('快照元数据 sidecar 不是合法 JSON', 'warn');
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const manifest = { ...parsed };
    if (!Array.isArray(manifest.entries)) manifest.entries = [];
    if (!Array.isArray(manifest.files)) manifest.files = [];
    sidecarCache.set(snapshot.sidecarFid, { at: core.now(), manifest });
    return manifest;
  }

  /**
   * 预览快照元数据：优先下载 sidecar 解析；没有 sidecar 时返回 available:false。
   * @param {{ name: string }} input
   */
  async function preview(input = {}) {
    const name = String(input?.name || '');
    const snapshot = await findSnapshot(name);
    if (!snapshot.sidecarFid) {
      return {
        available: false,
        source: 'none',
        manifest: null,
        message: '该快照没有附带 .manifest.json 元数据 sidecar（旧版同步脚本生成），无法预览文件清单；可以直接执行还原，解压后会在差异里列出文件变化。',
      };
    }
    const tmpDir = join(core.paths.tasksDir, `preview-${core.uuid()}`);
    core.ensureDir(tmpDir);
    try {
      const existing = sidecarCache.get(snapshot.sidecarFid);
      const manifest =
        existing && core.now() - existing.at < SIDECAR_TTL_MS
          ? existing.manifest
          : await loadSidecar(snapshot, tmpDir);
      if (!manifest) {
        return {
          available: false,
          source: 'none',
          manifest: null,
          message: '读取快照元数据 sidecar 失败，可能已被归档或网盘暂时不可用。',
        };
      }
      return { available: true, source: 'sidecar', manifest };
    } finally {
      core.removeTree(tmpDir);
    }
  }

  // ---------------------------------------------------------------- 差异计算

  /**
   * 列出一个目录下（相对）参与比较的文件；同时收集受保护目录。
   * @param {string} dir
   * @param {string} prefix
   */
  function listTree(dir, prefix) {
    /** @type {Map<string, { size: number, abs: string }>} */
    const files = new Map();
    /** @type {Map<string, string>} */
    const protectedRoots = new Map();
    const stat = core.statSafe(dir);
    const exists = Boolean(stat && stat.isDirectory());
    if (!exists) return { exists, files, protectedRoots, unreadable: false, rawCount: 0 };
    const unreadable = !isReadableDir(dir);
    let raw = [];
    if (!unreadable) {
      try {
        raw = core.walkFiles(dir, { excludeNames: EXCLUDE_CRAWL_NAMES, maxFiles: 200000 });
      } catch {
        raw = [];
      }
    }
    for (const entry of raw) {
      const rel = entry.path;
      if (isExcludedRel(rel)) continue;
      const protection = protectedFor(prefix, rel);
      if (protection) {
        protectedRoots.set(protection.key, protection.reason);
        continue;
      }
      files.set(rel, { size: Number(entry.size) || 0, abs: entry.abs });
    }
    return { exists, files, protectedRoots, unreadable, rawCount: raw.length };
  }

  /** @param {string} dest 包内路径 @returns {string} 最后一段 */
  function destBasename(dest) {
    const parts = String(dest).split('/');
    return parts[parts.length - 1] || '';
  }

  /** 两个路径 resolve 后是否相同（用于识别维护插件自身目录）。 */
  function samePath(a, b) {
    try {
      return resolve(String(a)) === resolve(String(b));
    } catch {
      return false;
    }
  }

  /** 快照 root/<sub>/ 下实际存在的目录名（按字母序；只看第一层）。 */
  function listSnapshotDirs(root, sub) {
    return core
      .listDirSafe(join(root, sub))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== '.' && name !== '..')
      .sort();
  }

  /**
   * 取调用方传入的同步映射（config.sh 条目 + link: 发现结果），带 30 秒缓存。
   * 返回 null 表示没有可用映射（未提供或读取失败）→ 走固定默认映射兜底。
   * @returns {Promise<Array<{ src: string, dest: string }> | null>}
   */
  async function loadSources() {
    if (!sourceResolver) return null;
    if (sourcesCache && core.now() - sourcesCache.at < SOURCES_TTL_MS) return sourcesCache.list;
    try {
      const raw = await sourceResolver();
      const list = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item.src !== 'string' || typeof item.dest !== 'string') continue;
        const src = item.src.trim();
        const dest = item.dest.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        if (!src || !dest) continue;
        list.push({ src, dest });
      }
      sourcesCache = { at: core.now(), list };
      if (list.length) log(`同步映射已加载：${list.length} 条（用于解析还原落点）`);
      return list;
    } catch (error) {
      sourcesCache = { at: core.now(), list: null };
      log(`读取同步映射失败，改用默认路径解析还原目标：${errorMessage(error)}`, 'warn');
      return null;
    }
  }

  /** resolveSources 的 src 可能是 Windows 反斜杠 / 带尾部分隔符的路径，统一 resolve。 */
  function normalizeSourcePath(value) {
    try {
      return resolve(String(value));
    } catch {
      return String(value);
    }
  }

  /**
   * 包内 workspace/<x> 的落点：
   *   1) resolveSources 中 dest 精确等于 workspace/<x> → 用自己的 src；
   *   2) 否则 dest 的 basename 唯一等于 <x>（兼容旧快照/改了 dest 前缀的情况）；
   *   3) 都没有 → 默认 join(workspace, x) 并写 warning。
   * @param {string} name 包内 workspace/ 下的一级目录名
   * @param {Array<{ src: string, dest: string }> | null} sources
   * @param {string[]} warnings
   */
  function resolveWorkspaceTarget(name, sources, warnings) {
    const defaultTarget = join(core.paths.workspace, name);
    if (Array.isArray(sources)) {
      const exact = sources.find((item) => item.dest === `workspace/${name}`);
      if (exact) return normalizeSourcePath(exact.src);
      const byBasename = sources.filter(
        (item) => item.dest.startsWith('workspace/') && destBasename(item.dest) === name,
      );
      if (byBasename.length === 1) return normalizeSourcePath(byBasename[0].src);
      warnings.push(
        byBasename.length > 1
          ? `workspace/${name}：当前 config.sh 中有多个同名映射，无法唯一确定，按默认路径 ${defaultTarget} 还原，请核对`
          : `workspace/${name}：未在当前 config.sh 中找到映射，按默认路径 ${defaultTarget} 还原，请核对`,
      );
      return defaultTarget;
    }
    warnings.push(
      `workspace/${name}：没有可用的同步映射（resolveSources 未提供或读取失败），按默认路径 ${defaultTarget} 还原，请核对`,
    );
    return defaultTarget;
  }

  /**
   * 目标映射表：只还原快照里实际存在的前缀，未声明的路径一律不动。
   * - dsh-home/<rest> → core.paths.dshHome/<rest>
   * - dsh-sync → core.paths.syncDir
   * - workspace/<x> → resolveSources 解析出的落点（否则默认 workspace/<x>）
   * @param {{ root: string, scope: string, includeSelf: boolean, warnings: string[] }} input
   * @returns {Promise<{ targets: PlannedTarget[], skippedSelf: PlannedTarget[] }>}
   */
  async function resolveTargets({ root, scope, includeSelf, warnings }) {
    /** @type {PlannedTarget[]} */
    const targets = [];
    /** @type {PlannedTarget[]} */
    const skippedSelf = [];
    const sources = await loadSources();
    if (scope === 'all' || scope === 'config') {
      for (const name of listSnapshotDirs(root, 'dsh-home')) {
        if (name.includes('/') || name.includes('\\')) continue;
        targets.push({ prefix: `dsh-home/${name}`, target: join(core.paths.dshHome, name) });
      }
    }
    if (scope === 'all' || scope === 'workspace') {
      for (const name of listSnapshotDirs(root, 'workspace')) {
        if (!WORKSPACE_NAME_RE.test(name)) {
          warnings.push(`快照中的 workspace/${name} 名称不合法，已跳过`);
          continue;
        }
        const prefix = `workspace/${name}`;
        if (!includeSelf && name === 'dsh-maintenance-backup') {
          skippedSelf.push({ prefix, target: join(core.paths.workspace, name) });
          continue;
        }
        const mapped = resolveWorkspaceTarget(name, sources, warnings);
        if (!includeSelf && samePath(mapped, core.paths.selfPackageDir)) {
          skippedSelf.push({ prefix, target: mapped });
          continue;
        }
        targets.push({ prefix, target: mapped });
      }
    }
    if (scope === 'all') {
      if (core.statSafe(join(root, 'dsh-sync'))?.isDirectory()) {
        targets.push({ prefix: 'dsh-sync', target: core.paths.syncDir });
      }
    }
    return { targets, skippedSelf };
  }

  /** @param {string} scope */
  function normalizeScope(scope, fallback = 'all') {
    if (scope === undefined || scope === null || scope === '') return fallback;
    const value = String(scope);
    if (!SCOPE_VALUES.has(value)) throw new Error(`无效的还原范围：${value}（可选 all / config / workspace）`);
    return value;
  }

  /**
   * 计算差异（只读本机，不修改任何被还原目标）。
   * @param {{ root: string, scope: string, includeSelf: boolean, manifest?: any, warnings?: string[] }} input
   * @returns {Promise<any>} Diff（见 CONTRACT.md）
   */
  async function computeDiff({ root, scope, includeSelf, manifest = null, warnings: seedWarnings = [] }) {
    const warnings = [...seedWarnings];
    if (manifest && manifest.partial === true) {
      warnings.push('该快照标记为「不完整快照」（MANIFEST.partial=true），部分目录可能缺失。');
    }
    if (core.pathExists(join(root, 'WARNING-PARTIAL-SNAPSHOT.txt'))) {
      warnings.push('快照内含 WARNING-PARTIAL-SNAPSHOT.txt，说明打包时部分目录无读取权限。');
    }
    /** @type {DiffCounts} */
    const counts = { added: 0, overwritten: 0, deleted: 0, unchanged: 0 };
    const bytes = { added: 0, overwritten: 0, deleted: 0 };
    const samples = { added: [], overwritten: [], deleted: [] };
    const targetStats = [];
    /** @type {Array<{ path: string, reason: string }>} */
    const protectedEntries = [];
    const protectedKeys = new Set();

    function pushSample(kind, display) {
      if (samples[kind].length < SAMPLE_LIMIT) samples[kind].push(display);
    }

    function addProtected(path, reason) {
      if (protectedKeys.has(path)) return;
      protectedKeys.add(path);
      protectedEntries.push({ path, reason });
    }

    const resolved = await resolveTargets({ root, scope, includeSelf, warnings });

    for (const target of resolved.targets) {
      const snapshotDir = join(root, target.prefix);
      const snapshotStat = core.statSafe(snapshotDir);
      if (!snapshotStat || !snapshotStat.isDirectory()) {
        warnings.push(`快照中缺少 ${target.prefix}，该目标已跳过（不会删除本机目录）`);
        continue;
      }
      let safeTarget;
      try {
        safeTarget = assertSafeTarget(target.target, target.prefix);
      } catch (error) {
        warnings.push(errorMessage(error));
        continue;
      }
      const snapTree = listTree(snapshotDir, target.prefix);
      const localTree = listTree(safeTarget, target.prefix);
      if (snapTree.unreadable) warnings.push(`快照目录不可读，已按空目录比较：${target.prefix}`);
      if (localTree.unreadable) warnings.push(`本机目标目录不可读，已按空目录比较：${safeTarget}`);
      for (const [key, reason] of localTree.protectedRoots) {
        if (!core.pathExists(join(root, key))) addProtected(key, reason);
      }

      /** @type {DiffCounts} */
      const targetCounts = { added: 0, overwritten: 0, deleted: 0, unchanged: 0 };
      const targetBytes = { added: 0, overwritten: 0, deleted: 0 };
      let snapshotBytes = 0;
      for (const [, info] of snapTree.files) snapshotBytes += info.size;

      for (const [rel, info] of snapTree.files) {
        const display = `${target.prefix}/${rel}`;
        const before = localTree.files.get(rel);
        if (!before) {
          targetCounts.added += 1;
          targetBytes.added += info.size;
          counts.added += 1;
          bytes.added += info.size;
          pushSample('added', display);
        } else if (before.size !== info.size) {
          targetCounts.overwritten += 1;
          targetBytes.overwritten += info.size;
          counts.overwritten += 1;
          bytes.overwritten += info.size;
          pushSample('overwritten', display);
        } else {
          targetCounts.unchanged += 1;
          counts.unchanged += 1;
        }
      }
      for (const [rel, info] of localTree.files) {
        if (snapTree.files.has(rel)) continue;
        targetCounts.deleted += 1;
        targetBytes.deleted += info.size;
        counts.deleted += 1;
        bytes.deleted += info.size;
        pushSample('deleted', `${target.prefix}/${rel}`);
      }
      targetStats.push({
        prefix: target.prefix,
        target: safeTarget,
        counts: targetCounts,
        bytes: targetBytes,
        snapshotFiles: snapTree.files.size,
        snapshotBytes,
      });
    }

    // ~/.dsh/.credentials.yaml：快照里永远没有，必须显式保护
    if (scope !== 'workspace') {
      const credentials = join(core.paths.dshHome, '.credentials.yaml');
      if (core.pathExists(credentials) && !core.pathExists(join(root, 'dsh-home/.credentials.yaml'))) {
        addProtected('dsh-home/.credentials.yaml', 'API 密钥文件，永不覆盖/删除');
      }
    }
    // 维护插件自身：按映射结果识别，避免换了 dest 名后误覆盖
    if (!includeSelf && (scope === 'all' || scope === 'workspace')) {
      if (resolved.skippedSelf.length) {
        for (const item of resolved.skippedSelf) addProtected(item.prefix, SELF_SKIP_REASON);
      } else if (
        core.pathExists(join(root, SELF_PREFIX)) ||
        core.pathExists(join(core.paths.workspace, 'dsh-maintenance-backup')) ||
        core.pathExists(core.paths.selfPackageDir)
      ) {
        addProtected(SELF_PREFIX, SELF_SKIP_REASON);
      }
    }

    return {
      scope,
      includeSelf: Boolean(includeSelf),
      counts,
      bytes,
      samples,
      targets: targetStats,
      protected: protectedEntries,
      warnings,
    };
  }

  // ---------------------------------------------------------------- 暂存区

  function stagingMetadataPath(dir) {
    return join(dir, 'staging.json');
  }

  async function ensureSidecarForStage(snapshot, dir, warnings) {
    if (!snapshot.sidecarFid) return null;
    try {
      const manifest = await loadSidecar(snapshot, dir);
      if (!manifest) warnings.push('快照没有可用的元数据 sidecar，跳过 SHA-256 校验。');
      return manifest;
    } catch (error) {
      warnings.push(`读取快照元数据失败，跳过 SHA-256 校验：${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * 阶段一：下载 + 解压 + 差异。只写暂存区，不修改任何本机还原目标。
   * @param {{ name?: string, scope?: string, includeSelf?: boolean }} input
   */
  async function stage(input = {}) {
    return serialize(async () => {
      const name = String(input?.name || '');
      const scope = normalizeScope(input?.scope, 'all');
      const includeSelf = Boolean(input?.includeSelf);
      const snapshot = await findSnapshot(name);
      const stagingId = `stg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = stagingDirFor(stagingId);
      const root = join(dir, 'root');
      core.ensureDir(root);
      log(`开始准备还原：${snapshot.name}（范围 ${scope}，includeSelf=${includeSelf}）`);
      const warnings = [];
      let archivePath = null;
      try {
        // 1) 下载快照
        log(`下载快照（${formatBytes(snapshot.size)}）…`);
        const download = await quark.download(snapshot.fid, dir, { name: snapshot.name });
        if (!download?.ok || !download.path) {
          throw new Error(`下载快照失败${download?.msg ? `：${download.msg}` : ''}`);
        }
        let candidate = resolve(String(download.path));
        if (core.statSafe(candidate)?.isDirectory()) candidate = resolve(candidate, snapshot.name);
        if (candidate === resolve(dir) || !pathInside(resolve(dir), candidate, targetPlatform)) {
          throw new Error(`下载结果不在暂存区内，已中止（${download.path}）`);
        }
        archivePath = candidate;
        const actualSize = core.statSafe(archivePath)?.size ?? -1;
        if (actualSize < 0) throw new Error('快照下载完成但找不到文件');
        const expectedSize = Number(snapshot.size) || 0;
        if (expectedSize > 0 && actualSize !== expectedSize) {
          throw new Error(
            `快照下载大小与网盘记录不一致（记录 ${formatBytes(expectedSize)}，实际 ${formatBytes(actualSize)}），请重试`,
          );
        }
        log(`快照已下载：${formatBytes(actualSize)}`);

        // 2) sidecar + SHA-256 校验
        const sidecar = await ensureSidecarForStage(snapshot, dir, warnings);
        const expectedSha = typeof sidecar?.archive_sha256 === 'string' ? sidecar.archive_sha256.trim().toLowerCase() : '';
        if (expectedSha) {
          log('校验快照 SHA-256…');
          const actualSha = core.sha256File(archivePath);
          if (actualSha !== expectedSha) {
            throw new Error(`快照校验失败：SHA-256 不匹配（期望 ${expectedSha.slice(0, 16)}…，实际 ${actualSha.slice(0, 16)}…）`);
          }
        }

        // 3) 解压
        const tar = resolveTarCommand();
        log(`解压快照（${tar}）…`);
        const extracted = await core.run(tar, ['-xzf', archivePath, '-C', root], { timeoutMs: 15 * 60 * 1000 });
        if (!extracted.ok) {
          const detail = (extracted.stderr || extracted.error || '').trim().split('\n').slice(-3).join(' ');
          throw new Error(`快照解压失败${detail ? `：${detail}` : ''}`);
        }
        const hasDshHome = core.pathExists(join(root, 'dsh-home'));
        const hasWorkspace = core.pathExists(join(root, 'workspace'));
        if (!hasDshHome && !hasWorkspace) {
          throw new Error('快照内容不完整：既没有 dsh-home/ 也没有 workspace/ 目录');
        }
        if (!hasDshHome) warnings.push('快照中没有 dsh-home/ 目录，配置类目标将全部跳过。');
        if (!hasWorkspace) warnings.push('快照中没有 workspace/ 目录，插件工程目标将全部跳过。');
        const manifest = core.readJson(join(root, 'MANIFEST.json'), null);
        if (!manifest) warnings.push('快照内没有 MANIFEST.json，元信息缺失。');
        const archiveBytes = actualSize;

        // 4) 删除归档 tar，只保留解压内容
        core.removeTree(archivePath);
        archivePath = null;

        // 5) 先写暂存元数据，再计算差异
        const baseMeta = {
          stagingId,
          snapshotName: snapshot.name,
          snapshotFid: snapshot.fid,
          scope,
          includeSelf,
          dir,
          root,
          createdAt: core.now(),
          archiveBytes,
          manifest,
          sidecar: sidecar
            ? {
                available: true,
                fileCount: Number(sidecar.file_count) || null,
                archiveSha256: typeof sidecar.archive_sha256 === 'string' ? sidecar.archive_sha256 : null,
              }
            : { available: false },
          phase: 'diffing',
          diff: null,
        };
        core.writeJson(stagingMetadataPath(dir), baseMeta);

        log('计算还原差异…');
        const diff = await computeDiff({ root, scope, includeSelf, manifest, warnings });
        const meta = { ...baseMeta, phase: 'staged', diff };
        core.writeJson(stagingMetadataPath(dir), meta);
        log(
          `差异：新增 ${diff.counts.added} / 覆盖 ${diff.counts.overwritten} / 删除 ${diff.counts.deleted} / 未变 ${diff.counts.unchanged}，` +
            `受保护 ${diff.protected.length} 项，警告 ${diff.warnings.length} 条`,
        );
        return {
          stagingId,
          snapshotName: snapshot.name,
          scope,
          includeSelf,
          dir,
          createdAt: meta.createdAt,
          archiveBytes,
          diff,
        };
      } catch (error) {
        if (archivePath) core.removeTree(archivePath);
        core.removeTree(dir);
        log(`准备还原失败：${errorMessage(error)}`, 'error');
        throw error instanceof Error ? error : new Error(errorMessage(error));
      }
    });
  }

  /** @param {{ stagingId: string }} input */
  async function discard(input = {}) {
    const dir = stagingDirFor(String(input?.stagingId || ''));
    if (core.pathExists(dir)) {
      core.removeTree(dir);
      log(`已丢弃暂存区 ${input.stagingId}`);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- 安全副本

  function readSafetyInfo(dir) {
    const info = core.readJson(join(dir, 'safety.json'), null);
    return isPlainObject(info) ? info : null;
  }

  /** 只保留最近 1 套安全副本。 */
  function pruneSafetyBackups() {
    const root = resolve(core.paths.safetyDir);
    const dirs = core
      .listDirSafe(root)
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => resolve(root, entry.name));
    const ranked = dirs
      .map((dir) => {
        const info = readSafetyInfo(dir);
        const createdAt = Number(info?.createdAt) || core.statSafe(dir)?.mtimeMs || 0;
        return { dir, createdAt };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const stale of ranked.slice(1)) {
      core.removeTree(stale.dir);
      log(`清理旧安全副本 ${stale.dir}`);
    }
  }

  /**
   * 给每个将被覆盖的本机目标目录打 tar.gz 安全副本。
   * @param {{ id: string, targets: PlannedTarget[], root: string }} input
   */
  async function createSafetyCopy({ id, targets, root }) {
    const base = join(core.paths.safetyDir, id);
    core.ensureDir(base);
    const tar = resolveTarCommand();
    log(`创建还原前安全副本（tar: ${tar}）…`);
    const records = [];
    let index = 0;
    let bytes = 0;
    let files = 0;
    for (const target of targets) {
      const stat = core.statSafe(target.target);
      const existed = Boolean(stat && stat.isDirectory());
      if (!existed) {
        records.push({ prefix: target.prefix, target: target.target, archive: null, existed: false, files: 0, bytes: 0 });
        continue;
      }
      index += 1;
      const slug = target.prefix.replace(/[^A-Za-z0-9._-]+/g, '_');
      const archive = join(base, `${String(index).padStart(2, '0')}-${slug}.tar.gz`);
      const args = ['-czf', archive, ...excludeArgs(target.prefix), '-C', target.target, '.'];
      const created = await core.run(tar, args, { timeoutMs: 15 * 60 * 1000 });
      if (!created.ok) {
        const detail = (created.stderr || created.error || '').trim().split('\n').slice(-3).join(' ');
        throw new Error(`创建安全副本失败（${target.prefix}）${detail ? `：${detail}` : ''}`);
      }
      const tree = listTree(target.target, target.prefix);
      const fileCount = tree.files.size;
      let totalBytes = 0;
      for (const [, info] of tree.files) totalBytes += info.size;
      const archiveBytes = core.statSafe(archive)?.size ?? 0;
      bytes += archiveBytes;
      files += fileCount;
      records.push({
        prefix: target.prefix,
        target: target.target,
        archive,
        existed: true,
        files: fileCount,
        bytes: totalBytes,
        archiveBytes,
      });
    }
    const info = { id, createdAt: core.now(), root, targets: records };
    core.writeJson(join(base, 'safety.json'), info);
    pruneSafetyBackups();
    log(`安全副本完成：${records.filter((item) => item.existed).length} 个目录，${formatBytes(bytes)}`);
    return { path: base, bytes, files, info };
  }

  // ---------------------------------------------------------------- 阶段二 apply

  /**
   * 阶段二：安全副本 + 目录镜像（mirrorDirectory）应用 + 写 marker。不重启进程、不清理暂存区。
   * @param {{ stagingId?: string, scope?: string, includeSelf?: boolean, ensureSelfRegistration?: Function }} input
   */
  async function apply(input = {}) {
    return serialize(async () => {
      const stagingId = String(input?.stagingId || '');
      const dir = stagingDirFor(stagingId);
      const meta = core.readJson(stagingMetadataPath(dir), null);
      if (!isPlainObject(meta)) {
        throw new Error(`找不到暂存区 ${stagingId}，请重新执行「准备还原」`);
      }
      const root = join(dir, 'root');
      if (!core.pathExists(root)) throw new Error('暂存区内容不完整（缺少解压目录），请重新执行「准备还原」');
      const scope = normalizeScope(input?.scope, normalizeScope(meta.scope, 'all'));
      const includeSelf = input?.includeSelf === undefined ? Boolean(meta.includeSelf) : Boolean(input.includeSelf);
      const ensureSelfRegistration =
        typeof input?.ensureSelfRegistration === 'function' ? input.ensureSelfRegistration : null;

      const sameDiff = meta.diff && meta.scope === scope && Boolean(meta.includeSelf) === includeSelf;
      const diff = sameDiff ? meta.diff : await computeDiff({ root, scope, includeSelf, manifest: meta.manifest });
      const warnings = [...(diff.warnings || [])];
      /** @type {PlannedTarget[]} */
      const planned = (diff.targets || []).map((item) => ({ prefix: item.prefix, target: item.target }));
      if (!planned.length) throw new Error('没有可还原的目标（快照内容与该范围不匹配）');
      const selfSkipped =
        !includeSelf && (diff.protected || []).some((item) => item.reason === SELF_SKIP_REASON);

      const id = `rst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = core.now();
      const marker = {
        id,
        snapshotName: meta.snapshotName,
        scope,
        includeSelf,
        phase: 'applying',
        startedAt,
        finishedAt: null,
        safetyPath: null,
        targets: planned,
        result: null,
        // 记录执行 apply 的 Host 进程；重启后 pid 不同才做启动收尾，
        // 避免插件在同一进程内重载时提前消费 marker。
        applyPid: process.pid,
      };
      core.writeJson(core.paths.pendingFile, marker);
      log(`开始应用还原（${scope}，${planned.length} 个目标，includeSelf=${includeSelf}）`);
      try {
        // 1) 安全副本
        const safety = await createSafetyCopy({ id, targets: planned, root });

        // 2) 逐目标 mirror（纯 Node 目录镜像，替代 rsync；Windows 无 rsync）
        const applied = [];
        let appliedFiles = 0;
        let appliedBytes = 0;
        for (const target of planned) {
          // 双保险：self 前缀或映射到插件自身目录时绝不触碰
          if (!includeSelf && (target.prefix === SELF_PREFIX || samePath(target.target, core.paths.selfPackageDir))) {
            continue;
          }
          const snapshotDir = join(root, target.prefix);
          if (!core.pathExists(snapshotDir)) {
            warnings.push(`快照中缺少 ${target.prefix}，已跳过（未删除本机目录）`);
            continue;
          }
          const safeTarget = assertSafeTarget(target.target, target.prefix);
          core.ensureDir(dirname(safeTarget));
          log(`应用 ${target.prefix} → ${safeTarget}`);
          const mirrored = await mirrorDirectory({
            source: snapshotDir,
            target: safeTarget,
            excludes: targetExcludes(target.prefix),
            onLog: (message, level) => log(`${target.prefix}: ${message}`, level === 'warn' ? 'warn' : 'info'),
          });
          if (mirrored.errors.length > 0) {
            const detail = mirrored.errors
              .slice(0, 3)
              .map((item) => `${item.rel ? `${item.rel} ` : ''}${item.message}`)
              .join('；');
            throw new Error(`还原 ${target.prefix} 失败：${detail}`);
          }
          for (const item of mirrored.warnings || []) {
            warnings.push(`${target.prefix}${item.rel ? `/${item.rel}` : ''}：${item.message}`);
          }
          log(
            `已应用 ${target.prefix}：复制 ${mirrored.files} 个文件，删除 ${mirrored.removed} 个多余条目` +
              (mirrored.warnings.length ? `，${mirrored.warnings.length} 条警告` : ''),
          );
          const stat = (diff.targets || []).find((item) => item.prefix === target.prefix);
          const fileCount = Number(stat?.snapshotFiles) || 0;
          const byteCount = Number(stat?.snapshotBytes) || 0;
          appliedFiles += fileCount;
          appliedBytes += byteCount;
          applied.push({ prefix: target.prefix, target: safeTarget, files: fileCount, bytes: byteCount });
        }

        // 3) 可选：把维护插件自身重新注册回 profiles
        if (ensureSelfRegistration) {
          try {
            log('重新注册维护插件自身条目…');
            await ensureSelfRegistration();
          } catch (error) {
            warnings.push(`重新注册维护插件自身失败（可手动在 profile 中启用）：${errorMessage(error)}`);
          }
        }

        const result = {
          applied,
          totals: { files: appliedFiles, bytes: appliedBytes },
          restartRequired: true,
          selfSkipped,
          warnings,
        };
        const finishedMarker = {
          ...marker,
          phase: 'applied',
          finishedAt: core.now(),
          safetyPath: safety.path,
          targets: applied.map((item) => ({ prefix: item.prefix, target: item.target })),
          result,
        };
        core.writeJson(core.paths.pendingFile, finishedMarker);
        log(`还原已应用：${applied.length} 个目标，${appliedFiles} 个文件；需要重启 DSH 生效`);
        return {
          ok: true,
          id,
          appliedAt: finishedMarker.finishedAt,
          safety: { path: safety.path, bytes: safety.bytes, files: safety.files },
          applied,
          restartRequired: true,
          selfSkipped,
          warnings,
        };
      } catch (error) {
        try {
          core.writeJson(core.paths.pendingFile, {
            ...marker,
            phase: 'applying',
            error: errorMessage(error),
          });
        } catch {
          /* marker 写失败也不掩盖原始错误 */
        }
        log(`应用还原失败：${errorMessage(error)}`, 'error');
        throw error instanceof Error ? error : new Error(errorMessage(error));
      }
    });
  }

  // ---------------------------------------------------------------- marker / 启动收尾

  /** @returns {Promise<any | null>} */
  async function inspectPending() {
    const marker = core.readJson(core.paths.pendingFile, null);
    if (!isPlainObject(marker)) return null;
    if (marker.phase !== 'applying' && marker.phase !== 'applied') return null;
    return marker;
  }

  function clearMarker() {
    if (core.pathExists(core.paths.pendingFile)) core.removeTree(core.paths.pendingFile);
  }

  /** 清理暂存区（只清 stagingRoot 下的直接子目录）。 */
  function clearStaging() {
    const root = resolve(core.paths.stagingRoot);
    for (const entry of core.listDirSafe(root)) {
      const dir = resolve(root, `${entry.name}`);
      if (pathInside(root, dir, targetPlatform)) core.removeTree(dir);
    }
  }

  /** 没有 marker 时清理过旧暂存区，避免磁盘堆积。 */
  function pruneOldStaging() {
    const root = resolve(core.paths.stagingRoot);
    const cutoff = core.now() - STAGING_MAX_AGE_MS;
    for (const entry of core.listDirSafe(root)) {
      const dir = resolve(root, entry.name);
      if (!pathInside(root, dir, targetPlatform)) continue;
      const stat = core.statSafe(dir);
      if (stat && stat.mtimeMs < cutoff) {
        core.removeTree(dir);
        log(`清理过期暂存区 ${entry.name}`);
      }
    }
  }

  /**
   * 插件启动时调用：根据 marker 收尾。
   * @returns {Promise<{ marker: any | null, result: any | null }>}
   */
  async function finalizeOnStartup() {
    return serialize(async () => {
      const marker = await inspectPending();
      if (!marker) {
        pruneOldStaging();
        return { marker: null, result: null };
      }
      if (marker.applyPid === process.pid) {
        log('检测到还原是在当前进程中应用的（尚未重启 DSH），保留 marker 等待重启或用户确认');
        return { marker, result: null, sameProcess: true };
      }
      if (marker.phase === 'applied') {
        const targets = (Array.isArray(marker.targets) ? marker.targets : []).map((item) => ({
          prefix: String(item?.prefix || ''),
          target: String(item?.target || ''),
          exists: core.pathExists(String(item?.target || '')),
        }));
        const missingTargets = targets.filter((item) => !item.exists).map((item) => item.target);
        const result = {
          id: marker.id,
          snapshotName: marker.snapshotName,
          scope: marker.scope,
          includeSelf: Boolean(marker.includeSelf),
          appliedAt: marker.finishedAt ?? marker.startedAt ?? null,
          finalizedAt: core.now(),
          safetyPath: marker.safetyPath ?? null,
          targets,
          missingTargets,
          files: Number(marker.result?.totals?.files) || 0,
          bytes: Number(marker.result?.totals?.bytes) || 0,
          restartRequired: false,
          pendingAck: true,
        };
        core.updateState({ lastRestore: result });
        clearMarker();
        clearStaging();
        log(
          `启动收尾：上次还原已完成${missingTargets.length ? `，但 ${missingTargets.length} 个目标目录不存在` : ''}；缓存已清理`,
          missingTargets.length ? 'warn' : 'info',
        );
        return { marker, result };
      }
      // 上次在 apply 中途被打断：文件可能部分替换，不擅自继续操作
      const canRollback = Boolean(marker.safetyPath && core.pathExists(String(marker.safetyPath)));
      const result = {
        id: marker.id,
        snapshotName: marker.snapshotName,
        scope: marker.scope,
        includeSelf: Boolean(marker.includeSelf),
        interrupted: true,
        startedAt: marker.startedAt ?? null,
        finalizedAt: core.now(),
        safetyPath: marker.safetyPath ?? null,
        canRollback,
        pendingAck: true,
        message: canRollback
          ? '上次还原在应用阶段被中断，已保留安全副本；如本机配置出现异常可执行「回滚」恢复。'
          : '上次还原在应用阶段被中断，且没有可用的安全副本；请检查 profile 是否正常。',
      };
      core.updateState({ lastRestore: result });
      clearMarker();
      clearStaging();
      log(`启动收尾：上次还原被中断（${marker.snapshotName}）；安全副本${canRollback ? '可用' : '不可用'}`, 'warn');
      return { marker, result };
    });
  }

  /** 删除 marker（幂等）。 */
  async function ackPending() {
    clearMarker();
    const lastRestore = core.getState()?.lastRestore;
    if (isPlainObject(lastRestore) && lastRestore.pendingAck) {
      core.updateState({ lastRestore: { pendingAck: false } });
    }
  }

  // ---------------------------------------------------------------- 安全副本列表 / 回滚

  /** @returns {Promise<Array<{ path: string, createdAt: number, bytes: number }>>} */
  async function listSafetyBackups() {
    const root = resolve(core.paths.safetyDir);
    const backups = [];
    for (const entry of core.listDirSafe(root)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = resolve(root, entry.name);
      if (!pathInside(root, dir, targetPlatform)) continue;
      const info = readSafetyInfo(dir);
      if (!info) continue;
      let bytes = 0;
      for (const file of core.walkFiles(dir, { maxFiles: 10000 })) {
        if (/\.tar\.gz$/i.test(file.path)) bytes += Number(file.size) || 0;
      }
      backups.push({ path: dir, createdAt: Number(info.createdAt) || core.statSafe(dir)?.mtimeMs || 0, bytes });
    }
    backups.sort((a, b) => b.createdAt - a.createdAt);
    return backups;
  }

  /**
   * 回滚到最近一套安全副本。不删除安全副本本身（允许再次回滚）。
   */
  async function rollback() {
    return serialize(async () => {
      const backups = await listSafetyBackups();
      if (!backups.length) throw new Error('没有可用的安全副本，无法回滚');
      const latest = backups[0];
      const info = readSafetyInfo(latest.path);
      if (!info || !Array.isArray(info.targets)) throw new Error('安全副本缺少 safety.json，无法回滚');
      log(`开始回滚：${latest.path}（${formatBytes(latest.bytes)}）`);
      const tar = resolveTarCommand();
      const rolledTargets = [];
      const leftovers = [];
      const warnings = [];
      for (const record of info.targets) {
        const target = String(record?.target || '');
        if (!target) continue;
        let safeTarget;
        try {
          safeTarget = assertSafeTarget(target, String(record?.prefix || ''));
        } catch (error) {
          warnings.push(errorMessage(error));
          continue;
        }
        if (!record.existed) {
          // apply 时该目标原本不存在：安全副本里没有内容，无法恢复“不存在”，记录为残留
          if (core.pathExists(safeTarget)) leftovers.push(safeTarget);
          continue;
        }
        const archive = typeof record.archive === 'string' ? record.archive : '';
        if (!archive || !core.pathExists(archive)) {
          warnings.push(`安全副本缺少 ${record.prefix} 的归档文件，跳过该目标`);
          continue;
        }
        const tmp = join(core.paths.safetyDir, '.rollback-tmp', core.uuid());
        core.ensureDir(tmp);
        try {
          const extracted = await core.run(tar, ['-xzf', archive, '-C', tmp], { timeoutMs: 15 * 60 * 1000 });
          if (!extracted.ok) {
            const detail = (extracted.stderr || extracted.error || '').trim().split('\n').slice(-3).join(' ');
            warnings.push(`解压安全副本失败（${record.prefix}）${detail ? `：${detail}` : ''}`);
            continue;
          }
          core.ensureDir(safeTarget);
          const mirrored = await mirrorDirectory({
            source: tmp,
            target: safeTarget,
            excludes: targetExcludes(String(record.prefix || '')),
            onLog: (message, level) => log(`回滚 ${record.prefix}: ${message}`, level === 'warn' ? 'warn' : 'info'),
          });
          if (mirrored.errors.length > 0) {
            const detail = mirrored.errors
              .slice(0, 3)
              .map((item) => `${item.rel ? `${item.rel} ` : ''}${item.message}`)
              .join('；');
            warnings.push(`回滚 ${record.prefix} 失败：${detail}`);
            continue;
          }
          for (const item of mirrored.warnings || []) {
            warnings.push(`回滚 ${record.prefix}${item.rel ? `/${item.rel}` : ''}：${item.message}`);
          }
          rolledTargets.push({ prefix: record.prefix, target: safeTarget });
          log(`已回滚 ${record.prefix} → ${safeTarget}`);
        } finally {
          core.removeTree(tmp);
        }
      }
      core.removeTree(join(core.paths.safetyDir, '.rollback-tmp'));
      const rolledBackAt = core.now();
      core.updateState({
        lastRestore: {
          rolledBack: true,
          rolledBackAt,
          safetyPath: latest.path,
          rolledTargets: rolledTargets.map((item) => item.prefix),
          leftovers,
          pendingAck: false,
        },
      });
      clearMarker();
      log(`回滚完成：${rolledTargets.length} 个目标${warnings.length ? `，${warnings.length} 条警告` : ''}`);
      return {
        ok: true,
        rolledBackAt,
        safetyPath: latest.path,
        targets: rolledTargets,
        leftovers,
        warnings,
        restartRequired: true,
      };
    });
  }

  return {
    folders,
    listSnapshots,
    preview,
    stage,
    apply,
    discard,
    rollback,
    inspectPending,
    finalizeOnStartup,
    ackPending,
    listSafetyBackups,
  };
}
