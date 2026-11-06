/**
 * Google Gemini CLI history provider.
 *
 * Gemini CLI keeps per-project chat logs under
 *   ~/.gemini/tmp/<project-slot>/chats/   (GEMINI_CLI_HOME prepends its own directory layout)
 * where `<project-slot>` is either the friendly project name from `~/.gemini/projects.json`
 * (`{ "projects": { "<absolute project path>": "<slot name>" } }`) or the SHA-256 hex of the
 * absolute project path. A per-slot `.project_root` marker file is another project-name source.
 *
 * Two generations of session files coexist:
 *   chats/session-*.json    whole document `{ sessionId, startTime, lastUpdated, messages }`
 *   chats/session-*.jsonl   replayable log: a metadata line, message lines keyed by `id`
 *                           (rewritten, so the last record wins), `$set` metadata patches and
 *                           `$rewindTo` rewinds that drop the referenced message onwards.
 * Messages are `{ id, timestamp, type: 'user'|'gemini'|'model', content: string | [{text}],
 * toolCalls?: [{ name, args, status, result }] }`; other types (info/error events) are ignored.
 *
 * Resume: `gemini --resume <sessionId>` from the session's project folder (verified against
 * Gemini CLI 0.55.1; the CLI resolves the inner sessionId UUID).
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  color: '#4285f4',
  homepage: 'https://github.com/google-gemini/gemini-cli',
  cacheVersion: 2,
  resume: { kind: 'cli', command: 'gemini', args: ['--resume', '{id}'] },
};

const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;
const MAX_PROJECT_SLOTS = 2000;

/**
 * Cache access that tolerates both the documented 2-arg CacheFace (the scanner now binds the
 * provider id) and the 3-arg HistoryCache the self-test still passes. Never throws.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 * @returns {any[]|undefined}
 */
function cacheGet(ctx, filePath, fingerprint) {
  const cache = ctx.cache;
  if (!cache || typeof cache.get !== 'function') return undefined;
  try {
    return cache.get.length >= 3 ? cache.get(ctx.providerId, filePath, fingerprint) : cache.get(filePath, fingerprint);
  } catch {
    return undefined;
  }
}

/** @param {import('../types.js').ScanContext} ctx */
function cacheSet(ctx, filePath, fingerprint, rows) {
  const cache = ctx.cache;
  if (!cache || typeof cache.set !== 'function') return;
  try {
    if (cache.set.length >= 4) cache.set(ctx.providerId, filePath, fingerprint, rows);
    else cache.set(filePath, fingerprint, rows);
  } catch {
    // ignore
  }
}

/** @param {import('../types.js').EnvFace} env @returns {string[]} */
function geminiHomes(env) {
  const homes = [];
  const geminiDir = (process.env.GEMINI_DIR || '').trim();
  if (geminiDir !== '') homes.push(geminiDir.replace(/^~(?=$|[\\/])/, env.home));
  const cliHome = (process.env.GEMINI_CLI_HOME || '').trim();
  if (cliHome !== '') homes.push(join(cliHome.replace(/^~(?=$|[\\/])/, env.home), '.gemini'));
  homes.push(join(env.home, '.gemini'));
  return [...new Set(homes)];
}

/** @param {string} value @returns {string} */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {number} epoch ms, 0 when unparseable */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) return toEpochMs(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/**
 * Read `projects.json` into both directions: absolute path -> friendly slot, slot -> path.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} projectsFile
 * @returns {Promise<{pathToSlot: Map<string, string>, slotToPath: Map<string, string>}>}
 */
async function readProjectsFile(utils, projectsFile) {
  /** @type {Map<string, string>} */
  const pathToSlot = new Map();
  /** @type {Map<string, string>} */
  const slotToPath = new Map();
  const raw = await readText(projectsFile);
  if (raw === null) return { pathToSlot, slotToPath };
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') return { pathToSlot, slotToPath };
  const container = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : parsed;
  const entries = Array.isArray(container) ? container : Object.entries(container);
  for (const entry of entries) {
    let path = '';
    let slot = '';
    if (Array.isArray(entry)) {
      // { "<path>": "<slot>" } (documented shape)
      if (typeof entry[0] === 'string') path = entry[0];
      if (typeof entry[1] === 'string') slot = entry[1];
    } else if (entry && typeof entry === 'object') {
      const record = /** @type {Record<string, any>} */ (entry);
      path = typeof record.path === 'string' ? record.path : typeof record.root === 'string' ? record.root : '';
      slot = typeof record.slot === 'string' ? record.slot : typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : '';
    }
    if (path === '' || slot === '') continue;
    pathToSlot.set(path, slot);
    if (!slotToPath.has(slot)) slotToPath.set(slot, path);
  }
  return { pathToSlot, slotToPath };
}

/**
 * Project folder for one `tmp/<slot>` directory. Never guesses: projects.json or a
 * `.project_root` marker must name a real folder.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} tmpDir
 * @param {string} slot
 * @param {Map<string, string>} slotToPath
 * @param {Map<string, string>} pathToSlot
 * @param {string[]} knownPaths
 * @returns {Promise<string>}
 */
async function resolveProjectPath(utils, tmpDir, slot, slotToPath, pathToSlot, knownPaths) {
  const direct = slotToPath.get(slot);
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const path of knownPaths) {
    if (pathToSlot.get(path) === slot) return path;
    if (sha256Hex(path) === slot) return path;
  }
  const marker = await readText(join(tmpDir, slot, '.project_root'));
  const text = typeof marker === 'string' ? marker.trim() : '';
  if (text !== '' && (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text))) return text;
  return '';
}

