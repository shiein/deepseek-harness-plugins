/**
 * Zed history provider.
 *
 * Zed persists every agent-panel thread in one SQLite database:
 *   macOS:   ~/Library/Application Support/Zed/threads/threads.db
 *   Windows: %LOCALAPPDATA%\Zed\threads\threads.db
 *   Linux:   $XDG_DATA_HOME/zed/threads/threads.db (defaults to ~/.local/share)
 *
 * The `threads` table has one row per thread: `id`, `summary`, `updated_at`, `data_type`,
 * `data`, `folder_paths`, `created_at`, `parent_id`. `data` is either raw UTF-8 JSON
 * (`data_type = 'json'`) or a zstd frame (`data_type = 'zstd'`). The decoded payload is the
 * DbThread JSON: `{ title, messages, created/updated timestamps, model, imported, ... }`
 * with externally tagged message entries:
 *   { "User":  { id, content: [{ Text } | { Mention } | { Image }] } }
 *   { "Agent": { content: [{ Text } | { Thinking } | { ToolUse }], tool_results } }
 * "Resume" is a unit variant serialized as a bare string.
 *
 * Zed has no CLI resume command (it is a GUI editor), so `resume.kind` is 'none'; the
 * transcript itself stays readable through `readMessages`.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'zed',
  name: 'Zed',
  color: '#3b82f6',
  homepage: 'https://zed.dev',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/** Thread payloads larger than this are treated as unreadable instead of stalling a refresh. */
