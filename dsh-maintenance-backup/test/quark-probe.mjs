#!/usr/bin/env node
/**
 * 「网盘备份维护」插件 —— 夸克官方 Skill CLI 行为探针
 *
 * 只用 node 内置模块；只调用命令行接口，不读取 quark-drive.cjs 源码。
 * 同一轮运行内所有命令复用同一个 --session-id / --session-input。
 *
 * 用法：
 *   node test/quark-probe.mjs                 # 跑全部探针（有网络读写），stdout 输出 JSON 汇总
 *   node test/quark-probe.mjs --skip-network  # 只打印已实测的已知结论，不发任何网络请求
 *   node test/quark-probe.mjs --full          # stdout 里保留每条命令的完整原始 NDJSON
 *   node test/quark-probe.mjs --clean         # 结束删除 /tmp/dsh-quark-probe-<ts>-<hex>/（上传残留仍在网盘）
 *   node test/quark-probe.mjs --timeout 180000
 *
 * 环境变量：
 *   QUARK_CLI        覆盖 CLI 路径（默认 ~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs）
 *   QUARK_DSH_FID    覆盖 dsh/ 目录 FID
 *   QUARK_ARCHIVE_FID 覆盖 dsh/_archive 目录 FID
 *   QUARK_PROBE_TIMEOUT_MS 覆盖单命令超时
 *
 * 副作用（有意为之）：
 *   - 从网盘下载最新 dsh-snap-*.tar.gz 到 /tmp，校验大小后立即删除本地大文件；
 *   - 向 dsh/_archive 上传 1 个 ~1KB 文本 + 1 个 ~0.3KB .manifest.json（CLI 无删除命令，
 *     只能由用户手动 move/改名；脚本会在 testResidue 里给出文件名与 FID）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 常量 / 参数
// ---------------------------------------------------------------------------

const SESSION_INPUT = 'DSH 网盘备份维护插件探针';
const DSH_FID_DEFAULT = '210e76226f274d749cfc712725c72c68';
const ARCHIVE_FID_DEFAULT = 'e3462aa31eb849dca82a96d8153dc41e';
const FAKE_FID = '00000000000000000000000000000000';
const SNAPSHOT_RE = /^dsh-snap-.*\.tar\.gz$/;
const SIDECAR_RE = /\.manifest\.json$/i;
const PATH_FIELDS = [
  'filePath',
  'file_path',
  'path',
  'local_path',
  'localPath',
  'output_path',
  'outputPath',
  'save_path',
  'download_path',
  'dest',
  'output_dir',
  'dir',
];

const OPTIONS = parseArgs(process.argv.slice(2));
const CLI_PATH =
  process.env.QUARK_CLI ||
  path.join(os.homedir(), '.dsh', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
const DSH_FID = process.env.QUARK_DSH_FID || DSH_FID_DEFAULT;
const ARCHIVE_FID = process.env.QUARK_ARCHIVE_FID || ARCHIVE_FID_DEFAULT;
const TIMEOUT_MS = numeric(process.env.QUARK_PROBE_TIMEOUT_MS) ?? OPTIONS.timeoutMs;

const STAMP = localStamp(); // 20261104-135500（本地时区）
const SESSION_ID = `dsh-probe-${STAMP}-${randomHex(6)}`;
// 任务约定把探针产物放在 /tmp/dsh-quark-probe-<ts>；macOS 上 os.tmpdir() 是 /var/folders/…，故优先 /tmp
const TMP_BASE =
  process.env.QUARK_PROBE_TMPDIR || (fs.existsSync('/tmp') && fs.statSync('/tmp').isDirectory() ? '/tmp' : os.tmpdir());
const ROOT = path.join(TMP_BASE, `dsh-quark-probe-${STAMP}-${randomHex(4)}`);
const SESSION_ARGS = ['--session-input', SESSION_INPUT, '--session-id', SESSION_ID];

// 探针间共享上下文：probe 3 复用 probe 6 的 browse 结果比较 FID 稳定性
const SHARED = { browseEntries: null, browseAt: null };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { skipNetwork: false, full: false, clean: false, timeoutMs: 180_000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-network') options.skipNetwork = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--timeout') options.timeoutMs = numeric(argv[++i]) ?? options.timeoutMs;
    else if (arg.startsWith('--timeout=')) options.timeoutMs = numeric(arg.slice(10)) ?? options.timeoutMs;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function randomHex(length) {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function localStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function log(message) {
  process.stderr.write(`[quark-probe] ${message}\n`);
}

function parseNdjson(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const parsed = [];
  const unparsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      unparsed.push(line.slice(0, 200));
    }
  }
  return { lines, parsed, unparsed };
}

function lastResult(parsed) {
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    if (parsed[i] && parsed[i].type === 'result') return parsed[i];
  }
  return null;
}

function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { entries: [], rawLines: 0 };
  }
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const entries = [];
  for (const line of rawLines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 忽略坏行 */
    }
  }
  return { entries, rawLines: rawLines.length };
}

function projectEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const keys = [
    'filename',
    'size',
    'file_type',
    'category',
    'format_type',
    'created_at',
    'updated_at',
    'fid',
    'parent_fid',
    'full_path',
    'source_display',
    'includeItems',
  ];
  const out = {};
  for (const key of keys) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

function shorten(value, max = 160) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}…(${value.length} chars)` : value;
}

function fileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function ensureAbsent(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

function saveLog(label, run) {
  if (!fs.existsSync(ROOT)) return;
  const dir = path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${label}.stdout.ndjson`), run.stdout || '');
  if ((run.stderr || '').trim()) fs.writeFileSync(path.join(dir, `${label}.stderr.log`), run.stderr);
}

