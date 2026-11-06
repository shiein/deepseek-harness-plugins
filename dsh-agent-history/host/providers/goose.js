/**
 * Goose history provider (Block's Goose CLI).
 *
 * Current Goose keeps sessions in a SQLite database:
 *   $GOOSE_PATH_ROOT/data/sessions/sessions.db
 *   ~/.local/share/goose/sessions/sessions.db          (macOS/Linux, XDG_DATA_HOME honored)
 *   %APPDATA%\Block\goose\sessions\sessions.db         (Windows)
 * The `sessions` table has id, working_dir, name/description, created_at, updated_at and (in
 * newer schemas) a `messages` table with (role, content_json, created_timestamp) per turn.
 * Older releases stored the whole conversation in the session's JSON `conversation` column, and
 * pre-SQLite releases wrote one JSONL transcript per session next to the database.
 *
 * Content blocks are `[{ type: 'text', text }]` plus thinking/tool blocks; the parser accepts the
 * string and array shapes and ignores unknown block types. Sessions without readable
 * user/assistant text are skipped.
 *
 * Resume: no verified cross-version resume command, so resume.kind is 'none'.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'goose',
  name: 'Goose',
  color: '#10b981',
  homepage: 'https://block.github.io/goose/',
  cacheVersion: 2,
  resume: { kind: 'none' },
};

const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;
const MAX_MESSAGE_ROWS = 200000;

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

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function databaseCandidates(env) {
  const override = (process.env.GOOSE_PATH_ROOT || '').trim();
  if (override !== '') {
    return [join(override.replace(/^~(?=$|[\\/])/, env.home), 'data', 'sessions', 'sessions.db')];
  }
  const paths = [];
  if (env.platform === 'win32') {
    if (env.appData) paths.push(join(env.appData, 'Block', 'goose', 'sessions', 'sessions.db'));
    if (env.localAppData) paths.push(join(env.localAppData, 'Block', 'goose', 'sessions', 'sessions.db'));
  }
  paths.push(join(env.xdgData, 'goose', 'sessions', 'sessions.db'));
  return [...new Set(paths)];
}

/** @param {unknown} value @returns {number} epoch ms, 0 when unparseable */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) return toEpochMs(Number(text));
    let parsed = Date.parse(text);
    if (Number.isNaN(parsed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) parsed = Date.parse(`${text.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** @param {unknown} raw @returns {any|null} */
function parseJsonValue(raw) {
  if (raw === null || raw === undefined) return null;
  let text;
  if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf8');
  else if (typeof raw === 'string') text = raw;
  else return raw && typeof raw === 'object' ? raw : null;
  if (text.trim() === '') return null;
  return safeJsonParse(text);
}

/** @param {any} value @returns {string} */
function stringOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Turn a Goose content value (`[{type:'text',text}]`, a string, or a legacy wrapper) into
 * transcript entries.
 * @param {'user'|'assistant'} role
 * @param {unknown} content
 * @param {number} ts
 * @returns {any[]}
 */
function contentToEntries(role, content, ts) {
  /** @type {any[]} */
  const entries = [];
  if (typeof content === 'string') {
    if (content.trim() !== '') entries.push({ role, ts, text: content });
    return entries;
  }
  const blocks = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? Array.isArray(/** @type {Record<string, any>} */ (content).content)
        ? /** @type {Record<string, any>} */ (content).content
        : [content]
      : [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block.trim() !== '') entries.push({ role, ts, text: block });
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (block);
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'text' || typeof record.text === 'string') {
      if (typeof record.text === 'string' && record.text.trim() !== '') entries.push({ role, ts, text: record.text });
      continue;
    }
    if (type === 'thinking' || type === 'reasoning') {
      const thinking = typeof record.thinking === 'string' ? record.thinking : typeof record.text === 'string' ? record.text : '';
      if (thinking.trim() !== '') entries.push({ role: 'assistant', ts, text: thinking, kind: 'thinking' });
      continue;
    }
    if (/toolrequest|tooluse|tool_call|toolcall/i.test(type)) {
      const call = record.toolCall && typeof record.toolCall === 'object' ? record.toolCall : record;
      const name = typeof call.toolName === 'string' ? call.toolName : typeof call.name === 'string' ? call.name : 'tool';
      const args = call.arguments ?? call.input ?? call.params ?? {};
      entries.push({ role: 'tool', ts, kind: 'tool-call', name, text: clip(typeof args === 'string' ? args : stringOf(args), 600) });
      continue;
    }
    if (/toolresponse|toolresult|tool_result/i.test(type)) {
      const response = record.toolResult && typeof record.toolResult === 'object' ? record.toolResult : record;
      const body = stringOf(response.content ?? response.result ?? response.output ?? response);
      if (body.trim() !== '') entries.push({ role: 'tool', ts, kind: 'tool-result', text: body.slice(0, MAX_TEXT) });
    }
  }
  return entries;
}

/**
 * Summarize one session's transcript entries into a provider row.
 * @param {any[]} entries
 * @param {Record<string, any>} session
 * @param {string} dbPath
 * @param {number} sizeBytes
 * @returns {any|null}
 */
function buildSession(entries, session, dbPath, sizeBytes) {
  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  let firstTs = 0;
  let lastTs = 0;
  for (const entry of entries) {
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    if (entry.kind) continue;
    if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
    if (entry.ts > 0) {
      if (firstTs === 0 || entry.ts < firstTs) firstTs = entry.ts;
      if (entry.ts > lastTs) lastTs = entry.ts;
    }
    messages += 1;
    if (entry.role === 'user') {
      userMessages += 1;
      if (firstPrompt === '') firstPrompt = entry.text;
    }
    lastPreview = entry.text;
  }
  if (messages === 0) return null;
  const created = toEpochMs(session.created_at);
  const updated = toEpochMs(session.updated_at);
  const title = [session.name, session.description].find((value) => typeof value === 'string' && value.trim() !== '');
  const modelConfig = parseJsonValue(session.model_config_json);
  const model =
    modelConfig && typeof modelConfig === 'object'
      ? [modelConfig.model_name, modelConfig.model, modelConfig.modelName].find((value) => typeof value === 'string' && value.trim() !== '')
      : '';
  const sessionType = typeof session.session_type === 'string' ? session.session_type : '';
  const extraParts = [];
  if (typeof model === 'string') extraParts.push(model);
  if (typeof session.provider_name === 'string' && session.provider_name.trim() !== '') extraParts.push(session.provider_name.trim());
  if (sessionType !== '' && sessionType !== 'user') extraParts.push(sessionType);
  return {
    nativeId: String(session.id),
    title: typeof title === 'string' ? title.trim() : titleFromPrompt(firstPrompt, 90) || '未命名会话',
    projectPath: typeof session.working_dir === 'string' ? session.working_dir : '',
    startedAt: created || firstTs,
    updatedAt: updated || lastTs || created || firstTs,
    messages,
    userMessages,
    sizeBytes,
    preview: cleanPrompt(firstPrompt).slice(0, 220),
    lastPreview: cleanPrompt(lastPreview).slice(0, 220),
    sourcePath: dbPath,
    extra: extraParts.join(' · ') || undefined,
    ref: { file: dbPath, sessionId: String(session.id) },
  };
}

/**
 * Discover which columns a Goose `messages` table actually has (schemas drifted across releases:
 * `content_json`/`content`, `created_timestamp`/`created`, `id` presence).
 * @param {typeof import('../scan-utils.js')} utils
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{usable: boolean, content: string, ts: string, hasId: boolean}}
 */
function messagesSchema(utils, db) {
  const columns = new Set(
    utils.querySqlite(db, "SELECT name FROM pragma_table_info('messages')").map((row) => String(row?.name || '')),
  );
  const content = columns.has('content_json') ? 'content_json' : columns.has('content') ? 'content' : '';
  const ts = columns.has('created_timestamp') ? 'created_timestamp' : columns.has('created') ? 'created' : '';
  return { usable: columns.has('role') && content !== '', content, ts, hasId: columns.has('id') };
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} dbPath
 * @returns {Promise<{sessions: any[], sessionRows: number, bytes: number}>}
 */
async function scanDatabase(ctx, dbPath) {
  const { utils } = ctx;
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${dbPath}${suffix}`);
    if (stat && stat.isFile) parts.push(`${stat.size}:${Math.round(stat.mtimeMs)}`);
    else if (suffix === '') return { sessions: [], sessionRows: 0, bytes: 0 };
    else parts.push('-');
  }
  const fingerprint = `${parts.join('|')}:v2`;
  const cached = cacheGet(ctx, dbPath, fingerprint);
  const dbStat = await utils.statSafe(dbPath);
  const walStat = await utils.statSafe(`${dbPath}-wal`);
  const bytes = (dbStat?.size || 0) + (walStat?.size || 0);
  if (cached) return { sessions: cached, sessionRows: cached.length, bytes };

  /** @type {any[]} */
  const sessions = [];
  let sessionRows = 0;
  let db = null;
  try {
    db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
    const tables = new Set(
      utils.querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row?.name || '')),
    );
    if (!tables.has('sessions')) return { sessions, sessionRows: 0, bytes };
    const columns = new Set(
      utils.querySqlite(db, "SELECT name FROM pragma_table_info('sessions')").map((row) => String(row?.name || '')),
    );
    const optional = (name) => (columns.has(name) ? `"${name}"` : `NULL AS "${name}"`);
    const sessionSelect = [
      '"id" AS id',
      optional('name'),
      optional('description'),
      optional('working_dir'),
      optional('created_at'),
      optional('updated_at'),
      optional('conversation'),
      optional('model_config_json'),
      optional('provider_name'),
      optional('session_type'),
    ].join(', ');
    const rows = utils.querySqlite(db, `SELECT ${sessionSelect} FROM sessions`);
    /** @type {Map<string, any[]>} */
    const messagesBySession = new Map();
    const schema = tables.has('messages') ? messagesSchema(utils, db) : { usable: false, content: '', ts: '', hasId: false };
    if (schema.usable) {
      const order = ['session_id'];
      if (schema.ts !== '') order.push(schema.ts);
      if (schema.hasId) order.push('id');
      const messageRows = utils.querySqlite(
        db,
        `SELECT session_id, role, "${schema.content}" AS content_json, ${schema.ts !== '' ? `"${schema.ts}"` : 'NULL'} AS created_timestamp
           FROM messages ORDER BY ${order.join(', ')} LIMIT ${MAX_MESSAGE_ROWS}`,
      );
      if (messageRows.length >= MAX_MESSAGE_ROWS) {
        ctx.warn(`Goose: ${dbPath} has more than ${MAX_MESSAGE_ROWS} message rows; only the first ${MAX_MESSAGE_ROWS} were read`);
      }
      for (const row of messageRows) {
        if (ctx.signal?.aborted) break;
        const sessionId = String(row?.session_id || '');
        if (sessionId === '') continue;
        const role = row?.role === 'user' ? 'user' : row?.role === 'assistant' ? 'assistant' : '';
        if (role === '') continue;
        const ts = toEpochMs(row?.created_timestamp);
        const entries = contentToEntries(role, parseJsonValue(row?.content_json), ts);
        if (entries.length === 0) continue;
        let list = messagesBySession.get(sessionId);
        if (!list) {
          list = [];
          messagesBySession.set(sessionId, list);
        }
        list.push(...entries);
      }
    }
    for (const session of rows) {
      if (ctx.signal?.aborted) break;
      sessionRows += 1;
      const id = String(session?.id || '');
      if (id === '') continue;
      /** @type {any[]} */
      let entries = messagesBySession.get(id) || [];
      let sizeBytes = 0;
      if (entries.length === 0) {
        // Legacy schema: the whole Conversation JSON lives on the session row.
        const conversation = parseJsonValue(session?.conversation);
        const conversationMessages = Array.isArray(conversation)
          ? conversation
          : conversation && Array.isArray(conversation.messages)
            ? conversation.messages
            : null;
        if (conversationMessages) {
          for (const message of conversationMessages) {
            if (!message || typeof message !== 'object') continue;
            const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : '';
            if (role === '') continue;
            const ts = toEpochMs(message.created ?? message.timestamp ?? message.ts);
            const messageEntries = contentToEntries(role, message.content, ts);
            entries.push(...messageEntries);
          }
        }
      }
      for (const entry of entries) {
        if (typeof entry.text === 'string') sizeBytes += Buffer.byteLength(entry.text);
      }
      const row = buildSession(entries, /** @type {Record<string, any>} */ (session), dbPath, sizeBytes);
      if (row !== null) sessions.push(row);
    }
  } catch (error) {
    ctx.warn(`Goose: cannot read ${dbPath}: ${error?.message || error}`);
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
  return { sessions, sessionRows, bytes };
}

