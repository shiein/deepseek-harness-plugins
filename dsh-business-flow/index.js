/**
 * Business Flow Analyst — Host half.
 *
 * Serves a small JSON API over the Harness web server (`/api/dsh-business-flow/*`) so the
 * package's Client half can ask the configured agent to map a project's data
 * business flow and to turn node requirements into precise session prompts.
 * All routes are loopback-only.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { isLoopbackRequest } from './host/loopback.js';

/** Hard dependency: the browser HTTP carrier that serves the Web GUI this page renders in. */
export const inject = ['webServer'];

const PREFIX = '/api/dsh-business-flow';
const MAX_BODY_BYTES = 512 * 1024;
/** Older clients post their whole saved history at once. */
const MAX_HISTORY_BODY_BYTES = 8 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 8 * 60 * 1000;
/** Live analysis agents kept for follow-up drafts; each holds memory until disposed. */
const MAX_LIVE_SESSIONS = 8;

const NODE_KINDS = new Set(['entry', 'process', 'data', 'permission', 'external']);
const EDGE_KINDS = new Set(['flow', 'data', 'auth']);
/** Table access as the model reports it, folded onto the three values the panel shows. */
const TABLE_ACCESS = new Map([
  ['read', 'read'], ['r', 'read'], ['select', 'read'], ['query', 'read'],
  ['write', 'write'], ['w', 'write'], ['insert', 'write'], ['update', 'write'], ['delete', 'write'],
  ['readwrite', 'readwrite'], ['read-write', 'readwrite'], ['read_write', 'readwrite'], ['rw', 'readwrite'],
  ['both', 'readwrite'], ['crud', 'readwrite'],
]);
const MAX_TABLES_PER_NODE = 20;
/** Files read per analysis to check that a reported table name really occurs in the project. */
const TABLE_EVIDENCE_FILE_LIMIT = 60;
const TABLE_EVIDENCE_FILE_BYTES = 400_000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.gradle', 'Pods', 'DerivedData', '.turbo', '.cache',
]);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.kts', '.go', '.py',
  '.rb', '.php', '.cs', '.rs', '.sql', '.md', '.yml', '.yaml', '.toml', '.xml',
  '.properties', '.gradle', '.vue', '.svelte', '.html', '.css', '.scss',
]);
const CANDIDATE_RE = /(controller|service|route|router|handler|api|mapper|dao|repository|schema|model|entity|migration|permission|auth|login|middleware|interceptor|config|index|main|app|readme|package\.json|pom\.xml|build\.gradle)/i;
const HISTORY_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'business-flow', 'history.json');
/** Where the plugin kept its history while it was named `bizflow`; moved to HISTORY_FILE on first use. */
const LEGACY_HISTORY_FILE = join(homedir(), '.dsh', 'bizflow', 'history.json');

/**
 * One-time move of the pre-rename history file. Only when the new file does not exist yet, so a
 * later legacy copy can never overwrite newer records; a failed move is reported, not ignored.
 */