/**
 * Message text out of Gemini's content shapes (string, `[{text}]`, `{parts:[{text}]}`).
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const record = /** @type {Record<string, any>} */ (content);
    if (Array.isArray(record.parts)) return contentText(record.parts);
    if (typeof record.text === 'string') return record.text;
  }
  return '';
}

/**
 * @param {Record<string, any>} record
 * @returns {{role: 'user'|'assistant', text: string, ts: number, toolCalls: any[]} | null}
 */
function normalizeMessage(record, fallbackTs) {
  if (!record || typeof record !== 'object') return null;
  const type = typeof record.type === 'string' ? record.type : '';
  let role = '';
  if (type === 'user') role = 'user';
  else if (type === 'gemini' || type === 'model' || type === 'assistant') role = 'assistant';
  if (role === '') return null;
  const content = record.content !== undefined ? record.content : record.message?.content ?? record.message?.parts;
  const text = contentText(content);
  const ts = toEpochMs(record.timestamp) || toEpochMs(record.createdAt) || fallbackTs;
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  if (text.trim() === '' && toolCalls.length === 0) return null;
  return { role, text, ts, toolCalls };
}

/**
 * Whole-session JSON document (`chats/session-*.json`).
 * @param {string} raw
 * @returns {{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}|null}
 */
function parseJsonDocument(raw) {
  const document = safeJsonParse(raw);
  if (!document || typeof document !== 'object') return null;
  const messagesSource = Array.isArray(document.messages) ? document.messages : Array.isArray(document.history) ? document.history : null;
  if (messagesSource === null) return null;
  const sessionStart = toEpochMs(document.startTime) || toEpochMs(document.lastUpdated);
  /** @type {any[]} */
  const messages = [];
  for (const record of messagesSource) {
    const message = normalizeMessage(record, sessionStart);
    if (message) messages.push(message);
  }
  if (messages.length === 0) return null;
  return {
    nativeId: typeof document.sessionId === 'string' && document.sessionId.trim() !== '' ? document.sessionId.trim() : '',
    title: typeof document.title === 'string' ? document.title : typeof document.summary === 'string' ? document.summary : '',
    startedAt: toEpochMs(document.startTime) || messages[0]?.ts || 0,
    updatedAt: toEpochMs(document.lastUpdated) || messages[messages.length - 1]?.ts || 0,
    messages,
  };
}

/**
 * Replayable JSONL log (`chats/session-*.jsonl`).
 * @param {string} raw
 * @returns {{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}|null}
 */
function parseJsonlDocument(raw) {
  /** @type {Record<string, any>} */
  const meta = {};
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {string[]} */
  const order = [];
  let autoId = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const record = safeJsonParse(line);
    if (!record || typeof record !== 'object') continue;
    if (record.$set && typeof record.$set === 'object') {
      for (const key of ['lastUpdated', 'startTime', 'sessionId', 'title', 'summary']) {
        if (record.$set[key] !== undefined) meta[key] = record.$set[key];
      }
      continue;
    }
    if (typeof record.$rewindTo === 'string' && record.$rewindTo !== '') {
      const index = order.indexOf(record.$rewindTo);
      if (index >= 0) {
        for (const id of order.slice(index)) byId.delete(id);
        order.length = index;
      }
      continue;
    }
    if (record.sessionId !== undefined && record.type === undefined) {
      for (const key of ['sessionId', 'startTime', 'lastUpdated', 'title', 'summary']) {
        if (record[key] !== undefined) meta[key] = record[key];
      }
      continue;
    }
    if (record.type === undefined) continue;
    const fallbackTs = toEpochMs(meta.startTime);
    const message = normalizeMessage(record, fallbackTs);
    if (!message) continue;
    const key = typeof record.id === 'string' && record.id !== '' ? record.id : `auto-${autoId++}`;
    if (!byId.has(key)) order.push(key);
    byId.set(key, message);
  }
  const messages = order.map((id) => byId.get(id)).filter(Boolean);
  if (messages.length === 0) return null;
  return {
    nativeId: typeof meta.sessionId === 'string' && meta.sessionId.trim() !== '' ? meta.sessionId.trim() : '',
    title: typeof meta.title === 'string' ? meta.title : typeof meta.summary === 'string' ? meta.summary : '',
    startedAt: toEpochMs(meta.startTime) || messages[0]?.ts || 0,
    updatedAt: toEpochMs(meta.lastUpdated) || messages[messages.length - 1]?.ts || 0,
    messages,
  };
}

