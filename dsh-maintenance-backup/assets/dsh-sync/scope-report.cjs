#!/usr/bin/env node
// @dsh-maintenance-tools-version 2
// 网盘备份维护插件：把 scope.sh 收集到的条目清单变成 JSON 报告。
// 输入：每行 "src\tdest\tdiscovered\tdisabled"
// 输出：一行 JSON（见 docs/CONTRACT.md Scope）

const fs = require('fs');
const os = require('os');
const path = require('path');

const entriesFile = process.argv[2];
const home = os.homedir();

const keep = Number(process.env.DSH_SYNC_KEEP || 5);
const dshFid = process.env.DSH_SYNC_DSH_FID || '';
const archiveFid = process.env.DSH_SYNC_ARCHIVE_FID || '';
const pruneAbs = String(process.env.DSH_SYNC_PRUNE_ABS || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);
const excludeNamePatterns = String(process.env.DSH_SYNC_EXCLUDES || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

function matchesExclude(name) {
  for (const pattern of excludeNamePatterns) {
    if (pattern === name) return true;
    if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

function isPruned(abs) {
  for (const prefix of pruneAbs) {
    if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function inspectEntry(src) {
  let dirStat = null;
  try {
    dirStat = fs.statSync(src);
  } catch {
    return { exists: false, readable: false, files: 0, bytes: 0, warning: '路径不存在' };
  }
  if (!dirStat.isDirectory()) {
    return { exists: true, readable: false, files: 0, bytes: 0, warning: '不是目录' };
  }
  let readable = true;
  try {
    fs.readdirSync(src).slice(0, 1);
  } catch {
    readable = false;
  }
  if (!readable) {
    return { exists: true, readable: false, files: 0, bytes: 0, warning: '无读取权限（插件运行在 DSH 进程内，正常应可读）' };
  }
  let files = 0;
  let bytes = 0;
  let depthWarnings = 0;
  const stack = [{ dir: src, depth: 0 }];
  while (stack.length > 0 && files < 200000) {
    const { dir, depth } = stack.pop();
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      depthWarnings += 1;
      continue;
    }
    for (const entry of list) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (matchesExclude(entry.name) || isPruned(abs)) continue;
        if (depth >= 40) continue;
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesExclude(entry.name) || isPruned(abs)) continue;
      let info;
      try {
        info = fs.statSync(abs);
      } catch {
        continue;
      }
      files += 1;
      bytes += info.size;
    }
  }
  return {
    exists: true,
    readable,
    files,
    bytes,
    warning: depthWarnings > 0 ? `${depthWarnings} 个子目录读取失败` : null,
  };
}

function labelFor(src) {
  const base = path.basename(src);
  return base || src;
}

function humanExcludes() {
  const excluded = [];
  for (const p of pruneAbs) {
    excluded.push({ path: p, reason: '运行时状态目录（整体排除，避免上传触发自身变化）' });
  }
  for (const pattern of excludeNamePatterns) {
    excluded.push({ path: pattern, reason: '通用忽略规则' });
  }
  excluded.push({ path: path.join(home, '.dsh', '.credentials.yaml'), reason: 'API 密钥，永不备份' });
  for (const runtime of ['sessions', 'attachments', 'storages', 'cache', 'page-preview', 'dsh-runtimes']) {
    excluded.push({ path: path.join(home, '.dsh', runtime), reason: 'DSH 运行态，不在备份范围' });
  }
  return excluded;
}

function main() {
  let text = '';
  try {
    text = fs.readFileSync(entriesFile, 'utf8');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: `读取条目清单失败: ${error.message}` }));
    return;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [src, dest, discovered, disabled] = parts;
    const stat = inspectEntry(src);
    entries.push({
      src,
      dest,
      label: labelFor(src),
      exists: stat.exists,
      readable: stat.readable,
      files: stat.files,
      bytes: stat.bytes,
      discovered: discovered === '1',
      disabled: disabled === '1',
      warning: stat.warning,
    });
  }
  const totals = {
    files: 0,
    bytes: 0,
    enabledEntries: 0,
  };
  for (const entry of entries) {
    if (!entry.disabled) {
      totals.files += entry.files;
      totals.bytes += entry.bytes;
      if (entry.exists && entry.readable) totals.enabledEntries += 1;
    }
  }
  const notes = [
    '扩展名 .log/.tmp、node_modules、.git、.DS_Store、.turbo 不会进入快照。',
    '云端只保留最新 KEEP 份 tar.gz，超出的连同 sidecar 清单一并移入 dsh/_archive；夸克 CLI 没有删除能力，_archive 需在夸克 App 内手动清空。',
    '还原后若插件工程被覆盖，需要在对应目录执行 pnpm install 重装 node_modules。',
    '配置中的 link:/Users/<用户名>/... 是绝对路径，换机还原后需要核对。',
  ];
  const report = {
    ok: true,
    generatedAt: Date.now(),
    keep,
    dshFid,
    archiveFid,
    entries,
    excluded: humanExcludes(),
    notes,
    totals,
  };
  process.stdout.write(JSON.stringify(report));
}

main();
