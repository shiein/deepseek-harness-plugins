/**
 * 原生备份引擎 —— 跨平台备份流水线（纯 Node，替代 ~/.dsh-sync/sync.sh）。
 *
 * 流程：
 *   指纹（size + mtime + dest 路径）→ 不变则 skip → 逐条目 mirror 到 stage
 *   → 写 MANIFEST.json / RESTORE.md → 密钥扫描 → tar.gz → sha256 → sidecar
 *   → 上传 tar → 上传 sidecar（失败仅警告）→ 浏览 dsh/ 滚动归档 → 写指纹 → 清理。
 *
 * 跨平台约定（macOS / Windows / Linux）：
 * - 只用 node 内置模块 + core.run + platform.js，tar 路径来自 resolveTarCommand()；
 * - 路径一律走 node:path，包内路径用 posix（`dsh-home/...`）；
 * - 取消只用 AbortSignal 检查，不依赖 Unix 信号语义；
 * - 不可读目录抛错，绝不生成/上传残缺快照；
 * - 上传或列目录失败时保留旧指纹，下次自动重试。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { compileExcludes, mirrorDirectory } from '../mirror.js';
import { PLATFORM, resolveTarCommand } from '../platform.js';
import { pruneExcludesFor } from './config.js';
import { planRotation } from './rotation.js';
import { scanSecrets } from './secret-scan.js';
import { buildSidecar, buildStagedFileList, writeManifestAndRestore } from './sidecar.js';

const STAGE_INFO = {
  prepare: { label: '准备', progress: 6 },
  pack: { label: '打包', progress: 30 },
  scan: { label: '敏感信息扫描', progress: 48 },
  upload: { label: '上传网盘', progress: 62 },
  archive: { label: '归档旧快照', progress: 88 },
  done: { label: '完成', progress: 100 },
  skip: { label: '无变更', progress: 100 },
  error: { label: '失败', progress: 100 },
};

/** @param {number} number */
function pad(number) {
  return String(number).padStart(2, '0');
}

/** @param {Date} date 本地时间戳，如 2026-11-04_180102 */
function formatSnapshotStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** @param {string} message */
function describeError(message) {
  return String(message || '未知错误');
}

/** @param {unknown} value */
function clampKeep(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return 5;
  return Math.min(10, Math.max(1, number));
}

/**
 * 单条目的排除规则（通用规则 + 把 pruneAbs 转成该条目根下的相对路径）。
 * @param {string} src
 * @param {string[]} excludes
 * @param {string[]} pruneAbs
 * @param {NodeJS.Platform} platform
 */
function entryExcludes(src, excludes, pruneAbs, platform) {
  const prune = pruneExcludesFor(src, pruneAbs, platform);
  return { whole: prune.whole, patterns: [...excludes, ...prune.excludes] };
}

/**
 * 计算指纹：size + mtime + 包内 dest 路径。不可读目录直接抛错（禁止残缺快照）。
 * @param {{
 *   entries: Array<{src:string,dest:string}>,
 *   excludes: string[],
 *   pruneAbs: string[],
 *   platform: NodeJS.Platform,
 * }} input
 */
function computeFingerprint(input) {
  const { entries, excludes, pruneAbs, platform } = input;
  /** @type {string[]} */
  const lines = [];
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    let info;
    try {
      info = statSync(entry.src);
    } catch {
      continue; // 不存在的条目在复制阶段会写 warning 并跳过
    }
    if (!info.isDirectory()) continue;
    const { whole, patterns } = entryExcludes(entry.src, excludes, pruneAbs, platform);
    if (whole) continue;
    const isExcluded = compileExcludes(patterns);
    /** @type {Array<{dir:string, rel:string}>} */
    const stack = [{ dir: entry.src, rel: '' }];
    while (stack.length > 0) {
      const current = stack.pop();
      let list;
      try {
        list = readdirSync(current.dir, { withFileTypes: true });
      } catch (error) {
        throw new Error(`无法读取目录 ${current.dir}（权限不足或目录已损坏）：${describeError(error?.message || error)}`);
      }
      for (const item of list) {
        const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
        if (isExcluded(rel)) continue;
        const abs = join(current.dir, item.name);
        if (item.isSymbolicLink()) continue; // 与旧 find -type f 一致：不跟随符号链接
        if (item.isDirectory()) {
          stack.push({ dir: abs, rel });
          continue;
        }
        if (!item.isFile()) continue;
        let fileInfo;
        try {
          fileInfo = statSync(abs);
        } catch (error) {
          throw new Error(`无法读取文件 ${abs}：${describeError(error?.message || error)}`);
        }
        lines.push(`${fileInfo.size} ${Math.floor(fileInfo.mtimeMs)} ${entry.dest}/${rel}`);
        files += 1;
        bytes += fileInfo.size;
      }
    }
  }
  lines.sort();
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex');
  return { hash, files, bytes };
}