/**
 * @param {{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}} parsed
 * @param {string} filePath
 * @param {string} kind
 * @param {string} projectPath
 * @param {number} sizeBytes
 * @returns {any|null}
 */
function buildSession(parsed, filePath, kind, projectPath, sizeBytes) {
  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  let firstTs = 0;
  let lastTs = 0;
  for (const message of parsed.messages) {
    if (message.ts > 0) {
      if (firstTs === 0 || message.ts < firstTs) firstTs = message.ts;
      if (message.ts > lastTs) lastTs = message.ts;
    }
    if (message.text.trim() === '') continue;
    messages += 1;
    if (message.role === 'user') {
      userMessages += 1;
      if (firstPrompt === '') firstPrompt = message.text;
    }
    lastPreview = message.text;
  }
  if (messages === 0) return null;
  const began = parsed.startedAt || firstTs;
  const ended = parsed.updatedAt || lastTs || began;
  return {
    nativeId: parsed.nativeId,
    title: parsed.title.trim() !== '' ? parsed.title.trim() : titleFromPrompt(firstPrompt, 90) || '未命名会话',
    projectPath,
    startedAt: began,
    updatedAt: ended,
    messages,
    userMessages,
    sizeBytes,
    preview: cleanPrompt(firstPrompt).slice(0, 220),
    lastPreview: cleanPrompt(lastPreview).slice(0, 220),
    sourcePath: filePath,
    ref: { file: filePath, kind, nativeId: parsed.nativeId },
  };
}

/** @param {string} filePath @returns {'json'|'jsonl'} */
function fileKind(filePath) {
  return /\.jsonl$/i.test(filePath) ? 'jsonl' : 'json';
}

/**
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} filePath
 * @param {string} kind
 * @returns {Promise<{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}|null>}
 */
async function readParsedSession(utils, filePath, kind) {
  const raw = await readText(filePath);
  if (raw === null) return null;
  const stem = utils.basenameOf(filePath).replace(/\.(jsonl?)$/i, '');
  const parsed = kind === 'jsonl' ? parseJsonlDocument(raw) : parseJsonDocument(raw);
  if (parsed === null) {
    // A file can be renamed between generations; try the other dialect before giving up.
    const other = kind === 'jsonl' ? parseJsonDocument(raw) : parseJsonlDocument(raw);
    if (other !== null && other.nativeId === '' && stem !== '') other.nativeId = stem;
    return other;
  }
  if (parsed.nativeId === '' && stem !== '') parsed.nativeId = stem;
  return parsed;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} chatsDir
 * @param {string} projectPath
 * @param {string} mapFingerprint projects.json stat, so a re-mapping invalidates cached rows
 * @returns {Promise<{sessions: any[], files: number, bytes: number}>}
 */