async function migrateLegacyHistory() {
  if (await pathExists(HISTORY_FILE) || !await pathExists(LEGACY_HISTORY_FILE)) return;
  try {
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    await rename(LEGACY_HISTORY_FILE, HISTORY_FILE);
  } catch (error) {
    throw bizError(
      `cannot move the old history ${LEGACY_HISTORY_FILE} to ${HISTORY_FILE}: ${error?.message ?? String(error)}`,
      500,
    );
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saved analyses, kept in the DSH home so a new GUI port keeps them. One read returns both the
 * records this code understands and the ones it does not (kept on disk so a later write does not
 * destroy them).
 */
async function readHistoryState() {
  await migrateLegacyHistory();
  let text;
  try {
    text = await readFile(HISTORY_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], unreadable: [] };
    throw bizError(`cannot read the history file: ${error?.message ?? String(error)}`, 500);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refuse to continue: a write now would replace the unreadable file and lose every record.
    throw bizError(`history file is not valid JSON, fix or move it first: ${HISTORY_FILE}`, 500);
  }
  if (!Array.isArray(parsed)) throw bizError(`history file is not a list: ${HISTORY_FILE}`, 500);
  return { entries: parsed.filter(isHistoryEntry), unreadable: parsed.filter((entry) => !isHistoryEntry(entry)) };
}

/** History is unbounded by design (the user decides what to delete); newest first on disk. */
async function writeHistoryFile(entries, unreadable) {
  const sorted = [...entries].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  try {
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    const temporary = `${HISTORY_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...sorted, ...unreadable]), 'utf8');
    await rename(temporary, HISTORY_FILE);
    return sorted;
  } catch (error) {
    throw bizError(`cannot write the history file: ${error?.message ?? String(error)}`, 500);
  }
}

/** History reads and read-modify-writes run one at a time, so two saves cannot drop each other's records. */
let historyQueue = Promise.resolve();
function withHistory(task) {
  const run = historyQueue.then(task, task);
  historyQueue = run.then(() => {}, () => {});
  return run;
}

function isHistoryEntry(entry) {
  return Boolean(entry && typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.projectPath === 'string'
    && entry.graph && Array.isArray(entry.graph.nodes));
}

const MAX_DIGEST_CHARS = 20000;
const MAX_NODE_DIGEST_CHARS = 26000;
const MAX_EXCERPT_CHARS = 3000;
const MAX_PROJECT_FILES = 6000;
/** How much of the project is searched for the business keywords. */
const MAX_SCANNED_FILES = 800;
const MAX_SCANNED_BYTES = 30 * 1024 * 1024;
const MAX_KEYWORDS = 16;
const KEYWORD_HITS_CAP = 5;
const KEYWORD_PATH_SCORE = 10;
const HEAD_LINES = 12;
const LINES_BEFORE_HIT = 8;
const LINES_AFTER_HIT = 12;
const KEYWORD_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'flow', 'process', 'business', 'data', 'feature', 'module', 'system',
  '业务', '流程', '功能', '模块', '系统', '数据', '相关', '逻辑', '处理',
]);
/** Common business terms and how code usually spells them. */
const BUSINESS_TERMS = [
  ['订单', ['order']], ['下单', ['order', 'checkout']], ['支付', ['pay', 'payment']], ['付款', ['pay', 'payment']],
  ['退款', ['refund']], ['售后', ['aftersale', 'refund']], ['发货', ['ship', 'delivery']], ['物流', ['logistics', 'shipping']],
  ['购物车', ['cart']], ['商品', ['product', 'goods', 'sku']], ['库存', ['stock', 'inventory']], ['优惠', ['coupon', 'discount']],
  ['促销', ['promotion']], ['会员', ['member', 'vip']], ['用户', ['user']], ['账号', ['account']], ['账户', ['account']],
  ['登录', ['login', 'signin', 'auth']], ['注册', ['register', 'signup']], ['权限', ['permission', 'role']], ['角色', ['role']],
  ['菜单', ['menu']], ['租户', ['tenant']], ['审批', ['approval', 'audit']], ['审核', ['audit', 'review']], ['通知', ['notify', 'notification']],
  ['消息', ['message']], ['上传', ['upload']], ['下载', ['download']], ['导出', ['export']], ['导入', ['import']],
  ['报表', ['report']], ['统计', ['statistics', 'stat']], ['日志', ['log']], ['配置', ['config', 'setting']], ['定时', ['schedule', 'cron']],
  ['发票', ['invoice']], ['合同', ['contract']], ['客户', ['customer', 'client']], ['员工', ['employee', 'staff']], ['部门', ['department', 'dept']],
];

/** Read a text file with a size fence, or `undefined` when it is not usable. */
async function safeRead(fullPath, maxBytes) {
  try {
    const info = await stat(fullPath);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(fullPath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Files that exist to hold secrets or production settings: never excerpted into a prompt. */
const SECRET_FILE_RE = /(^|\/)(\.env[^/]*|secrets?(\.[^/]*)?|credentials?(\.[^/]*)?)$|[-_.](prod|production)\.(ya?ml|properties|toml|xml)$/i;
const CONFIG_EXT = new Set(['.yml', '.yaml', '.properties', '.toml', '.xml']);
const SECRET_KEY = '(?:passw(?:or)?d|passphrase|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credential)';
/** Any value of a secret-looking key: config files carry literal values on these lines. */
const CONFIG_SECRET_RE = new RegExp(`^(\\s*-?\\s*["']?[\\w.-]{0,60}${SECRET_KEY}[\\w.-]{0,40}["']?\\s*[:=]\\s*)\\S.*$`, 'gim');
const XML_SECRET_RE = new RegExp(`(<[\\w.-]{0,60}${SECRET_KEY}[\\w.-]{0,40}>)[^<]*`, 'gi');
/** Source code: only quoted literals, so `token = getToken()` stays readable. */
const QUOTED_SECRET_RE = new RegExp(`(${SECRET_KEY}[\\w.-]{0,40}["']?\\s*[:=]\\s*)(["'\`])[^"'\`\\n]{4,}\\2`, 'gi');
const URL_PASSWORD_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)[^\s@/'"]+@/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const TOKEN_SHAPE_RE = /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,})\b/g;
const EXCERPT_LINE_CHARS = 400;

/** Blank out what looks like a credential before file text reaches the model. */
function redactSecrets(text, ext) {
  let out = text
    .replace(PRIVATE_KEY_RE, '***')
    .replace(URL_PASSWORD_RE, '$1***@')
    .replace(TOKEN_SHAPE_RE, '***')
    .replace(QUOTED_SECRET_RE, '$1"***"');
  if (CONFIG_EXT.has(ext)) out = out.replace(CONFIG_SECRET_RE, '$1***').replace(XML_SECRET_RE, '$1***');
  return out;
}

/** Lines to send for a file with keyword hits: its head plus the code around each hit, in file order. */
function linesAroundHits(lines, keywords, maxLines) {
  const keep = new Set(Array.from({ length: Math.min(HEAD_LINES, lines.length) }, (_, index) => index));
  for (let index = 0; index < lines.length && keep.size < maxLines; index += 1) {
    const line = lines[index].toLowerCase();
    if (!keywords.some((keyword) => line.includes(keyword))) continue;
    const end = Math.min(lines.length, index + LINES_AFTER_HIT + 1);
    for (let at = Math.max(0, index - LINES_BEFORE_HIT); at < end && keep.size < maxLines; at += 1) keep.add(at);
  }
  const chosen = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== previous + 1) chosen.push('…');
    chosen.push(lines[index]);
    previous = index;
  }
  return chosen;
}

/**
 * A file as prompt text, or '' for a file that must not be excerpted. With `keywords`, a file that
 * contains one is excerpted around those lines; otherwise it is its first `maxLines` lines.
 */
function excerptOf(rel, text, maxLines, keywords = []) {
  if (SECRET_FILE_RE.test(rel.split(sep).join('/'))) return '';
  // Clip first: the redaction patterns must only ever see short lines.
  const clipped = text.split('\n')
    .map((line) => (line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS)}…` : line))
    .join('\n');
  const lines = redactSecrets(clipped, extname(rel).toLowerCase()).split('\n');
  const hit = keywords.length > 0 && lines.some((line) => {
    const lower = line.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });
  return (hit ? linesAroundHits(lines, keywords, maxLines) : lines.slice(0, maxLines)).join('\n').trim();
}

/** Every regular file under `root`, skipping build/dependency directories; breadth first, so a large directory cannot use up the limit. */
async function listProjectFiles(root) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  for (let next = 0; next < queue.length && files.length < MAX_PROJECT_FILES; next += 1) {
    const { dir, depth } = queue[next];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_PROJECT_FILES) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 7 && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Search terms from the business description; code is usually English even when the request is not. */
function businessKeywords(business) {
  const spaced = business.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const found = new Set();
  for (const word of spaced.match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!KEYWORD_STOP_WORDS.has(word)) found.add(word);
  }
  for (const run of spaced.match(/[一-鿿]{2,}/g) ?? []) {
    if (!KEYWORD_STOP_WORDS.has(run)) found.add(run);
    for (const [term, english] of BUSINESS_TERMS) {
      if (run.includes(term)) for (const word of english) found.add(word);
    }
  }
  return [...found].slice(0, MAX_KEYWORDS);
}

/** How strongly a file matches, capped per keyword so one repetitive file cannot dominate. */
function keywordScore(rel, text, keywords) {
  const path = rel.toLowerCase();
  const lower = text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (path.includes(keyword)) score += KEYWORD_PATH_SCORE;
    let hits = 0;
    for (let at = lower.indexOf(keyword); at !== -1 && hits < KEYWORD_HITS_CAP; at = lower.indexOf(keyword, at + keyword.length)) {
      hits += 1;
    }
    score += hits;
  }
  return score;
}

/**
 * Pre-read the project so the model starts with evidence instead of spending many tool round-trips
 * exploring: a file index plus excerpts. Files that mention the business come first and are excerpted
 * around those lines; general entry/service/data/permission files fill what remains.
 */
async function buildProjectDigest(root, business) {
  const absoluteRoot = resolve(root);
  const absolute = await listProjectFiles(absoluteRoot);
  // Forward slashes on every platform: the model and the node `files` lists speak POSIX paths.
  const rels = absolute.map((file) => relative(absoluteRoot, file).split(sep).join('/'));
  const ranked = rels
    .map((rel) => {
      const ext = extname(rel).toLowerCase();
      let score = TEXT_EXT.has(ext) ? 3 : -100;
      if (CANDIDATE_RE.test(rel)) score += 6;
      score -= rel.split('/').length * 2;
      if (/(^|\/)(readme|package\.json|pom\.xml|build\.gradle|requirements\.txt)$/i.test(rel)) score += 4;
      return { rel, ext, score, match: 0 };
    })
    .filter((item) => item.score > -50)
    .sort((a, b) => b.score - a.score);
  const keywords = businessKeywords(business);
  const texts = new Map();
  let scannedBytes = 0;
  for (const item of ranked.slice(0, MAX_SCANNED_FILES)) {
    if (scannedBytes >= MAX_SCANNED_BYTES) break;
    if (SECRET_FILE_RE.test(item.rel)) continue;
    const text = await safeRead(join(absoluteRoot, item.rel), 200_000);
    if (text === undefined) continue;
    scannedBytes += text.length;
    texts.set(item.rel, text);
    item.match = keywordScore(item.rel, text, keywords);
  }
  const ordered = [...ranked].sort((a, b) => b.match - a.match || b.score - a.score);
  const matched = ordered.filter((item) => item.match > 0).length;
  const parts = [];
  let total = 0;
  for (const item of ordered) {
    if (parts.length >= 24 || total >= MAX_DIGEST_CHARS) break;
    const text = texts.get(item.rel) ?? await safeRead(join(absoluteRoot, item.rel), 200_000);
    if (text === undefined) continue;
    const excerpt = clip(excerptOf(item.rel, text, 80, keywords), MAX_EXCERPT_CHARS);
    if (excerpt === '') continue;
    const block = `--- ${item.rel} ---\n${excerpt}`;
    if (total + block.length > MAX_DIGEST_CHARS) continue;
    parts.push(block);
    total += block.length;
  }
  const tree = [...new Set([...ordered.map((item) => item.rel), ...rels])].slice(0, 400);
  return { tree: tree.join('\n'), excerpts: parts.join('\n\n'), keywords, matched };
}

/** Excerpts of the files the graph associates with one node (fenced to the root). */
async function buildNodeDigest(root, files) {
  const absoluteRoot = resolve(root);
  const parts = [];
  let total = 0;
  const list = Array.isArray(files) ? files.slice(0, 10) : [];
  for (const rel of list) {
    if (typeof rel !== 'string' || rel === '') continue;
    const full = resolve(absoluteRoot, rel);
    if (full !== absoluteRoot && !full.startsWith(`${absoluteRoot}${sep}`)) continue;
    const text = await safeRead(full, 200_000);
    if (text === undefined) continue;
    const excerpt = excerptOf(relative(absoluteRoot, full), text, 160);
    if (excerpt === '') continue;
    const block = `--- ${rel} ---\n${excerpt}`;
    if (total + block.length > MAX_NODE_DIGEST_CHARS) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n\n');
}

/** Resolve a client-supplied project path to an existing directory, or throw a 400. */
function resolveProjectPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') throw bizError('requires projectPath');
  const absolute = resolve(raw);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw bizError(`project directory does not exist: ${absolute}`);
  }
  if (!stat.isDirectory()) throw bizError(`project path is not a directory: ${absolute}`);
  return absolute;
}

function bizError(message, status = 400) {
  const error = new Error(`business-flow: ${message}`);
  error.status = status;
  return error;
}

function requireService(ctx, name) {
  const service = ctx.get(name);
  if (service === undefined) throw bizError(`service "${name}" is unavailable in this profile`, 503);
  return service;
}

/** Join the text blocks of one assistant message. */
function messageText(message) {
  if (typeof message !== 'object' || message === null) return '';
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The message carried by a Session event: `assistant/message` nests it under
 * `data.message`, while `user/message` stores the message itself as `data`.
 */
function eventMessage(event) {
  if (typeof event !== 'object' || event === null) return undefined;
  const data = event.data;
  if (typeof data === 'object' && data !== null) {
    if (data.message !== undefined) return data.message;
    if (typeof data.role === 'string') return data;
  }
  return event.message;
}

/** The profile's configured model as agent options, when it is readable. */
function configuredAgentOptions(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection
      && typeof selection.provider === 'string' && selection.provider !== ''
      && typeof selection.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model };
    }
  } catch {
    /* unconfigured or unavailable */
  }
  return undefined;
}

/**
 * Put a new analysis Session under the DSH file sandbox's `read-only` mode (the same `sandbox/mode`
 * event `setSandboxMode` appends), so "do not modify files" no longer rests on the prompt alone.
 * Throws rather than run the analysis without it.
 */
function makeSessionReadOnly(handle) {
  const session = handle?.agent?.session;
  if (typeof session?.append !== 'function') {
    throw bizError('cannot make the analysis session read-only; it was not started', 503);
  }
  session.append('sandbox/mode', { mode: 'read-only' });
}

/**
 * Start a new analysis Session for `cwd`. Every analysis gets its own, so earlier analyses of the
 * project neither add to its context nor colour its answer; the prompt refinements of that analysis
 * continue in it.
 *
 * `agents.create` publishes a running agent bound to the project directory
 * without touching UI navigation (unlike `uiWorkspace.connectWorkspace`, which
 * selects the Session and would pull the user out of this panel).
 */
async function createAnalysisSession(ctx, liveSessions, cwd) {
  const agents = requireService(ctx, 'agents');
  const sessionId = randomUUID();
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions: configuredAgentOptions(ctx),
  });
  try {
    makeSessionReadOnly(handle);
  } catch (error) {
    await handle?.dispose?.();
    throw error;
  }
  const entry = { sessionId: handle?.agent?.id ?? sessionId, handle, cwd, inFlight: 0, failed: false };
  liveSessions.set(entry.sessionId, entry);
  for (const candidate of liveSessions.values()) {
    if (liveSessions.size <= MAX_LIVE_SESSIONS) break;
    if (candidate.inFlight === 0 && candidate !== entry) disposeAnalysisSession(liveSessions, candidate);
  }
  return entry;
}

function disposeAnalysisSession(liveSessions, entry) {
  liveSessions.delete(entry.sessionId);
  Promise.resolve()
    .then(() => entry.handle?.dispose?.())
    .catch(() => { /* already gone */ });
}

/** sessionId → tail of the turns queued on that Session by this plugin. */
const sessionTurnTails = new Map();

/**
 * Run `task` after every earlier turn this plugin queued on `sessionId` has settled.
 *
 * Turn results are read off the Session's shared event stream; two overlapping requests on one
 * Session would both follow the first turn and return its answer, so turns are strictly serial.
 */
function withSessionTurn(sessionId, task) {
  const previous = sessionTurnTails.get(sessionId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => {}, () => {});
  sessionTurnTails.set(sessionId, tail);
  tail.then(() => {
    if (sessionTurnTails.get(sessionId) === tail) sessionTurnTails.delete(sessionId);
  });
  return run;
}

/**
 * Who submitted a `user/message`: `prompt.requestId` is persisted on the accepted message as
 * `source.rpcId` ('user-rpc' source). Without it, fall back to the prompt text marker.
 * @returns {'mine' | 'other' | 'unknown'}
 */
function promptOwner(event, requestId, promptMarker) {
  const message = eventMessage(event);
  const rpcId = message?.source?.rpcId;
  if (typeof rpcId === 'string' && rpcId !== '') return rpcId === requestId ? 'mine' : 'other';
  return messageText(message).replace(/\s+/g, ' ').includes(promptMarker) ? 'mine' : 'unknown';
}

/** True when a `user/message` carries a prompt correlation id, i.e. ownership is decidable. */
function hasRpcId(event) {
  const rpcId = eventMessage(event)?.source?.rpcId;
  return typeof rpcId === 'string' && rpcId !== '';
}

/** Reason of a `turn/end` event: `detail` for diagnostics, `failed` when the turn did not finish its work. */
function describeTurnEnd(event) {
  const reason = event.data?.reason ?? event.reason;
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
  if (kind !== 'error' && kind !== 'aborted') return { detail: kind, failed: false };
  const failure = reason?.error ?? reason?.reason;
  return { detail: `${kind}: ${failure?.message ?? failure?.kind ?? 'unknown'}`, failed: true };
}

/**
 * Run one turn of the configured agent in `cwd` and return the last assistant text.
 *
 * The configured provider (e.g. an ACP adapter) only answers inside a real
 * Session step, so the analysis runs as a genuine Session turn: the agent is
 * created (or reused) for the project, `prompt` submits the request, and
 * `follow` streams events until `turn/end`.
 */
async function runAgentTurn(ctx, liveSessions, entry, promptText, signal) {
  const controller = requireService(ctx, 'sessionController');
  entry.inFlight += 1;
  // Most recently used last: eviction walks the map from the oldest.
  liveSessions.delete(entry.sessionId);
  liveSessions.set(entry.sessionId, entry);
  try {
    return await withSessionTurn(entry.sessionId, () => runSessionTurn(controller, entry.sessionId, promptText, signal));
  } catch (error) {
    entry.failed = true;
    throw error;
  } finally {
    entry.inFlight -= 1;
    // A failed turn may still be running, so stop it, but not under a turn queued behind it.
    if (entry.failed && entry.inFlight === 0) disposeAnalysisSession(liveSessions, entry);
  }
}

/** One serialized prompt → `turn/end` round on `sessionId` (see `withSessionTurn`). */
async function runSessionTurn(controller, sessionId, promptText, signal) {
  if (signal?.aborted) throw bizError('analysis timed out or was cancelled', 504);
  // The timeout starts once this turn owns the Session, not while it waits behind another.
  const timeout = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const requestId = randomUUID();

  let answer = '';
  let turnEnded = false;
  let turnDetail = '';
  let turnFailed = false;
  let sawMessage = false;
  const seenTypes = new Map();
  const followError = { value: undefined };

  // A reused analysis agent replays its earlier turns in the first snapshot, so
  // only events after that snapshot's watermark belong to this call's prompt.
  const promptMarker = promptText.replace(/\s+/g, ' ').trim().slice(0, 60);
  const snapshotRecords = [];
  let baselineSeq = -1;
  let armed = false;
  // This call's own user/message has been seen; once true, only events of that turn are taken.
  let ownSeen = false;
  // Some user/message carried a correlation id, so a turn/end before our own message is foreign.
  let rpcVisible = false;
  const resetTurn = () => {
    answer = '';
    sawMessage = false;
    turnDetail = '';
  };

  const follow = controller.follow(
    { address: { kind: 'session', sessionId } },
    combined,
  );
  const collect = (async () => {
    try {
      const take = (event) => {
        if (event === undefined || event === null) return;
        if (typeof event.type === 'string') seenTypes.set(event.type, (seenTypes.get(event.type) ?? 0) + 1);
        if (event.type === 'user/message' && !ownSeen) {
          if (hasRpcId(event)) rpcVisible = true;
          const owner = promptOwner(event, requestId, promptMarker);
          if (owner === 'mine') {
            // Our turn starts here: drop anything taken from a turn that was still running before it.
            ownSeen = true;
            armed = true;
            resetTurn();
            return;
          }
          if (owner === 'other') {
            // Another prompt's turn (e.g. a cancelled earlier request still finishing): skip it.
            armed = false;
            resetTurn();
            return;
          }
        }
        if (!armed) {
          const seq = typeof event.seq === 'number' ? event.seq : undefined;
          if (seq === undefined || baselineSeq < 0 || seq <= baselineSeq) return;
          armed = true;
        }
        if (event.type === 'assistant/message') {
          const text = messageText(eventMessage(event));
          if (text.trim() !== '') {
            sawMessage = true;
            answer = text;
          }
        } else if (event.type === 'turn/end') {
          if (rpcVisible && !ownSeen) {
            // A turn that started before ours ended; keep following for our own turn.
            armed = false;
            resetTurn();
            return;
          }
          turnEnded = true;
          ({ detail: turnDetail, failed: turnFailed } = describeTurnEnd(event));
        }
      };
      for await (const frame of follow) {
        if (frame === undefined || frame === null) continue;
        if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
          for (const record of frame.records) {
            snapshotRecords.push(record);
            if (record?.event?.type === 'user/message' && hasRpcId(record.event)) rpcVisible = true;
            const seq = record?.event?.seq;
            if (typeof seq === 'number' && seq > baselineSeq) baselineSeq = seq;
          }
          continue;
        }
        if (frame.type === 'event') take(frame.event);
        if (turnEnded) return;
      }
      // The whole turn can land inside the first snapshot when it finishes before
      // any live frame arrives; use its last assistant message then.
      // Only records after this call's own user/message count — a reused Session's snapshot also
      // holds earlier turns whose answers must never be returned for this prompt.
      if (!sawMessage) {
        let mine = false;
        for (const record of snapshotRecords) {
          const event = record?.event;
          if (event?.type === 'user/message') {
            const owner = promptOwner(event, requestId, promptMarker);
            if (owner !== 'unknown') mine = owner === 'mine';
            if (owner === 'mine') {
              sawMessage = false;
              answer = '';
            }
            continue;
          }
          if (mine && event?.type === 'turn/end') {
            ({ detail: turnDetail, failed: turnFailed } = describeTurnEnd(event));
            continue;
          }
          if (!mine || event?.type !== 'assistant/message') continue;
          const text = messageText(eventMessage(record.event));
          if (text.trim() !== '') {
            sawMessage = true;
            answer = text;
          }
        }
      }
    } catch (error) {
      followError.value = error;
    }
  })();

  try {
    await controller.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }, combined);
    await collect;
  } finally {
    // The session is left in the workspace for transparency; detach the follower.
    try {
      await follow.return?.();
    } catch {
      /* follower already ended */
    }
  }

  if (followError.value !== undefined && !turnEnded) {
    if (combined.aborted) throw bizError('analysis timed out or was cancelled', 504);
    throw bizError(`session follow failed: ${followError.value?.message ?? String(followError.value)}`, 502);
  }
  if (!sawMessage) {
    const seen = [...seenTypes.entries()].map(([type, count]) => `${type}×${count}`).join(', ') || 'none';
    throw bizError(
      `agent produced no assistant message (turn: ${turnDetail === '' ? 'no turn/end' : turnDetail}; events: ${seen}) — retry the analysis`,
      502,
    );
  }
  // The last message of a failed turn is mid-work text ("let me check…"), not the answer.
  if (turnFailed) throw bizError(`agent turn did not finish (${turnDetail}) — retry`, 502);
  return { answer, sessionId };
}

/** Every balanced top-level {...} JSON object found in model output. */
function extractJsonObjects(text) {
  const found = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('{', from);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    let parsed;
    let isJson = false;
    if (end !== -1) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
        isJson = true;
      } catch {
        /* prose in braces; the real object may sit inside it */
      }
    }
    if (isJson) {
      found.push(parsed);
      from = end + 1;
    } else {
      // A stray `{` in the model's prose must not hide the JSON after it.
      from = start + 1;
    }
  }
  return found;
}

/** The first object that looks like a graph with nodes, else the first object. */
function pickGraphObject(text) {
  const objects = extractJsonObjects(text);
  if (objects.length === 0) return undefined;
  return objects.find((value) => Array.isArray(value?.nodes) && value.nodes.length > 0) ?? objects[0];
}

/** Whether a parsed value carries at least one node object. */
function usableGraph(value) {
  if (typeof value !== 'object' || value === null) return false;
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  return nodes.some((node) => typeof node === 'object' && node !== null);
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)`;
}

/**
 * Tables one node reads or writes, as the model listed them: `{ name, access, note }`.
 * Names are kept as written in the code (schema-qualified names included); quoting
 * characters are stripped, duplicates merged (read + write → readwrite).
 */
function normalizeTables(value) {
  if (!Array.isArray(value)) return [];
  const byName = new Map();
  for (const raw of value) {
    const item = typeof raw === 'string' ? { name: raw } : raw;
    if (typeof item !== 'object' || item === null || typeof item.name !== 'string') continue;
    const name = item.name.replace(/[`"'[\]]/g, '').trim().slice(0, 80);
    if (name === '' || /\s/.test(name)) continue;
    const accessKey = typeof item.access === 'string' ? item.access.trim().toLowerCase() : '';
    const access = TABLE_ACCESS.get(accessKey) ?? '';
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, 120) : '';
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, { name, access, note });
      continue;
    }
    if (existing.access !== access && access !== '') {
      existing.access = existing.access === '' ? access : 'readwrite';
    }
    if (existing.note === '' && note !== '') existing.note = note;
  }
  return [...byName.values()].slice(0, MAX_TABLES_PER_NODE);
}

/** Matcher: does `name` (or its last `schema.` segment) occur in a text as a whole identifier? */
function identifierMatcher(name) {
  const candidates = [name];
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) candidates.push(name.slice(dot + 1));
  const patterns = candidates.map((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`, 'i');
  });
  return (text) => patterns.some((pattern) => pattern.test(text));
}

/**
 * Check every reported table against the project's own text: the node's files first, then
 * the files of the other nodes. A hit records the first file it was found in (`foundIn`);
 * `foundIn: null` means the name was not seen in any associated file, so the panel can tell
 * an evidenced table from one the model only inferred. Reads stay inside `rootPath`.
 */
async function attachTableEvidence(graph, rootPath) {
  const absoluteRoot = resolve(rootPath);
  const cache = new Map();
  /** Files skipped because of the read limit: "not found" would claim more than was checked. */
  const overLimit = new Set();
  let reads = 0;
  const textOf = async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let text;
    const full = resolve(absoluteRoot, rel);
    const inside = full === absoluteRoot || full.startsWith(`${absoluteRoot}${sep}`);
    if (inside && reads < TABLE_EVIDENCE_FILE_LIMIT) {
      reads += 1;
      text = await safeRead(full, TABLE_EVIDENCE_FILE_BYTES);
    } else if (inside) {
      overLimit.add(rel);
    }
    cache.set(rel, text);
    return text;
  };
  const allFiles = [...new Set(graph.nodes.flatMap((node) => node.files))];
  for (const node of graph.nodes) {
    const order = [...node.files, ...allFiles.filter((file) => !node.files.includes(file))];
    for (const table of node.tables) {
      const matches = identifierMatcher(table.name);
      table.foundIn = null;
      for (const rel of order) {
        const text = await textOf(rel);
        if (text !== undefined && matches(text)) {
          table.foundIn = rel;
          break;
        }
      }
      if (table.foundIn === null && order.some((rel) => overLimit.has(rel))) table.unchecked = true;
      // Cached files never reach the event loop on their own; let other requests run between tables.
      await yieldToEventLoop();
    }
  }
  return graph;
}

function normalizeGraph(value, rootPath) {
  if (typeof value !== 'object' || value === null) throw bizError('model did not return a graph object', 502);
  const nodes = [];
  const ids = new Set();
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  for (const raw of rawNodes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `n${nodes.length + 1}`;
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({
      id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
      kind: NODE_KINDS.has(raw.kind) ? raw.kind : 'process',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      files: Array.isArray(raw.files) ? raw.files.filter((f) => typeof f === 'string').slice(0, 12) : [],
      tables: normalizeTables(raw.tables),
    });
  }
  const edges = [];
  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  for (const raw of rawEdges) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (!ids.has(raw.from) || !ids.has(raw.to) || raw.from === raw.to) continue;
    edges.push({
      from: raw.from,
      to: raw.to,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 60) : '',
      kind: EDGE_KINDS.has(raw.kind) ? raw.kind : 'flow',
    });
  }
  if (nodes.length === 0) throw bizError('model returned an empty graph', 502);
  const keptNodes = nodes.slice(0, 40);
  const keptIds = new Set(keptNodes.map((node) => node.id));
  return {
    business: typeof value.business === 'string' && value.business !== '' ? value.business : '',
    rootPath,
    nodes: keptNodes,
    edges: edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to)).slice(0, 80),
  };
}

