/**
 * Qwen Code history provider.
 *
 * Qwen Code is a Gemini CLI fork, so its chat logs use the Gemini-CLI session dialect:
 *   ~/.qwen/projects/<mangled-cwd>/chats/*.jsonl     current format (one replayable log per chat)
 *   ~/.qwen/tmp/<project>/chats/session-*.json(l)    legacy Gemini-CLI layout
 * `$QWEN_DATA_DIR` replaces the `projects` root. Records are
 * `{ id, timestamp, type: 'user'|'gemini'|'model', content: string | [{text}], toolCalls? }`;
 * some Qwen builds wrap the payload as `{ type, message: { role, parts|content, ... } }`, which
 * is accepted too. Non-message records (info/error) are ignored.
 *
 * Project folder: a `.project_root` marker inside the project directory, a `projects.json`
 * mapping (same shape as Gemini CLI), or a `cwd` field on a record — otherwise '' (the mangled
 * directory name is not decoded, because dashes in real folder names are ambiguous).
 *
 * Resume: `qwen` exposes no verified resume command here, so resume.kind is 'none'.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'qwen-code',
  name: 'Qwen Code',
  color: '#6366f1',
  homepage: 'https://github.com/QwenLM/qwen-code',
  cacheVersion: 2,
  resume: { kind: 'none' },
};

const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;

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

/** @param {import('../types.js').EnvFace} env @returns {string} */
function qwenHome(env) {
  const override = (process.env.QWEN_HOME || process.env.QWEN_CONFIG_DIR || '').trim();
  if (override !== '') return override.replace(/^~(?=$|[\\/])/, env.home);
  return join(env.home, '.qwen');
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

/** @param {unknown} content @returns {string} */
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
 * @param {number} fallbackTs
 * @returns {{role: 'user'|'assistant', text: string, ts: number, toolCalls: any[]}|null}
 */
function normalizeMessage(record, fallbackTs) {
  if (!record || typeof record !== 'object') return null;
  const wrapped = record.message && typeof record.message === 'object' ? record.message : null;
  let type = typeof record.type === 'string' ? record.type : '';
  if (type === '' && wrapped && typeof wrapped.role === 'string') type = wrapped.role;
  let role = '';
  if (type === 'user') role = 'user';
  else if (type === 'gemini' || type === 'model' || type === 'assistant') role = 'assistant';
  if (role === '') return null;
  const content = record.content !== undefined ? record.content : wrapped?.content ?? wrapped?.parts;
  const text = contentText(content);
  const ts = toEpochMs(record.timestamp) || toEpochMs(record.createdAt) || toEpochMs(wrapped?.timestamp) || fallbackTs;
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : Array.isArray(wrapped?.toolCalls) ? wrapped.toolCalls : [];
  if (text.trim() === '' && toolCalls.length === 0) return null;
  return { role, text, ts, toolCalls };
}

/**
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
    if (record.type === undefined && !(record.message && typeof record.message === 'object')) continue;
    const fallbackTs = toEpochMs(meta.startTime);
    const message = normalizeMessage(record, fallbackTs);
    if (!message) continue;
    const key =
      typeof record.id === 'string' && record.id !== ''
        ? record.id
        : typeof record.uuid === 'string' && record.uuid !== ''
          ? record.uuid
          : `auto-${autoId++}`;
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

/** @param {string} filePath @returns {'json'|'jsonl'} */
function fileKind(filePath) {
  return /\.jsonl$/i.test(filePath) ? 'jsonl' : 'json';
}

/**
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} filePath
 * @param {'json'|'jsonl'} kind
 * @returns {Promise<{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}|null>}
 */
async function readParsedSession(utils, filePath, kind) {
  const raw = await readText(filePath);
  if (raw === null) return null;
  const stem = utils.basenameOf(filePath).replace(/\.(jsonl?)$/i, '');
  let parsed = kind === 'jsonl' ? parseJsonlDocument(raw) : parseJsonDocument(raw);
  if (parsed === null) parsed = kind === 'jsonl' ? parseJsonDocument(raw) : parseJsonlDocument(raw);
  if (parsed === null) return null;
  if (parsed.nativeId === '' && stem !== '') parsed.nativeId = stem;
  return parsed;
}

/**
 * @param {{nativeId: string, title: string, startedAt: number, updatedAt: number, messages: any[]}} parsed
 * @param {string} filePath
 * @param {'json'|'jsonl'} kind
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

/**
 * Read `projects.json` (Gemini-CLI shape) in both directions.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} projectsFile
 * @returns {Promise<{slotToPath: Map<string, string>, paths: string[]}>}
 */
async function readProjectsFile(utils, projectsFile) {
  /** @type {Map<string, string>} */
  const slotToPath = new Map();
  /** @type {string[]} */
  const paths = [];
  const raw = await readText(projectsFile);
  if (raw === null) return { slotToPath, paths };
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') return { slotToPath, paths };
  const container = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : parsed;
  const entries = Array.isArray(container) ? container : Object.entries(container);
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [path, slot] = entry;
    if (typeof path !== 'string' || path === '' || typeof slot !== 'string' || slot === '') continue;
    paths.push(path);
    if (!slotToPath.has(slot)) slotToPath.set(slot, path);
  }
  return { slotToPath, paths };
}

/**
 * Resolve the project folder for a directory that holds `chats/`.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} projectDir
 * @param {Map<string, string>} slotToPath
 * @param {string[]} knownPaths
 * @returns {Promise<string>}
 */