/**
 * 运行一次 CLI。所有命令统一带 --session-input/--session-id，统一超时。
 * @param {string[]} args
 * @param {{timeoutMs?: number, label?: string}} [options]
 */
function runCli(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const label = options.label || args[0];
  const startedAt = Date.now();
  log(`${label} | ${args.join(' ')}`);
  const argv = [...args, ...SESSION_ARGS];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(process.execPath, [CLI_PATH, ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve(finalize({ spawnError: String(error), exitCode: null, signal: null }));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finalize({ spawnError: String(error), exitCode: null, signal: null }));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finalize({ exitCode, signal }));
    });

    function finalize(extra) {
      const durationMs = Date.now() - startedAt;
      const parsed = parseNdjson(stdout);
      const resultLine = lastResult(parsed.parsed);
      const run = {
        argv,
        ...extra,
        timedOut,
        durationMs,
        stdout,
        stderr,
        parsed,
        resultLine,
        progressLines: parsed.parsed.filter((line) => line && line.type === 'progress'),
        listLines: parsed.parsed.filter((line) => line && line.type === 'list'),
        artifactLines: parsed.parsed.filter((line) => line && line.type === 'artifact'),
      };
      log(
        `${label} <- exit=${run.exitCode}${run.timedOut ? ' TIMEOUT' : ''} ` +
          `lines=${parsed.lines.length} code=${resultLine?.code ?? 'n/a'} ${durationMs}ms`,
      );
      saveLog(label, run);
      return run;
    }
  });
}

function commandSummary(run) {
  const line = run.resultLine;
  return {
    exitCode: run.exitCode,
    signal: run.signal ?? null,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    ndjsonLines: run.parsed.lines.length,
    unparsedLines: run.parsed.unparsed.length,
    result: line
      ? {
          code: line.code ?? null,
          msg: line.msg ?? null,
          action: line.action ?? null,
          type: line.type ?? null,
          dataKeys: line.data && typeof line.data === 'object' ? Object.keys(line.data) : [],
          hasNotice: Object.hasOwn(line, 'notice'),
          notice: line.notice ?? null,
        }
      : null,
    progressCount: run.progressLines.length,
    listCount: run.listLines.length,
    artifactCount: run.artifactLines.length,
    stderr: shorten(run.stderr.trim(), 800),
    stdoutRaw: OPTIONS.full ? run.stdout : shorten(run.stdout.trim(), 2000),
  };
}

// ---------------------------------------------------------------------------
// 探针 1：get-user-info
// ---------------------------------------------------------------------------

async function probeUserInfo() {
  const run = await runCli(['get-user-info'], { label: 'get-user-info' });
  const line = run.resultLine;
  const data = (line && line.data) || {};
  const vipInfo = data.vipInfo || null;
  const userInfo = data.userInfo || null;
  const expiresIn = vipInfo ? numeric(vipInfo.expiresIn) : null;
  const expiresDate = expiresIn ? new Date(expiresIn) : null;
  const isValidDate = Boolean(expiresDate && !Number.isNaN(expiresDate.getTime()));

  return {
    probe: 1,
    name: 'get-user-info',
    command: `node ${CLI_PATH} get-user-info --session-input "${SESSION_INPUT}" --session-id "${SESSION_ID}"`,
    ...commandSummary(run),
    dataKeys: Object.keys(data),
    vipInfo,
    userInfo,
    expiresIn: {
      raw: expiresIn,
      plausibleEpochMs: expiresIn !== null && expiresIn > 1e12 && expiresIn < 1e13,
      isoUtc: isValidDate ? expiresDate.toISOString() : null,
      daysFromNow: expiresIn ? Math.round(((expiresIn - Date.now()) / 86_400_000) * 10) / 10 : null,
      verdict: isValidDate && expiresIn > 1e12 ? 'epoch 毫秒（不是秒、不是字符串）' : '无法判定',
    },
    notice: line && Object.hasOwn(line, 'notice') ? line.notice : null,
    verdict:
      line && line.code === 0
        ? '成功；vipInfo/userInfo 字段稳定，expiresIn 为 epoch ms'
        : '失败或未返回 result 行',
  };
}

// ---------------------------------------------------------------------------
// 探针 2：browse 失败模式（task-dir 不存在）
// ---------------------------------------------------------------------------