const ANALYZE_PROMPT = (business, digest) => [
  `请分析当前项目（你的工作目录就是项目根目录）中以下业务的「数据业务流程」：${business}`,
  '',
  '服务端已预扫描并摘录了项目文件，通常足以直接给出结论；只有摘录明显不足时才用工具补充，最多 3 次只读工具调用。',
  '不要修改任何文件，不要安装依赖或运行命令，不要创建子代理、团队或任务。',
  '',
  '项目文件索引（节选）：',
  digest.tree === '' ? '(空)' : digest.tree,
  '',
  '关键文件摘录：',
  digest.matched > 0
    ? `（按业务关键词 ${digest.keywords.join('、')} 排序，${digest.matched} 个文件命中，摘录围绕命中的代码行，… 表示省略）`
    : '（项目文件未命中业务关键词，以下只是通用入口文件；请先用工具搜索定位相关代码）',
  digest.excerpts === '' ? '(无可用摘录，请自行用工具少量查看)' : digest.excerpts,
  '',
  '然后回复且仅回复一个 JSON 对象（不要 markdown 代码围栏，不要多余文字）：',
  '{',
  '  "business": "<规范化的业务名>",',
  '  "nodes": [{"id": "n1", "name": "<简短名称>", "kind": "...", "summary": "<一两句话>", "files": ["相对路径"],',
  '             "tables": [{"name": "<表名>", "access": "read|write|readwrite", "note": "<可选，一句话说明用途>"}]}],',
  '  "edges": [{"from": "n1", "to": "n2", "label": "<短标签>", "kind": "..."}]',
  '}',
  '',
  '节点 kind 只能是：entry（用户/API/任务入口）、process（业务步骤/服务）、data（模型/表/存储/文件）、permission（鉴权/角色/租户边界）、external（第三方服务）。',
  '边 kind 只能是：flow（调用/控制顺序）、data（读写/产出）、auth（鉴权约束）。',
  '图保持可读：6-20 个节点，从入口排到数据落点；节点尽量使用项目里真实的模块/文件名。',
  'nodes 绝不能是空数组：若该项目没有直接实现该业务，就分析其中最接近的真实数据流程，并在 business 字段里注明。',
  '每个节点必须带上实现它的项目相对路径文件（能识别时）。',
  'tables 列出该节点直接读写的数据库表或集合：从 SQL、ORM 实体/模型的表名映射、Mapper、迁移脚本中识别，',
  '名称必须与项目代码里的写法完全一致（带 schema 前缀时保留）；access 写 read、write 或 readwrite。',
  '该节点不访问数据库或无法确认时给空数组，不要编造表名；data 类节点代表某个库时，列出其中与该业务相关的表。',
].join('\n');

