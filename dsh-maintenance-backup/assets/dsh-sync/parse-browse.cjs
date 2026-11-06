#!/usr/bin/env node
// @dsh-maintenance-tools-version 2
// 解析夸克 browse 的 NDJSON 输出，提取目录条目
//
// 用法:
//   node parse-browse.cjs <browse输出文件> snapshots        # 仅 tar.gz：文件名\tFID
//   node parse-browse.cjs <browse输出文件> sidecars         # 仅 sidecar 清单
//   node parse-browse.cjs <browse输出文件> all              # 两类都输出
//   node parse-browse.cjs <browse输出文件> prune [keep=5]   # 输出需要移入 _archive 的 FID（tar + 对应 sidecar）
//
// 注意：sidecar（*.manifest.json）不占 KEEP 份数，滚动归档时随对应快照一起移动。

const fs = require('fs');

const file = process.argv[2];
const mode = process.argv[3] || 'snapshots';
const keep = Math.max(0, Number.parseInt(process.argv[4] || '5', 10) || 0);
if (!file) {
  console.error('用法: node parse-browse.cjs <browse输出文件> [snapshots|sidecars|all|prune] [keep]');
  process.exit(2);
}

const TAR_RE = /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/;
const SIDECAR_RE = /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.manifest\.json$/;

const entries = new Map();
const artifacts = [];

function addRows(rows) {
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    if (r && typeof r === 'object' && r.filename && r.fid) entries.set(r.fid, r);
  }
}

function ingestLine(line) {
  const s = line.trim();
  if (!s) return;
  let o;
  try {
    o = JSON.parse(s);
  } catch {
    return;
  }
  if (!o || typeof o !== 'object') return;
  addRows((o.data && o.data.file_list) || o.file_list);
  const fp = o.data && o.data.file_path;
  if (typeof fp === 'string' && fp) artifacts.push(fp);
  if (o.type === 'artifact' && o.data && typeof o.data.file_path === 'string') {
    artifacts.push(o.data.file_path);
  }
  if (o.filename && o.fid) addRows([o]);
}

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
for (const line of raw.split('\n')) ingestLine(line);

for (const p of artifacts) {
  let txt;
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  for (const line of txt.split('\n')) ingestLine(line);
}

const rows = [...entries.values()];
const tars = rows.filter((r) => TAR_RE.test(r.filename));
const sidecars = rows.filter((r) => SIDECAR_RE.test(r.filename));

function baseNameOfSidecar(name) {
  return name.replace(/\.manifest\.json$/, '.tar.gz');
}

if (mode === 'snapshots') {
  for (const r of tars) process.stdout.write(`${r.filename}\t${r.fid}\n`);
} else if (mode === 'sidecars') {
  for (const r of sidecars) process.stdout.write(`${r.filename}\t${r.fid}\n`);
} else if (mode === 'all') {
  for (const r of [...tars, ...sidecars]) process.stdout.write(`${r.filename}\t${r.fid}\n`);
} else if (mode === 'count') {
  process.stdout.write(`${tars.length}\n`);
} else if (mode === 'prune') {
  const sortedTars = [...tars].sort((a, b) => (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0));
  const kept = sortedTars.slice(0, keep);
  const pruned = sortedTars.slice(keep);
  const keptNames = new Set(kept.map((r) => r.filename));
  const oldestKeptName = kept.length > 0 ? kept[kept.length - 1].filename : '';
  for (const r of pruned) process.stdout.write(`${r.fid}\n`);
  for (const r of sidecars) {
    const base = baseNameOfSidecar(r.filename);
    if (keptNames.has(base)) continue;
    // 只归档“比保留边界更旧”的 sidecar，避免误动刚上传还没来得及上传 tar 的新清单
    if (oldestKeptName && base > oldestKeptName) continue;
    process.stdout.write(`${r.fid}\n`);
  }
} else {
  console.error(`未知模式: ${mode}`);
  process.exit(2);
}
