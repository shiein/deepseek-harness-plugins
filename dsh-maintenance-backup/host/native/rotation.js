/**
 * 原生备份引擎 —— 滚动保留计划（纯函数，无 IO，便于单测）。
 *
 * 与旧 `~/.dsh-sync/parse-browse.cjs prune` 语义一致：
 * - 快照 tar.gz 按文件名（即时间戳）倒序，保留最新 keep 份；
 * - 超出的 tar 连同对应 sidecar 一起移入 `_archive`（夸克 CLI 无删除能力）；
 * - 兼容没有 sidecar 的旧快照；
 * - 比"保留边界"更新的孤儿 sidecar（刚上传、tar 还没出现）不动，避免误删新清单。
 */

const TAR_RE = /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/;
const SIDECAR_RE = /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.manifest\.json$/;

/** @param {string} filename */
function tarBaseOfSidecar(filename) {
  return filename.replace(/\.manifest\.json$/, '.tar.gz');
}

/** 文件名倒序（tar 名里的时间戳可直接比较）。 @param {{filename:string}} a @param {{filename:string}} b */
function compareDesc(a, b) {
  if (a.filename < b.filename) return 1;
  if (a.filename > b.filename) return -1;
  return 0;
}

/**
 * 计算本次需要归档的对象。
 *
 * @param {Array<{fid:string, filename:string}>} browseEntries `quark.browseAll(dshFid).entries`
 * @param {number} [keep] 保留份数（默认 5）
 * @returns {{
 *   kept: string[],        // 保留的 tar 文件名（最多 keep 个）
 *   pruneFids: string[],   // 需要 move 到 _archive 的 FID（先 tar 后 sidecar）
 *   pruned: string[],      // 需要 move 的文件名（与 pruneFids 一一对应）
 * }}
 */
export function planRotation(browseEntries, keep = 5) {
  const keepCount = Number.isFinite(Number(keep)) ? Math.max(0, Math.trunc(Number(keep))) : 5;
  /** @type {Array<{fid:string, filename:string}>} */
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(browseEntries) ? browseEntries : []) {
    if (!item || typeof item !== 'object') continue;
    const filename = typeof item.filename === 'string' ? item.filename : '';
    const fid = typeof item.fid === 'string' ? item.fid : '';
    if (!filename || !fid || seen.has(fid)) continue;
    seen.add(fid);
    rows.push({ fid, filename });
  }

  const tars = rows.filter((row) => TAR_RE.test(row.filename)).sort(compareDesc);
  const sidecars = rows.filter((row) => SIDECAR_RE.test(row.filename)).sort(compareDesc);

  const keptTars = tars.slice(0, keepCount);
  const prunedTars = tars.slice(keepCount);
  const keptNames = new Set(keptTars.map((row) => row.filename));
  const oldestKeptName = keptTars.length > 0 ? keptTars[keptTars.length - 1].filename : '';

  /** @type {string[]} */
  const pruneFids = [];
  /** @type {string[]} */
  const pruned = [];
  for (const row of prunedTars) {
    pruneFids.push(row.fid);
    pruned.push(row.filename);
  }
  for (const row of sidecars) {
    const base = tarBaseOfSidecar(row.filename);
    // 对应的 tar 仍被保留 → 清单也要保留
    if (keptNames.has(base)) continue;
    // 只归档"比保留边界更旧"的 sidecar；更新的孤儿清单（tar 尚未上传）不动
    if (oldestKeptName && base > oldestKeptName) continue;
    pruneFids.push(row.fid);
    pruned.push(row.filename);
  }

  return {
    kept: keptTars.map((row) => row.filename),
    pruneFids,
    pruned,
  };
}