/** One retry when the previous answer carried no nodes at all. */
const ANALYZE_REPAIR_PROMPT = [
  '你上一条回答没有给出任何节点（nodes 为空），这不是可用结果。',
  '请重新输出，务必保证 nodes 至少 6 个：',
  '- 若该业务在本项目中确实没有实现，就改为分析项目中「最接近的真实数据流程」，并在 business 字段中注明；',
  '- 若信息不足，可用工具补充查看，最多 3 次只读调用；',
  '- 不要返回空数组，不要解释。',
  '只输出一个 JSON 对象，结构：',
  '{"business":"...","nodes":[{"id":"n1","name":"...","kind":"entry|process|data|permission|external","summary":"...","files":["相对路径"],"tables":[{"name":"表名","access":"read|write|readwrite"}]}],"edges":[{"from":"n1","to":"n2","label":"...","kind":"flow|data|auth"}]}',
  'tables 只写项目代码中真实出现的表名，没有就给空数组。',
].join('\n');

const TABLE_ACCESS_LABEL = { read: '读', write: '写', readwrite: '读写' };

/** `节点涉及的表：orders(读写), order_item(写)` for the draft prompt, or '' when none are known. */
function tablesLine(tables) {
  const list = normalizeTables(tables);
  if (list.length === 0) return '';
  const items = list.map((table) => {
    const access = TABLE_ACCESS_LABEL[table.access];
    return access === undefined ? table.name : `${table.name}(${access})`;
  });
  return `节点涉及的表：${items.join(', ')}`;
}