/**
 * Pre-SQLite Goose wrote one JSONL transcript per session into the sessions/ folder.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} sessionsDir
 * @returns {Promise<{sessions: any[], files: number, bytes: number}>}
 */
async function scanLegacyJsonl(ctx, sessionsDir) {
  const { utils } = ctx;
  const files = await utils.listFilesRecursive(sessionsDir, {
    exts: ['.jsonl'],
    maxDepth: 2,
    maxFiles: 5000,
    signal: ctx.signal,
  });
  /** @type {any[]} */
  const sessions = [];
  let bytes = 0;
  for (const file of files) {
    if (ctx.signal?.aborted) break;
    bytes += file.size;
    const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}:v2`;
    let rows = cacheGet(ctx, file.path, fingerprint);
    if (!rows) {
      /** @type {any[]} */
      const entries = [];
      try {
        await readJsonl(
          file.path,
          (line) => {
            const record = safeJsonParse(line);
            if (!record || typeof record !== 'object') return;
            const messages = Array.isArray(record.messages) ? record.messages : [record];
            for (const message of messages) {
              if (!message || typeof message !== 'object') continue;
              const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : '';
              if (role === '') continue;
              const ts = toEpochMs(message.created ?? message.timestamp ?? message.ts);
              entries.push(...contentToEntries(role, message.content, ts));
            }
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        ctx.warn(`Goose: cannot read ${file.path}: ${error?.message || error}`);
      }
      const row = buildSession(
        entries,
        { id: utils.basenameOf(file.path).replace(/\.jsonl$/i, ''), created_at: file.mtimeMs, updated_at: file.mtimeMs },
        file.path,
        file.size,
      );
      rows = row ? [row] : [];
      cacheSet(ctx, file.path, fingerprint, rows);
    }
    sessions.push(...rows);
  }
  return { sessions, files: files.length, bytes };
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
  const candidates = databaseCandidates(env);
  let foundDb = false;

  for (const dbPath of candidates) {
    const stat = await utils.statSafe(dbPath);
    if (stat === null || !stat.isFile) continue;
    foundDb = true;
    const result = await scanDatabase(ctx, dbPath);
    sessions.push(...result.sessions);
    sources.push({
      label: 'Goose sessions database',
      path: dbPath,
      exists: true,
      files: result.sessionRows,
      bytes: result.bytes,
      note: 'sessions.db: messages table (or legacy conversation JSON) with working_dir and timestamps',
    });
    if (result.sessionRows > 0 && result.sessions.length === 0) {
      ctx.warn('Goose: sessions database found but no session contains a readable user/assistant conversation');
    }
  }

  if (!foundDb) {
    const override = (process.env.GOOSE_PATH_ROOT || '').trim();
    /** @type {string[]} */
    const legacyDirs = [];
    if (override !== '') {
      legacyDirs.push(join(override.replace(/^~(?=$|[\\/])/, env.home), 'data', 'sessions'));
    } else {
      legacyDirs.push(join(env.xdgData, 'goose', 'sessions'));
      if (env.platform === 'win32' && env.appData) legacyDirs.push(join(env.appData, 'Block', 'goose', 'sessions'));
    }
    for (const legacyDir of [...new Set(legacyDirs)]) {
      const legacyStat = await utils.statSafe(legacyDir);
      if (legacyStat === null || !legacyStat.isDirectory) continue;
      const result = await scanLegacyJsonl(ctx, legacyDir);
      sessions.push(...result.sessions);
      sources.push({
        label: 'Goose legacy JSONL sessions',
        path: legacyDir,
        exists: true,
        files: result.files,
        bytes: result.bytes,
        note: 'pre-SQLite one-JSONL-per-session transcripts',
      });
    }
    if (sources.length === 0) {
      sources.push({
        label: 'Goose sessions database',
        path: candidates[0],
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Goose is not installed here (or GOOSE_PATH_ROOT points elsewhere)',
      });
    }
  }

  return { sources, sessions };
}

/**
 * Read one Goose session transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  const sessionId = session?.ref?.sessionId || session?.nativeId;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  /** @type {any[]} */
  const entries = [];
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    const raw = await readText(filePath);
    if (raw === null) return { messages: [] };
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const record = safeJsonParse(line);
      if (!record || typeof record !== 'object') continue;
      const messages = Array.isArray(record.messages) ? record.messages : [record];
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : '';
        if (role === '') continue;
        entries.push(...contentToEntries(role, message.content, toEpochMs(message.created ?? message.timestamp ?? message.ts)));
      }
    }
  } else {
    const { utils } = ctx;
    let db = null;
    try {
      db = await utils.openSqliteDatabase(filePath, { readOnly: true });
      const tables = new Set(
        utils.querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row?.name || '')),
      );
      if (tables.has('messages')) {
        const schema = messagesSchema(utils, db);
        if (schema.usable) {
          const order = [];
          if (schema.ts !== '') order.push(schema.ts);
          if (schema.hasId) order.push('id');
          const rows = utils.querySqlite(
            db,
            `SELECT role, "${schema.content}" AS content_json, ${schema.ts !== '' ? `"${schema.ts}"` : 'NULL'} AS created_timestamp
               FROM messages WHERE session_id = ?${order.length > 0 ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT 100000`,
            [sessionId],
          );
          for (const row of rows) {
            if (entries.length >= MAX_TRANSCRIPT_MESSAGES) break;
            const role = row?.role === 'user' ? 'user' : row?.role === 'assistant' ? 'assistant' : '';
            if (role === '') continue;
            entries.push(...contentToEntries(role, parseJsonValue(row?.content_json), toEpochMs(row?.created_timestamp)));
          }
        }
      }
      if (entries.length === 0) {
        const rows = utils.querySqlite(db, 'SELECT conversation FROM sessions WHERE id = ?', [sessionId]);
        const conversation = rows.length > 0 ? parseJsonValue(rows[0]?.conversation) : null;
        const messages = Array.isArray(conversation) ? conversation : conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
        for (const message of messages) {
          if (!message || typeof message !== 'object') continue;
          const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : '';
          if (role === '') continue;
          entries.push(...contentToEntries(role, message.content, toEpochMs(message.created ?? message.timestamp ?? message.ts)));
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
  }
  /** @type {any[]} */
  const messages = [];
  for (const entry of entries) {
    if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
    if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
    messages.push({
      role: entry.role,
      ts: entry.ts || 0,
      text: entry.text.slice(0, MAX_TEXT),
      kind: entry.kind,
      name: entry.name,
    });
  }
  return { messages };
}
