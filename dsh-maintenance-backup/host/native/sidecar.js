/**
 * 原生备份引擎 —— 快照清单生成。
 *
 * - `MANIFEST.json` / `RESTORE.md`：包内元信息与恢复说明（与旧 sync.sh 快照同构）；
 * - sidecar（`dsh-snap-<ts>.manifest.json`）：与旧 `make-sidecar.cjs` 字段完全一致，
 *   还原预览只需下载这个小文件（约 390KB），确认后再下载 tar。
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** 包内元信息文件：不进入 sidecar 的 files 清单（旧 make-sidecar 同样只统计同步内容）。 */
const META_FILES = new Set(['MANIFEST.json', 'RESTORE.md', 'WARNING-PARTIAL-SNAPSHOT.txt']);

/** @param {number} number @param {number} [width] */
function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

/**
 * 本地时区时间字符串（与旧 `date '+%Y-%m-%dT%H:%M:%S%z'` 一致，例如 2026-11-04T18:00:00+0800）。
 * @param {Date} date
 */
export function formatLocalTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}

/**
 * 遍历暂存目录，返回 [[包内 posix 路径, 字节数], ...]（按路径排序，不含顶层元信息文件）。
 * @param {string} stageDir
 * @returns {Array<[string, number]>}
 */
export function buildStagedFileList(stageDir) {
  /** @type {Array<[string, number]>} */
  const files = [];
  const root = String(stageDir || '');
  if (!root) return files;
  /** @type {Array<{dir:string, rel:string}>} */
  const stack = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let list;
    try {
      list = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of list) {
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
      const abs = join(current.dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        stack.push({ dir: abs, rel });
        continue;
      }
      if (!item.isFile()) continue;
      if (!current.rel && META_FILES.has(item.name)) continue;
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      files.push([rel, info.size]);
    }
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
}

/**
 * 与 make-sidecar.cjs 相同的按目录聚合规则。
 * @param {string} filePath
 */
function aggregatePrefix(filePath) {
  const segments = String(filePath).split('/');
  if (segments[0] === 'workspace') return segments.slice(0, 2).join('/');
  if (segments[0] === 'dsh-home') return segments.slice(0, 2).join('/');
  return segments[0];
}

/**
 * 生成 sidecar 清单对象（字段与 make-sidecar.cjs 完全一致）。
 *
 * @param {{
 *   snapshotName: string,
 *   archivePath: string,
 *   archiveSha256: string,
 *   files: Array<[string, number]>,
 *   entries?: Array<{dest:string,files:number,bytes:number}>,
 *   partial?: boolean,
 *   createdAt?: number|string|Date,
 * }} input
 */
export function buildSidecar(input) {
  const {
    snapshotName,
    archivePath,
    archiveSha256,
    files,
    partial = false,
    createdAt,
  } = input || /** @type {any} */ ({});
  /** @type {Array<[string, number]>} */
  const list = Array.isArray(files) ? files.map((item) => [String(item[0]), Number(item[1]) || 0]) : [];
  let totalBytes = 0;
  /** @type {Map<string, {dest:string, files:number, bytes:number}>} */
  const aggregates = new Map();
  for (const [filePath, size] of list) {
    totalBytes += size;
    const prefix = aggregatePrefix(filePath);
    const aggregate = aggregates.get(prefix) || { dest: prefix, files: 0, bytes: 0 };
    aggregate.files += 1;
    aggregate.bytes += size;
    aggregates.set(prefix, aggregate);
  }
  let archiveSize = 0;
  try {
    archiveSize = statSync(archivePath).size;
  } catch {
    archiveSize = 0;
  }
  const createdDate = createdAt === undefined ? new Date() : createdAt instanceof Date ? createdAt : new Date(createdAt);
  const createdIso = Number.isNaN(createdDate.getTime()) ? new Date().toISOString() : createdDate.toISOString();
  return {
    schema: 1,
    name: String(snapshotName || ''),
    created_at: createdIso,
    hostname: hostname(),
    archive_sha256: String(archiveSha256 || '').toLowerCase(),
    archive_size: archiveSize,
    file_count: list.length,
    total_bytes: totalBytes,
    partial: Boolean(partial),
    entries: [...aggregates.values()].sort((a, b) => a.dest.localeCompare(b.dest)),
    files: list,
  };
}

/**
 * 生成 RESTORE.md 内容（按平台给不同的命令示例）。
 * @param {{ engine: string, platform: NodeJS.Platform, partial: boolean }} input
 */