const DRAFT_PROMPT = ({ business, node, neighbors, requirement, filesDigest }) => [
  '你是一名资深工程师。当前项目（你的工作目录即项目根目录）的数据业务流程中有一个节点，需要把用户的粗略需求改写成一段可直接执行的精准实现 prompt。',
  '',
  `业务流程：${business === '' ? '(未命名)' : business}`,
  `选中节点：${node.name} [${typeof node.kind === 'string' ? node.kind : 'process'}]`,
  typeof node.summary === 'string' && node.summary !== '' ? `节点说明：${node.summary}` : '',
  neighbors === '' ? '' : `业务相邻关系：\n${neighbors}`,
  Array.isArray(node.files) && node.files.length > 0 ? `节点关联文件：${node.files.join(', ')}` : '',
  tablesLine(node.tables),
  '',
  '服务端已摘录节点关联文件，通常可直接据此输出；确需确认细节时最多 2 次只读工具调用。',
  '不要修改任何文件，不要创建子代理、团队或任务。',
  filesDigest === '' ? '' : `关联文件摘录：\n${filesDigest}`,
  '',
  `用户需求：${requirement}`,
  '',
  '然后输出且仅输出最终 prompt 文本本身（markdown，不要解释、不要前后缀），要求：',
  '- 一句话重述目标；',
  '- 点名需要改动的具体文件/符号及原因；',
  '- 描述期望行为，包含数据与权限影响；',
  '- 列出验收标准；',
  '- 全文不超过 400 字。',
].filter((part) => part !== '').join('\n');