async function resolveProjectPath(utils, projectDir, slotToPath, knownPaths) {
  const name = utils.basenameOf(projectDir);
  const direct = slotToPath.get(name);
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const path of knownPaths) {
    if (sha256Hex(path) === name) return path;
  }
  const marker = await readText(join(projectDir, '.project_root'));
  const text = typeof marker === 'string' ? marker.trim() : '';
  if (text !== '' && (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text))) return text;
  return '';
}

/**
 * Scan one `chats` tree (recursive, including legacy `tmp/<project>/chats`).
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} root
 * @param {Map<string, string>} slotToPath
 * @param {string[]} knownPaths
 * @param {string} mapFingerprint projects.json stat, so a re-mapping invalidates cached rows
 * @returns {Promise<{sessions: any[], files: number, bytes: number}>}
 */
async function scanChatsTree(ctx, root, slotToPath, knownPaths, mapFingerprint) {
  const { utils } = ctx;
  /** @type {any[]} */
  const sessions = [];
  let files = 0;
  let bytes = 0;
  const listed = await utils.listFilesRecursive(root, {
    exts: ['.json', '.jsonl'],
    maxDepth: 6,
    maxFiles: 20000,
    signal: ctx.signal,
  });
  /** @type {Map<string, string>} */
  const projectPathCache = new Map();
  /** @type {Map<string, any>} */
  const byNativeId = new Map();
  for (const file of listed) {
    if (ctx.signal?.aborted) break;
    const normalized = file.path.replace(/\\/g, '/');
    const chatsIndex = normalized.lastIndexOf('/chats/');
    if (chatsIndex < 0) continue; // only files inside a chats/ directory are session logs
    const projectDir = normalized.slice(0, chatsIndex);
    let projectPath = projectPathCache.get(projectDir);
    if (projectPath === undefined) {
      projectPath = await resolveProjectPath(utils, projectDir, slotToPath, knownPaths);
      projectPathCache.set(projectDir, projectPath);
    }
    files += 1;
    bytes += file.size;
    const kind = fileKind(file.path);
    const fingerprint = `${file.path}:${file.size}:${Math.round(file.mtimeMs)}:${mapFingerprint}:v2`;
    let rows = cacheGet(ctx, file.path, fingerprint);
    if (!rows) {
      try {
        const parsed = await readParsedSession(utils, file.path, kind);
        rows = parsed ? [buildSession(parsed, file.path, kind, projectPath, file.size)].filter(Boolean) : [];
      } catch (error) {
        ctx.warn(`Qwen Code: cannot read ${file.path}: ${error?.message || error}`);
        rows = [];
      }
      cacheSet(ctx, file.path, fingerprint, rows);
    }
    for (const row of rows) {
      const previous = byNativeId.get(row.nativeId);
      if (previous === undefined || (previous.ref?.kind !== 'jsonl' && row.ref?.kind === 'jsonl') || row.updatedAt > previous.updatedAt) {
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
  const home = qwenHome(env);
  const override = (process.env.QWEN_DATA_DIR || '').trim();
  const projectsDir = override !== '' ? override.replace(/^~(?=$|[\\/])/, env.home) : join(home, 'projects');
  const legacyTmpDir = join(home, 'tmp');
  const projectsFile = join(home, 'projects.json');
  const projectsRaw = await readText(projectsFile);
  const projectsFileStat = await utils.statSafe(projectsFile);
  const mapFingerprint = projectsFileStat ? `${projectsFileStat.size}:${Math.round(projectsFileStat.mtimeMs)}` : '-';
  const { slotToPath, paths } = await readProjectsFile(utils, projectsFile);

  const projectsStat = await utils.statSafe(projectsDir);
  if (projectsStat && projectsStat.isDirectory) {
    const result = await scanChatsTree(ctx, projectsDir, slotToPath, paths, mapFingerprint);
    sessions.push(...result.sessions);
    sources.push({
      label: 'Qwen Code chats',
      path: projectsDir,
      exists: true,
      files: result.files,
      bytes: result.bytes,
      note: 'projects/**/chats JSONL sessions; project from .project_root/projects.json, never guessed',
    });
  } else {
    sources.push({
      label: 'Qwen Code chats',
      path: projectsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: override !== '' ? 'QWEN_DATA_DIR is set but the directory does not exist' : 'Qwen Code is not installed on this machine',
    });
  }

  const legacyStat = await utils.statSafe(legacyTmpDir);
  if (legacyStat && legacyStat.isDirectory) {
    const result = await scanChatsTree(ctx, legacyTmpDir, slotToPath, paths, mapFingerprint);
    sessions.push(...result.sessions);
    sources.push({
      label: 'Qwen Code legacy sessions',
      path: legacyTmpDir,
      exists: true,
      files: result.files,
      bytes: result.bytes,
      note: 'Gemini-CLI-style legacy tmp/<project>/chats sessions',
    });
  }

  if (projectsRaw !== null) {
    sources.push({
      label: 'Qwen Code project map',
      path: projectsFile,
      exists: true,
      files: slotToPath.size,
      bytes: Buffer.byteLength(projectsRaw),
      note: 'projects.json: absolute project path -> chats slot name',
    });
  }

  if (sources.some((source) => source.exists) && sessions.length === 0) {
    ctx.warn('Qwen Code: a session store was found but none contains a readable user/assistant conversation');
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