const MAX_THREAD_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function databaseCandidates(env) {
  if (env.platform === 'win32') {
    const local = env.localAppData || join(env.home, 'AppData', 'Local');
    return [join(local, 'Zed', 'threads', 'threads.db')];
  }
  if (env.platform === 'darwin') {
    return [join(env.home, 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')];
  }
  return [join(env.xdgData, 'zed', 'threads', 'threads.db')];
}

/**
 * Cache access that tolerates both documented 2-arg CacheFace and the 3-arg HistoryCache the
 * scanner currently passes. Never throws: caching is an optimization only.
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

/**
 * Fingerprint of a SQLite database plus its WAL/SHM sidecars. A live Zed writes to -wal, so
 * omitting it would reuse stale rows while the app is open.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} path
 * @returns {Promise<string>}
 */
async function sqliteFingerprint(utils, path) {
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${path}${suffix}`);
    if (stat && stat.isFile) parts.push(`${stat.size}:${Math.round(stat.mtimeMs)}`);
    else if (suffix === '') return '';
    else parts.push('-');
  }
  return parts.join('|');
}

/**
 * Decode the `data` column of one thread row.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {unknown} dataType
 * @param {unknown} raw
 * @returns {string|null}
 */
function decodeThreadData(utils, dataType, raw) {
  if (raw === null || raw === undefined) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : null;
  if (!buffer || buffer.length === 0 || buffer.length > MAX_THREAD_JSON_BYTES) return null;
  const type = String(dataType || '').trim().toLowerCase();
  if (type === 'zstd' || (type !== 'json' && utils.isZstd(buffer))) {
    try {
      return utils.zstdDecompressAll(buffer).toString('utf8');
    } catch {
      return null;
    }
  }
  if (type === 'json' || type === '' || buffer[0] === 0x7b) return buffer.toString('utf8');
  return null;
}

/**
 * Text of one content block in either message enum (Text / Thinking / mentions are tolerated).
 * @param {unknown} block
 * @param {'text'|'thinking'|'tool'} [wanted]
 * @returns {string}
 */
function blockText(block, wanted = 'text') {
  if (typeof block === 'string') return wanted === 'text' ? block : '';
  if (!block || typeof block !== 'object') return '';
  const record = /** @type {Record<string, any>} */ (block);
  if (wanted === 'thinking') {
    const thinking = record.Thinking;
    if (thinking && typeof thinking === 'object' && typeof thinking.text === 'string') return thinking.text;
    if (typeof thinking === 'string') return thinking;
    if (typeof record.RedactedThinking === 'string') return '';
    return '';
  }
  if (typeof record.Text === 'string') return record.Text;
  if (wanted === 'text' && typeof record.text === 'string') return record.text;
  return '';
}

/**
 * Plain text out of a Zed tool result (`content` enum or `output` JSON value).
 * @param {unknown} result
 * @returns {string}
 */
function toolResultText(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const record = /** @type {Record<string, any>} */ (result);
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      const text = blockText(block);
      if (text !== '') parts.push(text);
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const text = blockText(content);
    if (text !== '') return text;
  }
  if (record.output !== undefined && record.output !== null) {
    if (typeof record.output === 'string') return record.output;
    try {
      return JSON.stringify(record.output);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Extract the human-readable conversation parts of one thread payload.
 * @param {any} thread
 * @returns {{userMessages: number, messages: number, firstPrompt: string, lastPreview: string,
 *            firstTs: number, lastTs: number}}
 */
function summarizeThread(thread) {
  let userMessages = 0;
  let messages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  let firstTs = 0;
  let lastTs = 0;
  const entries = Array.isArray(thread?.messages) ? thread.messages : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const user = entry.User;
    const agent = entry.Agent;
    if (user && typeof user === 'object') {
      const text = extractUserText(user);
      if (text === '') continue;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = text;
      lastPreview = text;
    } else if (agent && typeof agent === 'object') {
      const content = Array.isArray(agent.content) ? agent.content : [];
      const text = content.map((block) => blockText(block)).filter((value) => value.trim() !== '').join('\n');
      if (text === '') continue;
      messages += 1;
      lastPreview = text;
    }
  }
  return { userMessages, messages, firstPrompt, lastPreview, firstTs, lastTs };
}

/** @param {any} userMessage @returns {string} */
function extractUserText(userMessage) {
  const content = Array.isArray(userMessage.content) ? userMessage.content : [];
  const parts = [];
  for (const block of content) {
    const text = blockText(block);
    if (text.trim() !== '') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Project folder recorded in the row's `folder_paths` column (JSON array of paths).
 * @param {unknown} raw
 * @returns {string}
 */
function projectFromFolderPaths(raw) {
  if (raw === null || raw === undefined) return '';
  let value = raw;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = Buffer.from(value).toString('utf8');
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[')) {
    const parsed = safeJsonParse(trimmed);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
      }
    }
    return '';
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/**
 * Turn one decoded thread into a session summary row.
 * @param {any} thread
 * @param {Record<string, any>} row
 * @param {string} dbPath
 * @param {number} dataBytes
 * @returns {any|null}
 */
function buildSession(thread, row, dbPath, dataBytes) {
  const summary = summarizeThread(thread);
  if (summary.messages === 0) return null;
  // Zed only records thread-level timestamps (no per-message clock), so the first prompt and
  // the last activity both fall back to the thread's created_at/updated_at columns.
  const startedAt = firstPositive(toEpochMs(thread?.created_at), toEpochMs(row?.created_at), toEpochMs(thread?.updated_at));
  const updatedAt = firstPositive(toEpochMs(thread?.updated_at), toEpochMs(row?.updated_at), startedAt);
  const title = typeof thread?.title === 'string' && thread.title.trim() !== '' ? thread.title.trim() : String(row?.summary || '').trim();
  const model = thread?.model && typeof thread.model === 'object' && typeof thread.model.model === 'string' ? thread.model.model.trim() : '';
  const projectPath = projectFromFolderPaths(row?.folder_paths);
  return {
    nativeId: String(row?.id || '').trim(),
    title: title !== '' ? title : titleFromPrompt(summary.firstPrompt, 90) || '未命名会话',
    projectPath,
    startedAt,
    updatedAt,
    messages: summary.messages,
    userMessages: summary.userMessages,
    sizeBytes: dataBytes,
    preview: cleanPrompt(summary.firstPrompt).slice(0, 220),
    lastPreview: cleanPrompt(summary.lastPreview).slice(0, 220),
    sourcePath: dbPath,
    extra: [model, thread?.imported === true ? 'imported' : ''].filter(Boolean).join(' · ') || undefined,
    ref: { file: dbPath, threadId: String(row?.id || '') },
  };
}

/** @param {...number} values @returns {number} */
function firstPositive(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * Read every thread of one database and return session rows (cached by file fingerprint).
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} dbPath
 * @returns {Promise<{sessions: any[], threads: number, bytes: number}>}
 */
async function scanDatabase(ctx, dbPath) {
  const { utils } = ctx;
  const fingerprint = await sqliteFingerprint(utils, dbPath);
  if (fingerprint === '') return { sessions: [], threads: 0, bytes: 0 };
  const cached = cacheGet(ctx, dbPath, fingerprint);
  if (cached) return { sessions: cached, threads: cached.length, bytes: 0 };

  const dbStat = await utils.statSafe(dbPath);
  const walStat = await utils.statSafe(`${dbPath}-wal`);
  const bytes = (dbStat?.size || 0) + (walStat?.size || 0);
  /** @type {any[]} */
  const sessions = [];
  let threads = 0;
  let db = null;
  try {
    db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
    const columns = new Set(
      utils
        .querySqlite(db, 'PRAGMA table_info(threads)')
        .map((row) => String(row?.name || ''))
        .filter(Boolean),
    );
    if (!columns.has('data') || !columns.has('id')) return { sessions, threads: 0, bytes };
    const optional = (name) => (columns.has(name) ? `"${name}"` : `NULL AS "${name}"`);
    const rows = utils.querySqlite(
      db,
      `SELECT "id" AS id, ${optional('summary')}, ${optional('updated_at')}, ${optional('created_at')},
              ${optional('data_type')}, "data" AS data, ${optional('folder_paths')}
         FROM threads`,
    );
    for (const row of rows) {
      if (ctx.signal?.aborted) break;
      threads += 1;
      const text = decodeThreadData(utils, row?.data_type, row?.data);
      if (text === null || text.trim() === '') continue;
      const thread = safeJsonParse(text);
      if (!thread || typeof thread !== 'object') continue;
      const rawLength = Buffer.isBuffer(row?.data) ? row.data.length : row?.data instanceof Uint8Array ? row.data.length : text.length;
      const session = buildSession(thread, /** @type {Record<string, any>} */ (row), dbPath, rawLength);
      if (session !== null && session.nativeId !== '') sessions.push(session);
    }
  } catch (error) {
    ctx.warn(`Zed: cannot read ${dbPath}: ${error?.message || error}`);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  cacheSet(ctx, dbPath, fingerprint, sessions);
  return { sessions, threads, bytes };
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

  for (const dbPath of databaseCandidates(env)) {
    const stat = await utils.statSafe(dbPath);
    if (stat === null || !stat.isFile) {
      sources.push({
        label: 'Zed agent threads',
        path: dbPath,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Zed is not installed (or the agent panel was never used on this machine)',
      });
      continue;
    }
    const result = await scanDatabase(ctx, dbPath);
    sessions.push(...result.sessions);
    sources.push({
      label: 'Zed agent threads',
      path: dbPath,
      exists: true,
      files: result.threads,
      bytes: result.bytes || stat.size,
      note: 'threads.db: one row per agent thread, payload stored as JSON or zstd',
    });
    if (result.threads > 0 && result.sessions.length === 0) {
      ctx.warn('Zed: threads.db found but no thread contains a readable user/assistant conversation');
    }
  }

  return { sources, sessions };
}

/**
 * Read one thread's full transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  const threadId = session?.ref?.threadId || session?.nativeId;
  if (typeof filePath !== 'string' || filePath === '' || typeof threadId !== 'string' || threadId === '') {
    return { messages: [] };
  }
  const { utils } = ctx;
  /** @type {any[]} */
  const messages = [];
  let db = null;
  try {
    db = await utils.openSqliteDatabase(filePath, { readOnly: true });
    const rows = utils.querySqlite(db, 'SELECT data_type, data FROM threads WHERE id = ?', [threadId]);
    if (rows.length === 0) return { messages };
    const text = decodeThreadData(utils, rows[0]?.data_type, rows[0]?.data);
    if (text === null) return { messages };
    const thread = safeJsonParse(text);
    const entries = Array.isArray(thread?.messages) ? thread.messages : [];
    for (const entry of entries) {
      if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
      if (!entry || typeof entry !== 'object') continue;
      const user = entry.User;
      const agent = entry.Agent;
      if (user && typeof user === 'object') {
        for (const block of Array.isArray(user.content) ? user.content : []) {
          const body = blockText(block);
          if (body.trim() === '') continue;
          pushMessage(messages, { role: 'user', ts: 0, text: body.slice(0, MAX_TEXT) });
        }
        continue;
      }
      if (!agent || typeof agent !== 'object') continue;
      for (const block of Array.isArray(agent.content) ? agent.content : []) {
        if (block && typeof block === 'object' && block.ToolUse && typeof block.ToolUse === 'object') {
          const toolUse = block.ToolUse;
          messages.push({
            role: 'tool',
            ts: 0,
            kind: 'tool-call',
            name: typeof toolUse.name === 'string' ? toolUse.name : 'tool',
            text: clip(JSON.stringify(toolUse.input ?? toolUse.raw_input ?? {}), 600),
          });
          continue;
        }
        if (block && typeof block === 'object' && block.Thinking !== undefined) {
          const thinking = blockText(block, 'thinking');
          if (thinking.trim() !== '') {
            pushMessage(messages, { role: 'assistant', ts: 0, text: thinking.slice(0, MAX_TEXT), kind: 'thinking' });
          }
          continue;
        }
        const body = blockText(block);
        if (body.trim() === '') continue;
        pushMessage(messages, { role: 'assistant', ts: 0, text: body.slice(0, MAX_TEXT) });
      }
      const toolResults = agent.tool_results && typeof agent.tool_results === 'object' ? agent.tool_results : null;
      if (toolResults) {
        for (const result of Object.values(toolResults)) {
          const body = toolResultText(result);
          if (body.trim() === '') continue;
          const name =
            result && typeof result === 'object' && typeof /** @type {any} */ (result).tool_name === 'string'
              ? /** @type {any} */ (result).tool_name
              : undefined;
          messages.push({ role: 'tool', ts: 0, kind: 'tool-result', name, text: body.slice(0, MAX_TEXT) });
        }
      }
    }
  } catch {
    return { messages: [] };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return { messages };
}

/** @param {any[]} messages @param {any} message */
function pushMessage(messages, message) {
  if (messages.length >= MAX_TRANSCRIPT_MESSAGES) return;
  messages.push(message);
}