async function handleAnalyze(ctx, liveSessions, body, signal) {
  const business = typeof body.business === 'string' ? body.business.trim() : '';
  if (business === '') throw bizError('analyze requires a business description');
  const projectPath = resolveProjectPath(body.projectPath);

  let digest;
  try {
    digest = await buildProjectDigest(projectPath, business);
  } catch (error) {
    throw bizError(`cannot read project directory: ${error?.message ?? String(error)}`);
  }
  const entry = await createAnalysisSession(ctx, liveSessions, projectPath);
  let { answer } = await runAgentTurn(ctx, liveSessions, entry, ANALYZE_PROMPT(business, digest), signal);
  let parsed = pickGraphObject(answer);
  if (!usableGraph(parsed)) {
    // The model sometimes answers with an empty graph when it believes the
    // business is absent; one repair turn asks for the closest real flow.
    let retryAnswer = '';
    try {
      const retry = await runAgentTurn(ctx, liveSessions, entry, ANALYZE_REPAIR_PROMPT, signal);
      retryAnswer = retry.answer;
    } catch {
      /* keep the first answer's diagnostics */
    }
    const retried = pickGraphObject(retryAnswer);
    if (usableGraph(retried)) parsed = retried;
    else if (retryAnswer.trim() !== '') answer = retryAnswer;
  }
  if (!usableGraph(parsed)) {
    throw bizError(
      `agent returned no usable nodes — got: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`,
      502,
    );
  }
  const graph = await attachTableEvidence(normalizeGraph(parsed, projectPath), projectPath);
  return { graph, sessionId: entry.sessionId };
}