async function probeBrowseMissingTaskDir() {
  const taskDir = ensureAbsent(
    path.join(TMP_BASE, `definitely-not-exist-${STAMP}-${randomHex(4)}`),
  );
  const run = await runCli(
    ['browse', '--parent-fid', DSH_FID, '--all', '--task-dir', taskDir],
    { label: 'browse-missing-task-dir' },
  );
  const line = run.resultLine;
  const data = (line && line.data) || {};
  const taskDirExistsAfter = fs.existsSync(taskDir);
  return {
    probe: 2,
    name: 'browse 失败模式：--task-dir 指向不存在目录（不创建）',
    command:
      `node ${CLI_PATH} browse --parent-fid ${DSH_FID} --all ` +
      `--task-dir ${taskDir} --session-input "…" --session-id "…"`,
    taskDir,
    taskDirExistedBefore: false,
    taskDirExistsAfter,
    ...commandSummary(run),
    dataFieldKeys: Object.keys(data),
    hasFilePathField: typeof data.file_path === 'string',
    resultCodeIsZero: line ? line.code === 0 : null,
    resultAction: line ? line.action : null,
    stderrEmpty: run.stderr.trim() === '',
    artifactPublished: run.artifactLines.length > 0,
    verdict: taskDirExistsAfter
      ? '异常：目录被创建'
      : line && line.code !== 0
        ? `失败明确：exit=${run.exitCode}、code=${line.code}、action=${line.action}（不是 code 0，stderr 为空）`
        : '异常：未报错',
    pluginAdvice: [
      '不要依赖 stderr 判错（这里 stderr 为空），只看 stdout 最后一条 type:"result" 的 code。',
      '失败行 action 是 "node_error" 而不是 "browse"，按 action 匹配会漏判；用 code!==0 或缺少 data.file_path 判失败。',
      '--task-dir 必须由插件先 mkdir（递归），CLI 不会代建；成功时 JSONL 落在 <task-dir>/browse/ 子目录。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 探针 6：browse 成功形态（先跑，download 复用同一套读取逻辑）
// ---------------------------------------------------------------------------

async function probeBrowseSuccess() {
  const taskDir = path.join(ROOT, 'browse-tasks');
  fs.mkdirSync(taskDir, { recursive: true });
  const run = await runCli(
    ['browse', '--parent-fid', DSH_FID, '--all', '--task-dir', taskDir],
    { label: 'browse-success' },
  );
  const line = run.resultLine;
  const data = (line && line.data) || {};
  const filePath = typeof data.file_path === 'string' ? data.file_path : null;
  const exists = Boolean(filePath && fs.existsSync(filePath));
  const { entries, rawLines } = exists ? readJsonl(filePath) : { entries: [], rawLines: 0 };
  const entryKeys = [...new Set(entries.flatMap((entry) => Object.keys(entry || {})))].sort();
  const sidecars = entries.filter(
    (entry) => typeof entry.filename === 'string' && SIDECAR_RE.test(entry.filename),
  );
  // 留给 probe 3 比较「同文件两次 browse 的 FID 是否一致」
  SHARED.browseEntries = entries;
  SHARED.browseAt = Date.now();

  return {
    probe: 6,
    name: 'browse 成功形态（--task-dir 已存在）',
    command:
      `node ${CLI_PATH} browse --parent-fid ${DSH_FID} --all ` +
      `--task-dir ${taskDir} --session-input "…" --session-id "…"`,
    taskDir,
    ...commandSummary(run),
    data: {
      file_path: filePath,
      parent_fid: data.parent_fid ?? null,
      count: data.count ?? null,
      hasMore: data.hasMore ?? null,
    },
    dataKeys: Object.keys(data),
    jsonlPathExists: exists,
    jsonlRelativeToTaskDir: filePath ? path.relative(taskDir, filePath) : null,
    jsonlPathPatternMatches: filePath ? /browse\/browse-\d{8}-\d{6}-[0-9a-f]{6}\.jsonl$/.test(filePath) : false,
    jsonl: {
      lineCount: rawLines,
      entryCount: entries.length,
      entryKeys,
      sample: projectEntry(entries[0]),
      filenames: entries.map((entry) => entry.filename ?? null),
    },
    sidecar: {
      foundInDshDir: sidecars.length > 0,
      entries: sidecars.map(projectEntry),
      note: sidecars.length
        ? 'dsh/ 下存在 sidecar，字段见 entries'
        : '当前 dsh/ 下没有 *.manifest.json（6 个条目 = _archive + 5 个 tar.gz）',
    },
    artifactLinesWhenTaskDir: run.artifactLines.length,
    verdict:
      line && line.code === 0 && exists && rawLines > 0
        ? `成功：file_path 落在 <task-dir>/browse/，JSONL 每行 ${entryKeys.length} 个字段，无 code/type 包装`
        : '未取得可用 JSONL',
    pluginAdvice: [
      '只读 data.file_path，不要自己拼文件名；路径含 <task-dir>/browse/ 一层。',
      '--task-dir 模式下 stdout 只有一条 result，不再有 artifact/list 行。',
      'JSONL 每行就是文件对象本身；FID 含 "~1...|..."，下载/移动时必须原样传回。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 探针 3：download
// ---------------------------------------------------------------------------

async function probeDownload() {
  // 3a. 先 browse dsh/ 找最新 tar 快照
  const browseDir = path.join(ROOT, 'browse-for-download');
  fs.mkdirSync(browseDir, { recursive: true });
  const browseRun = await runCli(
    ['browse', '--parent-fid', DSH_FID, '--all', '--task-dir', browseDir],
    { label: 'browse-for-download' },
  );
  const browseResult = browseRun.resultLine;
  const browseData = (browseResult && browseResult.data) || {};
  const browseFile = typeof browseData.file_path === 'string' ? browseData.file_path : null;
  const { entries } = browseFile ? readJsonl(browseFile) : { entries: [] };
  const snapshots = entries
    .filter((entry) => typeof entry.filename === 'string' && SNAPSHOT_RE.test(entry.filename))
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const target = snapshots[0] || null;

  if (!target) {
    return {
      probe: 3,
      name: 'download',
      ok: false,
      error: 'browse 未找到 dsh-snap-*.tar.gz',
      browse: commandSummary(browseRun),
      filenames: entries.map((entry) => entry.filename),
    };
  }

  // 3b. 下载
  const outDir = path.join(ROOT, 'download');
  const outDirExistedBefore = fs.existsSync(outDir);
  const run = await runCli(
    ['download', '--fid', target.fid, '--output-dir', outDir, '--overwrite'],
    { label: 'download' },
  );
  const line = run.resultLine;
  const data = (line && line.data) || {};
  const stringPathFields = PATH_FIELDS.filter(
    (key) => typeof data[key] === 'string' && data[key].trim() !== '',
  );
  const chosenField = stringPathFields[0] || null;
  const localPath = chosenField ? data[chosenField] : null;
  const localFileExists = localPath ? fs.existsSync(localPath) : false;
  const localFileSize = localFileExists ? fileSize(localPath) : null;
  const sizeMatches = localFileSize !== null && Number(localFileSize) === Number(target.size);

  const progressSample = run.progressLines.map((progress) => progress.data);
  const firstProgress = progressSample[0] || null;
  const lastProgress = progressSample[progressSample.length - 1] || null;
  const progressFields = firstProgress ? Object.keys(firstProgress) : [];
  const progressHasCode = run.progressLines.some((progress) => Object.hasOwn(progress, 'code'));
  const outputDirExistsAfter = fs.existsSync(outDir);

  // 大文件用完即删（只删刚下载的那一个文件）
  let localFileDeleted = false;
  if (localFileExists) {
    fs.rmSync(localPath, { force: true });
    localFileDeleted = !fs.existsSync(localPath);
  }
  const filesInOutDirAfterDelete = outputDirExistsAfter
    ? fs.readdirSync(outDir).map((name) => ({ name, size: fileSize(path.join(outDir, name)) }))
    : [];

  // 3c. 同一文件两次 browse 的 FID 是否一致（probe 6 的 browse 先跑）
  let fidStability = null;
  if (SHARED.browseEntries && SHARED.browseEntries.length) {
    const previous = new Map(SHARED.browseEntries.map((entry) => [entry.filename, entry.fid]));
    const pairs = entries
      .filter((entry) => previous.has(entry.filename) && typeof entry.fid === 'string')
      .map((entry) => {
        const oldFid = String(previous.get(entry.filename));
        const oldFidSuffix = oldFid.includes('|') ? oldFid.slice(oldFid.indexOf('|')) : null;
        const newFidSuffix = entry.fid.includes('|') ? entry.fid.slice(entry.fid.indexOf('|')) : null;
        return {
          filename: entry.filename,
          identicalFid: oldFid === entry.fid,
          identicalSuffix: oldFidSuffix !== null && oldFidSuffix === newFidSuffix,
          oldFid,
          newFid: entry.fid,
        };
      });
    fidStability = {
      comparedAtGapMs: SHARED.browseAt ? Date.now() - SHARED.browseAt : null,
      compared: pairs.length,
      identicalFidCount: pairs.filter((pair) => pair.identicalFid).length,
      identicalSuffixCount: pairs.filter((pair) => pair.identicalSuffix).length,
      samples: pairs.slice(0, 2),
      conclusion:
        pairs.length && pairs.every((pair) => !pair.identicalFid)
          ? '同一文件两次 browse 返回的 FID 前缀（"~1…"）不同，但 "|" 后的后缀稳定；不要把 FID 当作永久不变的键缓存，下载前用最新 browse 结果。'
          : '本次比较未发现 FID 变化',
    };
  }

  // 3d. 失败分支（假 FID），给插件的错误映射用
  const failRun = await runCli(
    ['download', '--fid', FAKE_FID, '--output-dir', path.join(ROOT, 'download-bad-fid'), '--overwrite'],
    { label: 'download-bad-fid' },
  );

  return {
    probe: 3,
    name: 'download',
    sourceSnapshot: {
      filename: target.filename,
      fid: target.fid,
      size: target.size,
      updated_at: target.updated_at ?? null,
    },
    outDir,
    outDirExistedBefore,
    outDirCreatedByCli: !outDirExistedBefore && outputDirExistsAfter,
    ...commandSummary(run),
    resultLineRaw: line ? JSON.stringify(line) : null,
    resultDataKeys: Object.keys(data),
    resultData: data,
    stringPathFields,
    pathFieldUsedByPlugin: chosenField,
    localPath,
    localFileExists,
    localFileSize,
    expectedSize: target.size,
    sizeMatches,
    localFileDeletedAfterProbe: localFileDeleted,
    filesInOutDirAfterDelete,
    fidStability,
    progress: {
      count: progressSample.length,
      dataKeys: progressFields,
      hasCodeField: progressHasCode,
      first: firstProgress,
      last: lastProgress,
      percentFirst: firstProgress?.percent ?? null,
      percentLast: lastProgress?.percent ?? null,
    },
    errorCase: commandSummary(failRun),
    verdict:
      line && line.code === 0 && localFileExists && sizeMatches
        ? `成功：落盘路径取 data.filePath；退出码 0；大小与 browse 的 size 一致（${target.size} B）；progress 只有 current/total/percent`
        : '下载未通过校验',
    pluginAdvice: [
      '落盘路径字段是 data.filePath（驼峰），不是 data.path/file_path；没有 data.output_dir。',
      'progress 行没有 code 字段，不能用 code 缺失判失败；只有最后一条 type:"result" 才带 code。',
      '--output-dir 不存在时 CLI 会自己创建（本探针已验证），插件先 mkdir 也不会冲突。',
      '失败时只有一行 result：code=21001 "文件找不到"、data={}、exit=1。',
      '下载大文件前先 browse 拿 size，落盘后 stat 对比；返回 fileName 与 outDir 拼接可交叉校验。',
      'FID 前缀每次 browse 会变（后缀 "|…" 稳定），不要跨小时缓存 fid；下载前重新 browse 按 filename 匹配。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 探针 4：upload（小文件 + sidecar 样本）
// ---------------------------------------------------------------------------

async function probeUpload() {
  // 4a. 1KB 文本
  const localPath = path.join(ROOT, 'probe.txt');
  const payload =
    'DSH maintenance-backup plugin quark CLI probe payload.\n'.repeat(24) +
    `session=${SESSION_ID} generated=${new Date().toISOString()}\n`;
  fs.writeFileSync(localPath, payload, 'utf8');
  const localSize = fileSize(localPath);

  // 4a-0. 先 browse 一次 _archive，记录已有的同名文件（重复运行会触发服务端自动改名）
  const archiveBeforeTaskDir = path.join(ROOT, 'browse-archive-before');
  fs.mkdirSync(archiveBeforeTaskDir, { recursive: true });
  const archiveBeforeRun = await runCli(
    ['browse', '--parent-fid', ARCHIVE_FID, '--all', '--task-dir', archiveBeforeTaskDir],
    { label: 'browse-archive-before' },
  );
  const archiveBeforeResult = archiveBeforeRun.resultLine;
  const archiveBeforeData = (archiveBeforeResult && archiveBeforeResult.data) || {};
  const archiveBeforeFile =
    typeof archiveBeforeData.file_path === 'string' ? archiveBeforeData.file_path : null;
  const { entries: archiveBeforeEntries } = archiveBeforeFile
    ? readJsonl(archiveBeforeFile)
    : { entries: [] };
  const namesBeforeUpload = new Set(archiveBeforeEntries.map((entry) => entry.filename));
  const uploadStartedAt = Date.now();

  const run = await runCli(
    ['upload', localPath, '--parent-fid', ARCHIVE_FID],
    { label: 'upload' },
  );
  const resultLine = run.resultLine;
  const resultData = (resultLine && resultLine.data) || {};
  const listLine = run.listLines[0] || null;
  const listData = (listLine && listLine.data) || {};
  const fidFromResult = Array.isArray(resultData.fids) ? resultData.fids[0] || null : null;
  const fidFromList = typeof listData.fileId === 'string' ? listData.fileId : null;
  const progress = run.progressLines.map((line) => line.data);
  const remoteName =
    resultData.fileNames?.[0] || listData.fileName || path.basename(localPath);

  // 4b. sidecar 样本：上传一个 *.manifest.json，回答「sidecar 上传后 JSONL 里长什么样」
  const sidecarName = `dsh-probe-${STAMP}-${randomHex(4)}.manifest.json`;
  const sidecarLocalPath = path.join(ROOT, sidecarName);
  fs.writeFileSync(
    sidecarLocalPath,
    JSON.stringify(
      {
        name: 'dsh-probe',
        created_at: new Date().toISOString(),
        hostname: os.hostname(),
        file_count: 1,
        approx_size_mb: 0.001,
        probe: true,
        session: SESSION_ID,
      },
      null,
      2,
    ),
    'utf8',
  );
  const sidecarRun = await runCli(
    ['upload', sidecarLocalPath, '--parent-fid', ARCHIVE_FID],
    { label: 'upload-sidecar' },
  );
  const sidecarResult = sidecarRun.resultLine;
  const sidecarResultData = (sidecarResult && sidecarResult.data) || {};
  const sidecarList = sidecarRun.listLines[0] || null;
  const sidecarFid =
    (Array.isArray(sidecarResultData.fids) ? sidecarResultData.fids[0] : null) ||
    (sidecarList && sidecarList.data && sidecarList.data.fileId) ||
    null;

  // 4c. browse _archive 确认可见并拿到 JSON 条目的 format_type
  const archiveTaskDir = path.join(ROOT, 'browse-archive');
  fs.mkdirSync(archiveTaskDir, { recursive: true });
  const archiveBrowse = await runCli(
    ['browse', '--parent-fid', ARCHIVE_FID, '--all', '--task-dir', archiveTaskDir],
    { label: 'browse-archive' },
  );
  const archiveResult = archiveBrowse.resultLine;
  const archiveData = (archiveResult && archiveResult.data) || {};
  const archiveFile = typeof archiveData.file_path === 'string' ? archiveData.file_path : null;
  const { entries: archiveEntries } = archiveFile
    ? readJsonl(archiveFile)
    : { entries: [] };
  // 同名重复上传时服务端会自动改名为 "probe(1).txt"，result 里的 fileName 仍是请求名，
  // 所以用「上传前快照里没有 + 大小相同 + 上传开始之后创建」来定位真实条目。
  const uploadedEntry =
    archiveEntries
      .filter(
        (entry) =>
          !namesBeforeUpload.has(entry.filename) &&
          Number(entry.size) === Number(localSize) &&
          Number(entry.created_at || 0) >= uploadStartedAt - 10_000,
      )
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0] || null;
  const sidecarEntry =
    archiveEntries.find((entry) => entry.filename === sidecarName) ||
    archiveEntries.find((entry) => entry.fid === sidecarFid) ||
    null;
  const remoteActualName = uploadedEntry?.filename ?? null;
  const serverRenamed = Boolean(remoteActualName && remoteActualName !== remoteName);

  // 4d. 用 upload 返回的 32 位 hex FID 直接 download，验证 plain-hex FID 可用且能拿到真实文件名
  const plainFid = fidFromResult || fidFromList;
  const verifyDir = path.join(ROOT, 'verify-upload-fid');
  let verifyFidDownload = null;
  if (plainFid) {
    const verifyRun = await runCli(
      ['download', '--fid', plainFid, '--output-dir', verifyDir, '--overwrite'],
      { label: 'download-by-upload-fid' },
    );
    const verifyLine = verifyRun.resultLine;
    const verifyData = (verifyLine && verifyLine.data) || {};
    const verifyPath = typeof verifyData.filePath === 'string' ? verifyData.filePath : null;
    const verifyExists = Boolean(verifyPath && fs.existsSync(verifyPath));
    const verifySize = verifyExists ? fileSize(verifyPath) : null;
    if (verifyExists) fs.rmSync(verifyPath, { force: true });
    verifyFidDownload = {
      exitCode: verifyRun.exitCode,
      resultCode: verifyLine?.code ?? null,
      resultMsg: verifyLine?.msg ?? null,
      fileName: verifyData.fileName ?? null,
      filePath: verifyPath,
      localFileExists: verifyExists,
      localFileSize: verifySize,
      sizeMatchesLocal: verifySize !== null && verifySize === localSize,
      fileNameMatchesRemoteActual: verifyData.fileName === remoteActualName,
      fileDeletedAfterVerify: verifyExists && !fs.existsSync(verifyPath),
    };
  }

  return {
    probe: 4,
    name: 'upload（1KB 文本 → dsh/_archive）',
    localPath,
    localSize,
    parentFid: ARCHIVE_FID,
    ...commandSummary(run),
    progress: {
      count: progress.length,
      dataKeys: progress[0] ? Object.keys(progress[0]) : [],
      sample: progress[0] ?? null,
      last: progress[progress.length - 1] ?? null,
    },
    listLine: listLine
      ? { code: listLine.code, msg: listLine.msg, dataKeys: Object.keys(listData), data: listData }
      : null,
    resultDataKeys: Object.keys(resultData),
    resultData: {
      fileNames: resultData.fileNames ?? null,
      fileCount: resultData.fileCount ?? null,
      totalSize: resultData.totalSize ?? null,
      fids: resultData.fids ?? null,
      successCount: resultData.successCount ?? null,
      instantUpload: resultData.instantUpload ?? null,
      instantUploadCount: resultData.instantUploadCount ?? null,
      fullPath: resultData.fullPath ?? null,
      heapUsed: resultData.heapUsed ?? null,
      rss: resultData.rss ?? null,
    },
    hasTopLevelFidField: Object.hasOwn(resultData, 'fid'),
    fidFromResult,
    fidFromList,
    fidFormat: {
      uploadReturned: fidFromResult || fidFromList,
      browseEntry: uploadedEntry ? uploadedEntry.fid : null,
      sameString: Boolean(uploadedEntry && (fidFromResult || fidFromList) === uploadedEntry.fid),
      note: 'upload 返回 32 位 hex FID；browse JSONL 返回 "~1…|…" 加密 FID，两者字符串不相等，但都能用于 download。',
    },
    requestedName: remoteName,
    remoteActualName,
    serverRenamed,
    archiveCountBeforeUpload: archiveBeforeData.count ?? null,
    archiveCountAfterUpload: archiveData.count ?? null,
    jsonlEntryAfterUpload: projectEntry(uploadedEntry),
    verifyFidDownload,
    sidecar: {
      localPath: sidecarLocalPath,
      remoteName: sidecarName,
      remoteFid: sidecarFid,
      resultDataKeys: Object.keys(sidecarResultData),
      jsonlEntry: projectEntry(sidecarEntry),
      uploadCommandSummary: commandSummary(sidecarRun),
      archiveCountAfterUpload: archiveData.count ?? null,
      verdict: sidecarEntry
        ? `JSON 文件上传后在 browse JSONL 中 format_type=${JSON.stringify(sidecarEntry.format_type)}、file_type=${JSON.stringify(sidecarEntry.file_type)}、category=${JSON.stringify(sidecarEntry.category)}`
        : '未在 _archive 的 JSONL 中找到 sidecar 样本',
    },
    testResidue: [
      { remoteName: remoteActualName || remoteName, remoteFid: fidFromResult || fidFromList, reason: '上传探针文本' },
      { remoteName: sidecarName, remoteFid: sidecarFid, reason: '上传 sidecar 格式样本' },
    ],
    verdict:
      resultLine && resultLine.code === 0
        ? '成功：progress 有 current/total/percent；list 行给 fileId；result 行给 fids[] 与 fullPath（父目录，不含文件名）' +
          (serverRenamed ? `；同名冲突被服务端改名为 ${remoteActualName}` : '')
        : '上传未成功',
    pluginAdvice: [
      '上传成功后 FID 只能从 data.fids[0]（result）或 list 行 data.fileId 取；result.data 没有 fid 字段。',
      '上传返回的 32 位 hex FID 可直接用于 download（已验证）；browse 返回的是另一种 "~1…|…" 形态，两者字符串不相等。',
      'result.data.fileNames 是请求名；同名冲突时服务端会改成 "name(1).ext" 且响应不体现，必须重新 browse 父目录按大小/创建时间定位真实文件名。',
      'result.data.fullPath 是“文件所在目录”（如 夸克网盘/dsh/_archive），不是文件全路径，别当落盘路径用。',
      'progress 行没有 code；list 行成功 code=0，失败时 code 为服务端错误码。',
      'result.data 还带 heapUsed/rss 等调试字段，解析时忽略未知字段。',
      'CLI 没有删除命令：探针文件留在 _archive，只能由用户手动 move/改名清理。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 探针 5：move 错误路径
// ---------------------------------------------------------------------------

async function probeMoveError() {
  const run = await runCli(
    ['move', FAKE_FID, '--target-fid', ARCHIVE_FID],
    { label: 'move-bad-fid' },
  );
  const line = run.resultLine;
  let realMoveSkipped = true;
  return {
    probe: 5,
    name: 'move 错误路径（假 FID → dsh/_archive）',
    fids: [FAKE_FID],
    targetFid: ARCHIVE_FID,
    ...commandSummary(run),
    dataFieldKeys: line && line.data ? Object.keys(line.data) : [],
    dataIsEmpty: !line || !line.data || Object.keys(line.data).length === 0,
    realMoveSkipped,
    realMoveSkippedReason: '真移动会产生无意义的网盘侧变更；上传已证明 FID 可被服务端识别，移动成功路径参考 CLI 文档 data.fids/targetFid/move_path',
    verdict:
      line && line.code !== 0
        ? `失败明确：exit=${run.exitCode}、code=${line.code}、msg=${JSON.stringify(line.msg)}、data={}`
        : '异常：假 FID 未报错',
    pluginAdvice: [
      'move 失败同样只有一行 type:"result"，data={}；用 code!==0 判失败并展示 msg。',
      'code=14001 是参数错误/文件不存在，不是网络错误，不要按网络问题重试。',
      '插件还原流程不应依赖 move 清理；CLI 无删除命令。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 探针 7：超时 / 网络异常
// ---------------------------------------------------------------------------

function probeNetworkFault() {
  return {
    probe: 7,
    name: '超时 / 网络异常表现',
    skipped: true,
    reason:
      '本轮不改网络、不制造断网；按设计所有网络命令都套 180s 超时。已知通用形态：超时被 kill 时没有 type:"result" 行，stderr 可能为空，不能只看退出码或 code，要把“无 result 行 / 进程被信号杀死 / 超过 timeout”统一判为网络或超时失败。',
  };
}

// ---------------------------------------------------------------------------
// --skip-network：已实测的已知结论（随 CLI 版本变化，需重跑本脚本校准）
// ---------------------------------------------------------------------------

const KNOWN_CLI_VERSION = '1.0.25-876f30d';
const KNOWN_RECORDED_AT = '2026-11-04（Asia/Shanghai）';

function knownConclusions() {
  return {
    mode: 'offline-known',
    source: 'docs/QUARK-CLI-NOTES.md 同批实测；未发网络请求',
    recordedAt: KNOWN_RECORDED_AT,
    cliVersion: KNOWN_CLI_VERSION,
    cliPath: '~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs',
    sessionArgs: `--session-input "${SESSION_INPUT}" --session-id "<每次运行唯一>"`,
    ndjsonShape: '每行一个 JSON：{code?,msg,action,type,data}；type ∈ result|progress|list|artifact；progress 无 code',
    probes: {
      'get-user-info': {
        exitCode: 0,
        result: { code: 0, msg: '成功', action: 'get-user-info', type: 'result' },
        dataKeys: ['vipInfo', 'userInfo'],
        vipInfoFields: ['vipType', 'expiresIn', 'used', 'capacity'],
        userInfoFields: ['nickname'],
        expiresIn: 'epoch 毫秒（样本 1793980800000 → 2026-11-06T16:00:00.000Z，即北京时间 2026-11-07 00:00）',
        notice: '无 notice 字段',
      },
      'browse-missing-task-dir': {
        exitCode: 1,
        result: {
          code: -100,
          msg: "ENOENT: no such file or directory, stat '<task-dir>'",
          action: 'node_error',
          type: 'result',
          data: {},
        },
        stderr: '空',
        taskDirCreated: false,
        conclusion: '不是 code 0；失败行 action 是 node_error，插件必须按 code!==0 / 缺 data.file_path 判失败',
      },
      download: {
        exitCode: 0,
        resultDataKeys: ['fileName', 'filePath'],
        pathField: 'data.filePath（驼峰）',
        progress: { type: 'progress', dataKeys: ['current', 'total', 'percent'], hasCode: false },
        outputDirCreatedByCli: true,
        sizeMatchesBrowseSize: true,
        failureCase: { fakeFid: FAKE_FID, exitCode: 1, code: 21001, msg: '文件找不到', data: {} },
      },
      upload: {
        exitCode: 0,
        progress: { dataKeys: ['current', 'total', 'percent'] },
        listLineDataKeys: ['recordId', 'fileId', 'fileName', 'fileSize', 'instantUpload'],
        resultDataKeys: [
          'fileNames',
          'fileCount',
          'totalSize',
          'fids',
          'successCount',
          'instantUpload',
          'instantUploadCount',
          'fullPath',
          'heapUsed',
          'rss',
        ],
        hasTopLevelFid: false,
        fidSource: 'result.data.fids[0]（32 位 hex）或 list 行 data.fileId',
        plainHexFidUsableForDownload: true,
        fidStringMismatch: 'upload 返回 32 位 hex；browse 返回 "~1…|…"，两者字符串不相等但都可用于 download',
        duplicateNameBehavior: '同名已存在时服务端自动改名为 "probe(1).txt"，list/result 仍报请求名 probe.txt；需重新 browse 按 size+created_at 定位真实文件名',
        fullPathMeaning: '文件所在目录（父目录），不含文件名',
        jsonSidecarEntry:
          'filename=*.manifest.json、format_type="application/json"、file_type="1"、category=4（由 .manifest.json 样本实测）',
      },
      move: {
        fakeFid: FAKE_FID,
        exitCode: 1,
        code: 14001,
        msg: '参数错误: [文件不存在]',
        action: 'move',
        data: {},
      },
      'browse-success': {
        exitCode: 0,
        resultData: {
          file_path: '<task-dir>/browse/browse-YYYYMMDD-HHMMSS-<6hex>.jsonl',
          parent_fid: DSH_FID_DEFAULT,
          count: 6,
          hasMore: false,
        },
        jsonlLocation: '<task-dir>/browse/browse-YYYYMMDD-HHMMSS-<6hex>.jsonl',
        jsonlEntryKeys: [
          'fid',
          'parent_fid',
          'category',
          'filename',
          'size',
          'file_type',
          'full_path',
          'format_type',
          'source_display',
          'created_at',
          'updated_at',
          'includeItems',
        ],
        jsonlFieldNotes: {
          file_type: '字符串："0"=目录，"1"=文件',
          category: '数字：目录=0，tar.gz=7，txt/json=4',
          format_type: '字符串：目录=""，tar.gz="application/gzip"，txt="text/plain"，json="application/json"',
          full_path: '数组，可能是 [{missing:"dsh"}]，不是字符串，不要直接展示/拼接',
          source_display: '来源标记，agent 上传的文件为 "agent_upload"',
          includeItems: '只有目录条目有（子项数量），文件条目没有该字段',
        },
        fidFormat: '"~1<每次变化的前缀>|<稳定后缀>"，含竖线，必须原样传回',
        artifactLinesWhenTaskDir: 0,
      },
      fidStability: {
        sameFileAcrossTwoBrowses: 'FID 前缀每次 browse 都不同，后缀（"|…"）稳定',
        oldFidStillUsable: '实测 13:48 browse 得到的 FID 在 13:52 仍可 download；未测小时级过期',
        advice: '不要跨会话/长时间缓存 fid；下载前重新 browse 并按 filename 匹配。',
      },
      'dsh-dir-sample': {
        entries: '_archive(file_type="0",size=0,includeItems=9) + 5 × dsh-snap-*.tar.gz(file_type="1",category=7,format_type="application/gzip",source_display="agent_upload",size≈12.1MB)',
        sidecarInDshNow: '无（当前目录没有 *.manifest.json）',
      },
    },
    pitfalls: [
      '失败判定以最后一条 type:"result" 的 code 为准；stderr 常为空，退出码在本次实测中失败=1、成功=0。',
      'browse 失败行 action="node_error"，不是命令名；按 action 判错会漏。',
      'progress 行没有 code 字段，不能因缺 code 判失败。',
      'upload 的 FID 在 result.data.fids[] / list.data.fileId，没有 data.fid。',
      'upload 返回的 FID 是 32 位 hex，browse 返回 "~1…|…"，两者字符串不等但都能 download；不要用字符串相等做对应关系。',
      '同名上传会被服务端改成 "name(1).ext"，响应里不体现，必须重新 browse 定位真实文件名。',
      'download 落盘路径是 data.filePath；没有 data.path / file_path。',
      '--task-dir 必须已存在；JSONL 在 <task-dir>/browse/ 子目录。',
      'FID 前缀每次 browse 会变，别长期缓存。',
      'CLI 无删除命令，上传探针文件会留存在 dsh/_archive。',
    ],
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (OPTIONS.help) {
    process.stdout.write(
      [
        '用法：node test/quark-probe.mjs [--skip-network] [--full] [--clean] [--timeout <ms>]',
        '',
        '  --skip-network  不发网络请求，只打印已实测结论（JSON）',
        '  --full          stdout 保留每条命令完整原始 NDJSON',
        '  --clean         结束后删除临时目录（网盘上的探针文件不会删除）',
        '  --timeout <ms>  单条网络命令超时，默认 180000',
        '',
        '环境变量：QUARK_CLI / QUARK_DSH_FID / QUARK_ARCHIVE_FID / QUARK_PROBE_TIMEOUT_MS',
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (OPTIONS.skipNetwork) {
    const known = knownConclusions();
    known.sessionIdExample = SESSION_ID;
    process.stdout.write(`${JSON.stringify(known, null, 2)}\n`);
    return 0;
  }

  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(`找不到 CLI：${CLI_PATH}（用 QUARK_CLI 指定，或先安装 quarkclouddrive skill）`);
  }
  fs.mkdirSync(ROOT, { recursive: true });

  const versionRun = await runCli(['-V'], { label: 'version', timeoutMs: 30_000 });
  const cliVersion = versionRun.stdout.trim() || null;
  if (!cliVersion) log('警告：`-V` 未返回版本号');

  const summary = {
    tool: 'dsh-maintenance-backup/quark-probe',
    generatedAt: new Date().toISOString(),
    mode: 'live',
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
    },
    envPresence: {
      DSH_HOME: Boolean(process.env.DSH_HOME),
      DSH_SESSION_ID: Boolean(process.env.DSH_SESSION_ID),
      DSH_MAINTENANCE_DIR: Boolean(process.env.DSH_MAINTENANCE_DIR),
    },
    cli: {
      path: CLI_PATH,
      version: cliVersion,
      versionExitCode: versionRun.exitCode,
    },
    session: { id: SESSION_ID, input: SESSION_INPUT },
    options: { timeoutMs: TIMEOUT_MS, full: OPTIONS.full },
    targets: { dshFid: DSH_FID, archiveFid: ARCHIVE_FID },
    tempRoot: ROOT,
    probes: [],
    probeErrors: [],
    networkFaultProbe: probeNetworkFault(),
    testResidue: [],
    cleanup: null,
  };

  const probes = [
    ['probe1-user-info', probeUserInfo],
    ['probe2-browse-missing-task-dir', probeBrowseMissingTaskDir],
    ['probe6-browse-success', probeBrowseSuccess],
    ['probe3-download', probeDownload],
    ['probe4-upload', probeUpload],
    ['probe5-move-error', probeMoveError],
  ];

  for (const [label, probe] of probes) {
    try {
      log(`===== ${label} =====`);
      const result = await probe();
      summary.probes.push(result);
      if (Array.isArray(result.testResidue)) summary.testResidue.push(...result.testResidue);
    } catch (error) {
      log(`探针 ${label} 抛错：${error && error.stack ? error.stack : error}`);
      summary.probeErrors.push({ label, error: String(error && error.message ? error.message : error) });
    }
  }

  // 按探针编号排序输出，保持 1→6 的可读顺序（内部因 download 复用 browse 先跑 6）
  summary.probes.sort((a, b) => (a.probe ?? 99) - (b.probe ?? 99));

  summary.cleanup = {
    downloadedBigFileDeleted: summary.probes
      .filter((probe) => probe && probe.name === 'download')
      .map((probe) => probe.localFileDeletedAfterProbe),
    tempRootKept: !OPTIONS.clean,
  };

  fs.writeFileSync(path.join(ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (OPTIONS.clean) {
    fs.rmSync(ROOT, { recursive: true, force: true });
    summary.cleanup.tempRootKept = false;
    summary.cleanup.tempRootDeleted = true;
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.probeErrors.length ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[quark-probe] 致命错误：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