/**
 * 运行原生备份。
 *
 * @param {{
 *   core: ReturnType<import('../core.js').createCore>,
 *   quark: { upload: Function, browseAll: Function, move: Function },  // 由 Lead 注入（host/quark.js）
 *   config: Awaited<ReturnType<import('./config.js').loadNativeConfig>>,
 *   keep?: number,
 *   force?: boolean,
 *   trigger?: string,
 *   signal?: AbortSignal,
 *   onEvent?: (event: { stage: string, label?: string, progress?: number, line?: string }) => void,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped: boolean,
 *   snapshotName: string|null,
 *   sizeMB: number,
 *   archived: number,
 *   partial: boolean,
 *   durationMs: number,
 *   fileCount: number,
 *   totalBytes: number,
 *   sidecarName: string|null,
 *   warnings: string[],
 * }>}
 */
export async function runNativeBackup(input) {
  const {
    core,
    quark,
    config,
    keep,
    force = false,
    trigger = 'manual',
    signal,
    onEvent,
  } = input || /** @type {any} */ ({});
  if (!core) throw new Error('原生备份缺少 core');
  if (!quark) throw new Error('原生备份缺少 quark');
  if (!config || !Array.isArray(config.entries)) throw new Error('原生备份缺少有效配置（config.entries）');
  if (typeof quark.upload !== 'function' || typeof quark.browseAll !== 'function') {
    throw new Error('原生备份需要可用的 quark.upload / quark.browseAll');
  }

  const startedAt = core.now();
  const warnings = [];
  const platform = config.paths?.platform || PLATFORM;
  const keepValue = clampKeep(keep ?? config.keep ?? 5);
  const excludes = Array.isArray(config.excludes) ? config.excludes : [];
  const pruneAbs = Array.isArray(config.pruneAbs) ? config.pruneAbs : [];
  const dataDir = core.paths?.dataDir || join(core.paths?.home || '.', '.dsh-maintenance');
  const stageBase = join(dataDir, 'stage');
  const stageDir = join(stageBase, `native-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const fingerprintFile = join(dataDir, 'state', 'native-fingerprint.json');
  const keepStage = process.env.DSH_MAINTENANCE_KEEP_STAGE === '1';

  /** @type {{ stage: string, label: string, progress: number }} */
  let current = { stage: 'prepare', label: STAGE_INFO.prepare.label, progress: STAGE_INFO.prepare.progress };
  let tarPath = null;
  let sidecarPath = null;
  let snapshotName = null;

  const aborted = () => Boolean(signal?.aborted);
  const checkAbort = () => {
    if (aborted()) throw new Error('已取消');
  };

  /** 写一条日志/事件（同时进 UI logTail 与插件日志）。 */
  function pushLine(text, level = 'info') {
    if (level === 'warn') warnings.push(text);
    try {
      core.log?.(text, level);
    } catch {
      /* 日志失败不影响备份 */
    }
    try {
      onEvent?.({
        stage: current.stage,
        label: current.label,
        progress: current.progress,
        line: text,
      });
    } catch {
      /* UI 回调异常不影响备份 */
    }
    checkAbort();
  }

  /** 进入新阶段，并可选写一行日志（会先检查取消）。 */
  function enter(stage, progress, line, label) {
    current = {
      stage,
      label: label || STAGE_INFO[stage]?.label || stage,
      progress: progress ?? STAGE_INFO[stage]?.progress ?? current.progress,
    };
    if (line) pushLine(line);
    else checkAbort();
  }

  /** 失败时单独上报 error 事件，不因回调异常掩盖原始错误。 */
  function emitErrorEvent(message) {
    try {
      onEvent?.({
        stage: 'error',
        label: aborted() ? '已取消' : '失败',
        progress: 100,
        line: `ERROR: ${message}`,
      });
    } catch {
      /* ignore */
    }
  }

  /** 清理 stage/tar/sidecar（KEEP_STAGE=1 时保留排查）。 */
  function cleanup() {
    if (keepStage) {
      try {
        core.log?.(`已保留备份临时目录（DSH_MAINTENANCE_KEEP_STAGE=1）：${stageDir}`, 'warn');
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      core.removeTree?.(stageDir);
    } catch {
      /* ignore */
    }
    for (const file of [tarPath, sidecarPath]) {
      if (!file) continue;
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }

  /** 使用系统 tar；不支持 gzip 时退回 tar -cf + node:zlib。 */
  async function createArchive(targetPath) {
    checkAbort();
    const tarCommand = resolveTarCommand();
    pushLine(`使用 ${tarCommand} 打包压缩…`);
    const gzipResult = await core.run(tarCommand, ['-czf', targetPath, '-C', stageDir, '.'], {
      timeoutMs: 15 * 60 * 1000,
    });
    if (gzipResult.ok) return;
    const detail = (gzipResult.stderr || gzipResult.error || '').trim().split('\n').slice(-2).join(' ');
    pushLine(`WARN: 系统 tar 不支持 gzip 或直接打包失败（${detail || `退出码 ${gzipResult.code}`}），改用 tar -cf + node:zlib 压缩`, 'warn');
    checkAbort();
    const plainPath = `${targetPath}.tar`;
    const plainResult = await core.run(tarCommand, ['-cf', plainPath, '-C', stageDir, '.'], {
      timeoutMs: 15 * 60 * 1000,
    });
    if (!plainResult.ok) {
      const plainDetail = (plainResult.stderr || plainResult.error || '').trim().split('\n').slice(-3).join(' ');
      throw new Error(`打包压缩失败：${plainDetail || `tar 退出码 ${plainResult.code}`}`);
    }
    checkAbort();
    try {
      await pipeline(createReadStream(plainPath), createGzip({ level: 6 }), createWriteStream(targetPath));
    } finally {
      try {
        unlinkSync(plainPath);
      } catch {
        /* ignore */
      }
    }
    checkAbort();
  }

  let fileCount = 0;
  let totalBytes = 0;
  let archived = 0;

  try {
    if (!config.dshFid) throw new Error('缺少夸克网盘 dsh 目录 FID，无法备份');
    const disabledSet = new Set(Array.isArray(config.disabledEntries) ? config.disabledEntries : []);
    const activeEntries = config.entries.filter((entry) => entry?.src && !disabledSet.has(entry.src));
    if (activeEntries.length === 0) throw new Error('没有可备份的条目（可能全部被禁用）');

    enter('prepare', 6, `开始备份（trigger=${trigger}，${force ? '强制' : '按指纹检测'}，保留 ${keepValue} 份）`);
    pushLine(`备份条目 ${activeEntries.length} 个；先计算变更指纹…`);

    const fingerprint = computeFingerprint({ entries: activeEntries, excludes, pruneAbs, platform });
    pushLine(`指纹 ${fingerprint.hash.slice(0, 16)}… 文件数 ${fingerprint.files}，${core.formatBytes ? core.formatBytes(fingerprint.bytes) : `${fingerprint.bytes} B`}`);
    if (!force) {
      const previous = core.readJson(fingerprintFile, null);
      if (previous && typeof previous.hash === 'string' && previous.hash === fingerprint.hash) {
        enter('skip', 100, '无变更，跳过同步');
        return {
          ok: true,
          skipped: true,
          snapshotName: null,
          sizeMB: 0,
          archived: 0,
          partial: false,
          durationMs: core.now() - startedAt,
          fileCount: fingerprint.files,
          totalBytes: fingerprint.bytes,
          sidecarName: null,
          warnings,
        };
      }
    }

    snapshotName = `dsh-snap-${formatSnapshotStamp(new Date())}.tar.gz`;
    enter('pack', 30, `开始打包：${snapshotName}`);
    core.ensureDir(stageDir);
    core.ensureDir(join(stageDir, 'dsh-home'));
    core.ensureDir(join(stageDir, 'workspace'));

    /** @type {Array<{dest:string, files:number, bytes:number}>} */
    const entryStats = [];
    let index = 0;
    for (const entry of activeEntries) {
      checkAbort();
      const { whole, patterns } = entryExcludes(entry.src, excludes, pruneAbs, platform);
      if (whole) {
        pushLine(`WARN: 条目被运行时排除规则整体跳过：${entry.src}`, 'warn');
        continue;
      }
      let info;
      try {
        info = statSync(entry.src);
      } catch {
        info = null;
      }
      if (!info) {
        pushLine(`WARN: 跳过不存在的目录 ${entry.src}`, 'warn');
        continue;
      }
      if (!info.isDirectory()) {
        pushLine(`WARN: 跳过非目录条目 ${entry.src}`, 'warn');
        continue;
      }
      const target = join(stageDir, ...String(entry.dest).split('/'));
      let result;
      try {
        result = await mirrorDirectory({
          source: entry.src,
          target,
          excludes: patterns,
          signal,
          onLog: (message) => pushLine(`WARN: ${message}`, 'warn'),
        });
      } catch (error) {
        throw new Error(`复制备份条目失败（${entry.src}）：${describeError(error?.message || error)}`);
      }
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const detail = result.errors
          .slice(0, 3)
          .map((item) => `${item.rel}（${item.message}）`)
          .join('；');
        throw new Error(`复制备份条目不完整（${entry.src}）：${detail}`);
      }
      for (const warning of result.warnings || []) {
        pushLine(`WARN: ${entry.dest}/${warning.rel}：${warning.message}`, 'warn');
      }
      entryStats.push({ dest: entry.dest, files: result.files, bytes: result.bytes });
      index += 1;
      current.progress = Math.min(44, 30 + Math.round((index / activeEntries.length) * 14));
      pushLine(
        `已加入 ${entry.dest}（${result.files} 个文件，${core.formatBytes ? core.formatBytes(result.bytes) : `${result.bytes} B`}）`,
      );
    }
    if (entryStats.length === 0) throw new Error('所有备份条目都不存在或不可复制，已取消本次备份');

    enter('pack', 46, '生成 MANIFEST.json 与 RESTORE.md…');
    const files = buildStagedFileList(stageDir);
    fileCount = files.length;
    totalBytes = files.reduce((sum, item) => sum + item[1], 0);
    writeManifestAndRestore(stageDir, {
      snapshotName,
      files,
      entries: entryStats,
      platform: platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux',
      engine: 'native',
      partial: false,
    });

    enter('scan', 48, `敏感信息扫描（${fileCount} 个文件）…`);
    const scan = scanSecrets(stageDir);
    if (scan.testHits.length > 0) {
      pushLine(`提示: ${scan.testHits.length} 个测试文件含假密钥样本，未阻断（已扫描 ${scan.scanned} 个文件）`, 'warn');
    }
    if (scan.hits.length > 0) {
      const samples = scan.hits.slice(0, 5).join('、');
      throw new Error(
        `敏感信息扫描未通过：检测到 ${scan.hits.length} 个疑似含真实密钥/私钥的非测试文件（${samples}${scan.hits.length > 5 ? ' 等' : ''}），已中止上传`,
      );
    }
    current.progress = 52;
    pushLine('敏感信息扫描通过');

    enter('pack', 56, `生成压缩包 ${snapshotName}…`);
    tarPath = join(stageBase, snapshotName);
    await createArchive(tarPath);
    let archiveInfo;
    try {
      archiveInfo = statSync(tarPath);
    } catch {
      throw new Error(`打包完成但压缩包不存在：${tarPath}`);
    }
    if (!archiveInfo.isFile() || archiveInfo.size <= 0) throw new Error('打包压缩失败：压缩包为空');
    const sizeMB = Math.round((archiveInfo.size / 1024 / 1024) * 10) / 10;
    checkAbort();
    pushLine(`快照打包完成: ${snapshotName}（${sizeMB} MB）`);

    const archiveSha256 = core.sha256File(tarPath);
    const sidecar = buildSidecar({
      snapshotName,
      archivePath: tarPath,
      archiveSha256,
      files,
      entries: entryStats,
      partial: false,
      createdAt: startedAt,
    });
    sidecarPath = join(stageBase, `${snapshotName.replace(/\.tar\.gz$/, '')}.manifest.json`);
    core.writeText(sidecarPath, `${JSON.stringify(sidecar)}\n`);
    pushLine(`sidecar 清单生成: ${snapshotName.replace(/\.tar\.gz$/, '')}.manifest.json（${core.formatBytes ? core.formatBytes(sidecar.archive_size) : `${sidecar.archive_size} B`}）`);

    enter('upload', 62, '上传到夸克网盘/dsh …');
    let upload;
    try {
      upload = await quark.upload(tarPath, config.dshFid);
    } catch (error) {
      throw new Error(`上传快照失败：${describeError(error?.message || error)}`);
    }
    checkAbort();
    if (!upload?.ok || !upload.fid) {
      throw new Error(`上传快照失败${upload?.msg ? `：${upload.msg}` : upload?.code !== undefined ? `（code=${upload.code}）` : ''}`);
    }
    current.progress = 76;
    pushLine(`上传成功: ${snapshotName}${upload.fid ? `（FID ${upload.fid}）` : ''}`);

    // sidecar 上传失败不影响本次备份，只记录 warning
    try {
      const sidecarUpload = await quark.upload(sidecarPath, config.dshFid);
      if (sidecarUpload?.ok && sidecarUpload.fid) {
        current.progress = 80;
        pushLine(`sidecar 清单已上传: ${snapshotName.replace(/\.tar\.gz$/, '')}.manifest.json`);
      } else {
        pushLine('WARN: sidecar 清单上传失败（不影响本次备份）', 'warn');
      }
    } catch (error) {
      pushLine(`WARN: sidecar 清单上传失败（不影响本次备份）：${describeError(error?.message || error)}`, 'warn');
    }

    enter('archive', 88, '滚动归档：列出 dsh/ 目录…');
    let browse;
    try {
      browse = await quark.browseAll(config.dshFid);
    } catch (error) {
      throw new Error(`列出网盘目录失败：${describeError(error?.message || error)}`);
    }
    if (!browse?.ok) {
      throw new Error(`列出网盘目录失败${browse?.msg ? `：${browse.msg}` : ''}`);
    }
    checkAbort();
    const rotation = planRotation(Array.isArray(browse.entries) ? browse.entries : [], keepValue);
    const snapshotTotal = rotation.kept.length + rotation.pruned.filter((name) => name.endsWith('.tar.gz')).length;
    pushLine(`dsh/ 下现有快照 ${snapshotTotal} 份（保留 ${keepValue} 份；sidecar 不占配额）`);
    if (rotation.pruneFids.length > 0) {
      const archiveFid = config.archiveFid;
      if (!archiveFid) {
        pushLine('WARN: 未配置 dsh/_archive 的 FID，本次跳过滚动归档', 'warn');
      } else {
        let moved = null;
        try {
          moved = await quark.move(rotation.pruneFids, archiveFid);
        } catch (error) {
          pushLine(`WARN: 归档旧快照失败（不影响本次同步）：${describeError(error?.message || error)}`, 'warn');
        }
        if (moved?.ok) {
          archived = rotation.pruneFids.length;
          current.progress = 92;
          pushLine(`已归档 ${archived} 个对象（旧快照 + 对应 sidecar）到 dsh/_archive`);
        } else if (moved) {
          pushLine(`WARN: 归档旧快照失败（不影响本次同步）：${moved.msg || `code=${moved.code}`}`, 'warn');
        }
      }
    } else {
      current.progress = 90;
      pushLine('未超过保留份数，无需归档');
    }
    checkAbort();

    core.writeJson(fingerprintFile, {
      hash: fingerprint.hash,
      files: fileCount,
      bytes: totalBytes,
      at: core.now(),
      trigger,
      platform,
    });
    enter('done', 100, `=== 同步完成: ${snapshotName} ===`);

    return {
      ok: true,
      skipped: false,
      snapshotName,
      sizeMB,
      archived,
      partial: false,
      durationMs: core.now() - startedAt,
      fileCount,
      totalBytes,
      sidecarName: sidecarPath ? basename(sidecarPath) : null,
      warnings,
    };
  } catch (error) {
    const message = describeError(error?.message || error);
    emitErrorEvent(message);
    try {
      core.log?.(`备份失败：${message}`, 'error');
    } catch {
      /* ignore */
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    cleanup();
  }
}