async function handleDraft(ctx, liveSessions, body, signal) {
  const projectPath = resolveProjectPath(body.projectPath);
  const node = typeof body.node === 'object' && body.node !== null ? body.node : undefined;
  const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : '';
  if (node === undefined || typeof node.name !== 'string') throw bizError('draft requires a selected node');
  if (requirement === '') throw bizError('draft requires a requirement');

  const business = typeof body.business === 'string' ? body.business : '';
  let neighbors = '';
  const graph = typeof body.graph === 'object' && body.graph !== null ? body.graph : undefined;
  if (graph !== undefined && Array.isArray(graph.edges) && Array.isArray(graph.nodes)) {
    const byId = new Map(graph.nodes.map((n) => [n?.id, n]));
    const related = [];
    for (const edge of graph.edges) {
      if (edge?.from === node.id) related.push(`→ ${byId.get(edge.to)?.name ?? edge.to} (${edge.kind}${edge.label ? `: ${edge.label}` : ''})`);
      if (edge?.to === node.id) related.push(`← ${byId.get(edge.from)?.name ?? edge.from} (${edge.kind}${edge.label ? `: ${edge.label}` : ''})`);
    }
    if (related.length > 0) neighbors = related.slice(0, 12).join('\n');
  }

  const filesDigest = await buildNodeDigest(projectPath, node.files);
  // Only a Session this plugin started for this project, so it is known to be read-only.
  const known = liveSessions.get(body.sessionId);
  const entry = known?.cwd === projectPath && !known.failed
    ? known
    : await createAnalysisSession(ctx, liveSessions, projectPath);
  const { answer } = await runAgentTurn(
    ctx, liveSessions, entry, DRAFT_PROMPT({ business, node, neighbors, requirement, filesDigest }), signal,
  );
  const trimmed = answer.trim();
  if (trimmed === '') throw bizError('agent returned an empty prompt — retry', 502);
  return { prompt: clip(trimmed, 12000), sessionId: entry.sessionId };
}