function buildRestoreMarkdown(input) {
  const engineLabel = input.engine === 'native' ? '原生备份引擎（host/native）' : String(input.engine || 'native');
  const isWindows = input.platform === 'win32';
  const steps = isWindows
    ? [
        '```powershell',
        '# 1. 解压（Windows 10 1803+ 自带 tar.exe）',
        'mkdir $env:TEMP\\dsh-restore -Force | Out-Null',
        'tar -xzf dsh-snap-*.tar.gz -C $env:TEMP\\dsh-restore',
        '',
        '# 2. 还原 ~/.dsh（先备份原有目录）',
        'if (Test-Path $env:USERPROFILE\\.dsh) {',
        '  Move-Item $env:USERPROFILE\\.dsh "$env:USERPROFILE\\.dsh.bak.$(Get-Date -UFormat %s)"',
        '}',
        'New-Item -ItemType Directory -Force $env:USERPROFILE\\.dsh | Out-Null',
        'Copy-Item -Recurse -Force $env:TEMP\\dsh-restore\\dsh-home\\* $env:USERPROFILE\\.dsh\\',
        '',
        '# 3. 还原插件工程',
        'Copy-Item -Recurse -Force $env:TEMP\\dsh-restore\\workspace\\* $env:USERPROFILE\\Documents\\workspace\\',
        '',
        '# 4. 重装依赖（node_modules 不在快照内）',
        'cd $env:USERPROFILE\\.dsh\\profiles\\desktop; pnpm install',
        '```',
      ]
    : [
        '```bash',
        '# 1. 解压',
        'mkdir -p /tmp/dsh-restore && tar -xzf dsh-snap-*.tar.gz -C /tmp/dsh-restore',
        '',
        '# 2. 还原 ~/.dsh（先备份原有目录）',
        '[ -d ~/.dsh ] && mv ~/.dsh ~/.dsh.bak.$(date +%s)',
        'mkdir -p ~/.dsh && cp -R /tmp/dsh-restore/dsh-home/. ~/.dsh/',
        '',
        '# 3. 还原插件工程',
        'mkdir -p ~/Documents/workspace',
        'cp -R /tmp/dsh-restore/workspace/. ~/Documents/workspace/',
        '',
        '# 4. 重装依赖（node_modules 不在快照内）',
        'cd ~/.dsh/profiles/desktop && pnpm install',
        '```',
      ];
  return [
    '# DSH 配置与插件快照 —— 恢复说明',
    '',
    `本压缩包由「网盘备份维护」插件的${engineLabel}自动生成，包含 DSH 的配置、技能与插件源码`,
    '（不含 node_modules、.git 与 API 密钥）。',
    '',
    '## 目录结构',
    '',
    '| 包内路径 | 对应本机位置 |',
    '|---|---|',
    '| `dsh-home/` | `~/.dsh/`（profiles、skills、plugins、.agent-presets 等） |',
    '| `workspace/` | `~/Documents/workspace/` 下的插件工程 |',
    '| `dsh-sync/` | `~/.dsh-sync/`（同步配置与脚本，不含 state/logs） |',
    '| `MANIFEST.json` | 快照元信息 |',
    '',
    '## 恢复步骤（新电脑）',
    '',
    ...steps,
    '',
    '# 5. 手动补齐密钥：新建 ~/.dsh/.credentials.yaml（快照中不含）',
    '# 6. 重启 DSH，确认插件列表与配置一致',
    '',
    '## 注意事项',
    '',
    '- 配置中若含绝对路径（如 `link:/Users/<用户名>/...`），换机后需改成新机器的路径。',
    '- 同名的 `.manifest.json` sidecar 含逐文件清单与 SHA-256，可用于还原前校验。',
    `- 本快照${input.partial ? '为不完整快照，缺少部分目录' : '为完整快照'}（见 MANIFEST.json 的 partial 字段）。`,
    '',
  ].join('\n');
}

/**
 * 在暂存目录写入 MANIFEST.json 与 RESTORE.md。
 *
 * @param {string} stageDir
 * @param {{
 *   snapshotName: string,
 *   files: Array<[string, number]>,
 *   entries?: Array<{dest:string,files:number,bytes:number}>,
 *   platform?: NodeJS.Platform,
 *   engine?: string,
 *   partial?: boolean,
 * }} input
 * @returns {{ manifestPath: string, restorePath: string, manifest: object }}
 */
export function writeManifestAndRestore(stageDir, input) {
  const {
    snapshotName,
    files = [],
    entries = [],
    platform = process.platform,
    engine = 'native',
    partial = false,
  } = input || /** @type {any} */ ({});
  const list = Array.isArray(files) ? files : [];
  let totalBytes = 0;
  for (const item of list) totalBytes += Number(item[1]) || 0;
  const manifest = {
    name: String(snapshotName || ''),
    created_at: formatLocalTimestamp(new Date()),
    hostname: hostname(),
    file_count: list.length,
    approx_size_mb: Number((totalBytes / 1024 / 1024).toFixed(1)),
    partial: Boolean(partial),
    contents: ['dsh-home/', 'workspace/', 'RESTORE.md', 'MANIFEST.json'],
    excludes: ['node_modules', '.git', '.DS_Store', '*.log', '*.tmp', '.credentials.yaml'],
    note: 'DSH 配置与插件全量快照；API 密钥未包含在快照内',
    entries: Array.isArray(entries) ? entries : [],
  };
  const manifestPath = join(stageDir, 'MANIFEST.json');
  const restorePath = join(stageDir, 'RESTORE.md');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    restorePath,
    `${buildRestoreMarkdown({ engine, platform, partial: Boolean(partial) })}`,
    'utf8',
  );
  return { manifestPath, restorePath, manifest };
}