async function scanChatsDir(ctx, chatsDir, projectPath, mapFingerprint) {
  const { utils } = ctx;
  /** @type {any[]} */
  const sessions = [];
  let files = 0;
  let bytes = 0;
  const entries = await utils.readdirSafe(chatsDir);
  /** @type {{path: string, kind: 'json'|'jsonl', size: number, mtimeMs: number}[]} */
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(json|jsonl)$/i.test(entry.name)) continue;
    const filePath = join(chatsDir, entry.name);
    const stat = await utils.statSafe(filePath);
    if (stat === null || !stat.isFile) continue;
    candidates.push({ path: filePath, kind: fileKind(entry.name), size: stat.size, mtimeMs: stat.mtimeMs });
  }
  // Prefer the replayable .jsonl form when both generations describe the same session id.
  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'json' ? -1 : 1));
  /** @type {Map<string, any>} */
  const byNativeId = new Map();
  for (const file of candidates) {
    if (ctx.signal?.aborted) break;
    files += 1;
    bytes += file.size;
    const fingerprint = `${file.path}:${file.size}:${Math.round(file.mtimeMs)}:${mapFingerprint}:v2`;
    let rows = cacheGet(ctx, file.path, fingerprint);
    if (!rows) {
      try {
        const parsed = await readParsedSession(ctx.utils, file.path, file.kind);
        rows = parsed ? [buildSession(parsed, file.path, file.kind, projectPath, file.size)].filter(Boolean) : [];
      } catch (error) {
        ctx.warn(`Gemini CLI: cannot read ${file.path}: ${error?.message || error}`);
        rows = [];
      }
      cacheSet(ctx, file.path, fingerprint, rows);
    }
    for (const row of rows) {
      const previous = byNativeId.get(row.nativeId);
      if (previous === undefined || (previous.ref?.kind !== 'jsonl' && row.ref?.kind === 'jsonl')) {
        byNativeId.set(row.nativeId, row);
      }
    }
  }
  sessions.push(...byNativeId.values());
  return { sessions, files, bytes };
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];
  let foundStore = false;

  for (const home of geminiHomes(env)) {
    const tmpDir = join(home, 'tmp');
    const projectsFile = join(home, 'projects.json');
    const tmpStat = await utils.statSafe(tmpDir);
    const projectsRaw = await readText(projectsFile);
    const projectsStat = await utils.statSafe(projectsFile);
    const mapFingerprint = projectsStat ? `${projectsStat.size}:${Math.round(projectsStat.mtimeMs)}` : '-';
    const { pathToSlot, slotToPath } = await readProjectsFile(utils, projectsFile);
    const knownPaths = [...pathToSlot.keys()];
    if (tmpStat && tmpStat.isDirectory) {
      foundStore = true;
      const slots = (await utils.readdirSafe(tmpDir)).filter((entry) => entry.isDirectory()).slice(0, MAX_PROJECT_SLOTS);
      let files = 0;
      let bytes = 0;
      /** @type {Map<string, any>} */
      const byNativeId = new Map();
      for (const slot of slots) {
        if (ctx.signal?.aborted) break;
        const projectPath = await resolveProjectPath(utils, tmpDir, slot.name, slotToPath, pathToSlot, knownPaths);
        const result = await scanChatsDir(ctx, join(tmpDir, slot.name, 'chats'), projectPath, mapFingerprint);
        files += result.files;
        bytes += result.bytes;
        for (const row of result.sessions) {
          const previous = byNativeId.get(row.nativeId);
          if (previous === undefined || (previous.ref?.kind !== 'jsonl' && row.ref?.kind === 'jsonl') || row.updatedAt > previous.updatedAt) {
            byNativeId.set(row.nativeId, row);
          }
        }
      }
      sessions.push(...byNativeId.values());
      sources.push({
        label: 'Gemini CLI sessions',
        path: tmpDir,
        exists: true,
        files,
        bytes,
        note: 'tmp/<project>/chats session JSON/JSONL; project from projects.json or .project_root, never guessed',
      });
    } else {
      sources.push({
        label: 'Gemini CLI sessions',
        path: tmpDir,
        exists: false,
        files: 0,
        bytes: 0,
        note: home === join(env.home, '.gemini') ? 'Gemini CLI is not installed (no ~/.gemini/tmp)' : 'configured Gemini CLI home has no tmp/ directory',
      });
    }
    sources.push({
      label: 'Gemini CLI project map',
      path: projectsFile,
      exists: projectsRaw !== null,
      files: pathToSlot.size,
      bytes: projectsRaw === null ? 0 : Buffer.byteLength(projectsRaw),
      note: 'projects.json: absolute project path -> tmp slot name',
    });
  }

  if (foundStore && sources.some((source) => source.label === 'Gemini CLI sessions' && source.exists) && sessions.length === 0) {
    ctx.warn('Gemini CLI: session files were found but none contains a readable user/assistant conversation');
  }

  return { sources, sessions };
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  const kind = session?.ref?.kind || (typeof filePath === 'string' ? fileKind(filePath) : 'json');
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  const parsed = await readParsedSession(ctx.utils, filePath, kind);
  if (parsed === null) return { messages: [] };
  /** @type {any[]} */
  const messages = [];
  for (const message of parsed.messages) {
    if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
    if (message.text.trim() !== '') {
      messages.push({ role: message.role, ts: message.ts, text: message.text.slice(0, MAX_TEXT) });
    }
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (!call || typeof call !== 'object') continue;
      const name = typeof call.name === 'string' ? call.name : 'tool';
      messages.push({
        role: 'tool',
        ts: message.ts,
        kind: 'tool-call',
        name,
        text: clip(typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}), 600),
      });
      if (call.result !== undefined && call.result !== null) {
        const body = typeof call.result === 'string' ? call.result : JSON.stringify(call.result);
        if (body.trim() !== '') messages.push({ role: 'tool', ts: message.ts, kind: 'tool-result', name, text: body.slice(0, MAX_TEXT) });
      }
    }
  }
  return { messages };
}