function handleHistoryGet() {
  return withHistory(async () => {
    const { entries } = await readHistoryState();
    return { entries: entries.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)) };
  });
}

/**
 * Merge entries into the history (by id). Never deletes: an old page that still posts its whole
 * (possibly truncated) list can no longer wipe records — deletions go through /history/delete.
 */
function handleHistoryMerge(body) {
  const entries = Array.isArray(body.entries) ? body.entries.filter(isHistoryEntry) : undefined;
  if (entries === undefined) throw bizError('history save requires an entries array');
  return withHistory(async () => {
    const state = await readHistoryState();
    const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      const existing = byId.get(entry.id);
      if (existing === undefined || (Number(entry.at) || 0) >= (Number(existing.at) || 0)) byId.set(entry.id, entry);
    }
    return { entries: await writeHistoryFile([...byId.values()], state.unreadable) };
  });
}

/** Insert or replace one entry; `replaceSameRun` also drops older records of the same project + business. */
function handleHistoryUpsert(body) {
  const entry = body.entry;
  if (!isHistoryEntry(entry)) throw bizError('history upsert requires a valid entry');
  const sameRun = (other) => other.projectPath === entry.projectPath && (other.business ?? '') === (entry.business ?? '');
  return withHistory(async () => {
    const state = await readHistoryState();
    const rest = state.entries.filter((other) => other.id !== entry.id && !(body.replaceSameRun === true && sameRun(other)));
    return { entries: await writeHistoryFile([{ ...entry, at: Number(entry.at) || Date.now() }, ...rest], state.unreadable) };
  });
}

/** Delete by ids, by project folder, or everything (`all: true`). */
function handleHistoryDelete(body) {
  const ids = Array.isArray(body.ids) ? new Set(body.ids.filter((id) => typeof id === 'string')) : null;
  const project = typeof body.projectPath === 'string' && body.projectPath !== '' ? body.projectPath : null;
  if (body.all !== true && ids === null && project === null) {
    throw bizError('history delete requires ids, projectPath or all');
  }
  return withHistory(async () => {
    if (body.all === true) return { entries: await writeHistoryFile([], []) };
    const state = await readHistoryState();
    const kept = state.entries.filter((entry) => !(
      (ids !== null && ids.has(entry.id)) || (project !== null && entry.projectPath === project)));
    return { entries: await writeHistoryFile(kept, state.unreadable) };
  });
}

function handlePing(ctx) {
  let configured = false;
  let provider = '';
  let model = '';
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
      && selection.provider !== '' && selection.model !== '') {
      configured = true;
      provider = selection.provider;
      model = selection.model;
    }
  } catch {
    /* unconfigured */
  }
  return { configured, provider, model };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function writeJson(response, status, body) {
  try {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  } catch {
    /* the browser may have navigated away */
  }
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw bizError(`request body exceeds ${limit} bytes`, 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw bizError('request body must be a JSON object');
    }
    return value;
  } catch (error) {
    if (error && error.status) throw error;
    throw bizError('request body is not valid JSON');
  }
}

export function apply(ctx) {
  /** sessionId → live analysis Session, oldest use first. */
  const liveSessions = new Map();
  // One route per path: the carrier keys exact routes by path, so methods are
  // dispatched inside the handler instead of registering the path again.
  const ROUTES = [
    ['/ping', ['GET'], async () => handlePing(ctx)],
    ['/analyze', ['POST'], async (body, signal) => handleAnalyze(ctx, liveSessions, body, signal)],
    ['/draft', ['POST'], async (body, signal) => handleDraft(ctx, liveSessions, body, signal)],
    ['/history', ['GET'], async () => handleHistoryGet()],
    ['/history/save', ['POST'], async (body) => handleHistoryMerge(body), MAX_HISTORY_BODY_BYTES],
    ['/history/upsert', ['POST'], async (body) => handleHistoryUpsert(body)],
    ['/history/delete', ['POST'], async (body) => handleHistoryDelete(body)],
    ['/history/clear', ['POST'], async () => handleHistoryDelete({ all: true })],
  ];

  ctx.effect(() => {
    const disposers = [];
    for (const [suffix, methods, handler, bodyLimit] of ROUTES) {
      try {
        disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PREFIX}${suffix}`,
        handler: async (request, response) => {
          try {
            if (!isLoopbackRequest(request, { checkReferer: true })) {
              writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden: loopback-only' } });
              return;
            }
            if (!methods.includes(request.method)) {
              writeJson(response, 405, { ok: false, error: { code: 'method', message: `expected ${methods.join(' or ')}` } });
              return;
            }
            const hasBody = request.method !== 'GET' && request.method !== 'DELETE';
            const body = hasBody ? await readJsonBody(request, bodyLimit) : {};
            const controller = new AbortController();
            // 'aborted' on IncomingMessage is deprecated; a response closed before it finished
            // means the browser went away, so stop the (possibly minutes-long) agent turn.
            response.on('close', () => {
              if (!response.writableFinished) controller.abort();
            });
            const payload = await handler(body, controller.signal, request.method);
            writeJson(response, 200, { ok: true, ...payload });
          } catch (error) {
            const status = error && error.status ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            writeJson(response, status, { ok: false, error: { code: 'internal', message } });
          }
        },
        }));
      } catch (error) {
        // A route left behind by an earlier activation still owns this path; the
        // panel keeps working, and the fresh handler takes over after a restart.
        ctx.logger?.warn?.(`business-flow: route ${PREFIX}${suffix} is already registered`, error);
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore disposal errors */
        }
      }
      for (const entry of [...liveSessions.values()]) disposeAnalysisSession(liveSessions, entry);
    };
  }, 'business-flow: routes');
}
