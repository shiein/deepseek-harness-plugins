/**
 * OpenCode history provider.
 *
 * OpenCode persists its sessions in SQLite under the XDG data dir
 * (`~/.local/share/opencode/opencode.db`, and newer builds
 * `~/.local/share/opencode/opencode-next.db`). Two schema generations exist on disk:
 *
 *  - legacy: `session` + `message` + `part` rows (message/part carry `data` JSON blobs);
 *  - current: `session_v2` (next: `session`) + `session_message` rows whose `data` is the v2
 *    event/step JSON (`user` / `assistant` / `system` ...).
 *
 * Transcript reads prefer `session_message` and fall back to `message`+`part`. All reads are
 * read-only and opened through the shared helper (WAL-aware, retries SQLITE_BUSY).
 *
 * Resume: `opencode --session <ses_...>` in the session's recorded directory.
 */

import { basename, join } from 'node:path';
import { cleanPrompt, titleFromPrompt } from '../model.js';
import { safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'opencode',
  name: 'OpenCode',
  color: '#ff5c00',
  homepage: 'https://opencode.ai',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'opencode', args: ['--session', '{id}'] },
};

const MAX_MESSAGES = 4000;
const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 900;
const MAX_SESSION_ROWS = 50000;
const MAX_TRANSCRIPT_ROWS = 200000;

/**
 * @param {import('../types.js').ScanContext} ctx
 * @returns {Promise<{sources: import('../types.js').SourceInfo[], sessions: any[]}>}
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  const sources = [];
  /** @type {Map<string, any>} */
  const byNativeId = new Map();
  const directories = candidateDirectories(env);

  for (const directory of directories) {
    const probe = await utils.statSafe(directory);
    if (probe === null || !probe.isDirectory) {
      sources.push({ label: 'OpenCode sessions', path: directory, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const entries = await utils.readdirSafe(directory);
    const databases = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(db|sqlite|sqlite3)$/i.test(entry.name)) continue;
      const filePath = join(directory, entry.name);
      const stat = await utils.statSafe(filePath);
      if (stat === null || !stat.isFile) continue;
      const wal = await utils.statSafe(`${filePath}-wal`);
      const shm = await utils.statSafe(`${filePath}-shm`);
      databases.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, wal, shm });
    }
    // Newest store first: when the same session id is present in two databases the most recently
    // written one is the better transcript source.
    databases.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const database of databases) {
      if (ctx.signal?.aborted) break;
      const fingerprint = [
        `${database.size}:${Math.round(database.mtimeMs)}`,
        database.wal ? `${database.wal.size}:${Math.round(database.wal.mtimeMs)}` : '-',
        database.shm ? `${database.shm.size}:${Math.round(database.shm.mtimeMs)}` : '-',
      ].join('|');
      let rows = cacheGet(ctx, database.path, fingerprint);
      if (!rows) {
        try {
          rows = await parseDatabase(ctx, database.path);
        } catch (error) {
          ctx.warn(`OpenCode: cannot read ${database.path}: ${error?.message || error}`);
          continue;
        }
        cacheSet(ctx, database.path, fingerprint, rows);
      }
      for (const row of rows) {
        const existing = byNativeId.get(row.nativeId);
        if (!existing || row.messages > existing.messages || (row.messages === existing.messages && row.updatedAt > existing.updatedAt)) {
          byNativeId.set(row.nativeId, row);
        }
      }
      sources.push({
        label: 'OpenCode sessions',
        path: database.path,
        exists: true,
        files: rows.length,
        bytes: database.size + (database.wal?.size || 0),
        note: 'SQLite session store',
      });
    }
  }

  return { sources, sessions: [...byNativeId.values()] };
}

/**
 * Read one OpenCode session transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const dbPath = session?.ref?.db || session?.sourcePath;
  const sessionId = session?.ref?.id || session?.nativeId;
  if (typeof dbPath !== 'string' || dbPath === '' || typeof sessionId !== 'string' || sessionId === '') {
    return { messages: [] };
  }
  let db;
  try {
    db = await ctx.utils.openSqliteDatabase(dbPath);
  } catch {
    return { messages: [] };
  }
  /** @type {any[]} */
  const messages = [];
  try {
    const tables = tableNames(db, ctx.utils);
    if (tables.has('session_message')) {
      collectSessionMessages(db, ctx.utils, sessionId, messages);
    }
    if (messages.length === 0 && tables.has('message') && tables.has('part')) {
      collectLegacyMessages(db, ctx.utils, sessionId, messages);
    }
  } catch {
    // A locked/corrupt database must render what was decoded so far, never throw.
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  return { messages };
}

/**
 * Candidate OpenCode data directories for this platform.
 * @param {{home: string, xdgData: string, localAppData: string}} env
 * @returns {string[]}
 */
function candidateDirectories(env) {
  /** @type {string[]} */
  const candidates = [];
  if (env.xdgData) candidates.push(join(env.xdgData, 'opencode'));
  if (env.localAppData) candidates.push(join(env.localAppData, 'opencode'));
  candidates.push(join(env.home, '.local', 'share', 'opencode'));
  if (env.platform === 'win32') candidates.push(join(env.home, 'AppData', 'Local', 'opencode'));
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value !== ''))];
}

/**
 * Parse all session summaries out of one SQLite store.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} dbPath
 * @returns {Promise<any[]>}
 */
async function parseDatabase(ctx, dbPath) {
  const utils = ctx.utils;
  const db = await utils.openSqliteDatabase(dbPath);
  try {
    const tables = tableNames(db, utils);
    const sessionTable = tables.has('session_v2') ? 'session_v2' : tables.has('session') ? 'session' : '';
    if (sessionTable === '') return [];

    /** @type {Map<string, any>} */
    const sessions = new Map();
    const loadSessions = (table) => {
      const rows = utils.querySqlite(
        db,
        `SELECT id, title, directory, time_created, time_updated, parent_id, model, agent FROM ${table} ORDER BY time_created LIMIT ${MAX_SESSION_ROWS}`,
      );
      for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        if (id === '' || sessions.has(id)) continue;
        sessions.set(id, {
          id,
          title: typeof row.title === 'string' ? row.title : '',
          directory: typeof row.directory === 'string' ? row.directory : '',
          createdAt: Number(row.time_created) || 0,
          updatedAt: Number(row.time_updated) || 0,
          model: typeof row.model === 'string' ? row.model : '',
        });
      }
    };
    loadSessions(sessionTable);
    if (sessionTable !== 'session' && tables.has('session')) loadSessions('session');

    /** @type {Map<string, {userMessages:number, messages:number, firstUserText:string, lastText:string, lastTs:number, sizeBytes:number}>} */
    const stats = new Map();
    const statFor = (id) => {
      let entry = stats.get(id);
      if (!entry) {
        entry = { userMessages: 0, messages: 0, firstUserText: '', lastText: '', lastTs: 0, sizeBytes: 0 };
        stats.set(id, entry);
      }
      return entry;
    };

    if (tables.has('session_message')) {
      const rows = utils.querySqlite(
        db,
        `SELECT session_id, type, time_created, data FROM session_message ORDER BY session_id, seq LIMIT ${MAX_TRANSCRIPT_ROWS}`,
      );
      for (const row of rows) {
        const id = typeof row.session_id === 'string' ? row.session_id : '';
        if (id === '' || !sessions.has(id)) continue;
        const data = safeJsonParse(typeof row.data === 'string' ? row.data : '');
        if (!data || typeof data !== 'object') continue;
        const entry = statFor(id);
        const ts = Number(data.time?.created) || Number(row.time_created) || 0;
        if (row.type === 'user') {
          const body = userText(data);
          if (body.trim() === '') continue;
          entry.userMessages += 1;
          entry.messages += 1;
          entry.sizeBytes += typeof row.data === 'string' ? row.data.length : 0;
          if (entry.firstUserText === '') entry.firstUserText = body;
          if (ts >= entry.lastTs) {
            entry.lastText = body;
            entry.lastTs = ts;
          }
        } else if (row.type === 'assistant' || row.type === 'system') {
          const body = row.type === 'system' ? (typeof data.text === 'string' ? data.text : '') : assistantText(data);
          if (body.trim() === '') continue;
          entry.messages += 1;
          entry.sizeBytes += typeof row.data === 'string' ? row.data.length : 0;
          if (ts >= entry.lastTs) {
            entry.lastText = body;
            entry.lastTs = ts;
          }
        }
      }
    }

    // Legacy sessions without a session_message log: count from message+part rows.
    const missing = [...sessions.keys()].filter((id) => !stats.has(id));
    if (missing.length > 0 && tables.has('message') && tables.has('part')) {
      for (const id of missing) {
        if (ctx.signal?.aborted) break;
        const entry = statFor(id);
        const messageRows = utils.querySqlite(
          db,
          'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created',
          [id],
        );
        if (messageRows.length === 0) continue;
        const partRows = utils.querySqlite(
          db,
          'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created',
          [id],
        );
        const partsByMessage = new Map();
        for (const part of partRows) {
          const key = typeof part.message_id === 'string' ? part.message_id : '';
          if (key === '') continue;
          let list = partsByMessage.get(key);
          if (!list) {
            list = [];
            partsByMessage.set(key, list);
          }
          list.push(part);
        }
        for (const message of messageRows) {
          const data = safeJsonParse(typeof message.data === 'string' ? message.data : '');
          if (!data || typeof data !== 'object') continue;
          const ts = Number(message.time_created) || 0;
          const parts = partsByMessage.get(message.id) || [];
          if (data.role === 'user') {
            const body = partsText(parts, ['text']);
            if (body.trim() === '') continue;
            entry.userMessages += 1;
            entry.messages += 1;
            if (entry.firstUserText === '') entry.firstUserText = body;
            if (ts >= entry.lastTs) {
              entry.lastText = body;
              entry.lastTs = ts;
            }
          } else if (data.role === 'assistant') {
            const body = partsText(parts, ['text']);
            if (body.trim() === '') continue;
            entry.messages += 1;
            if (ts >= entry.lastTs) {
              entry.lastText = body;
              entry.lastTs = ts;
            }
          }
        }
      }
    }

    const result = [];
    for (const session of sessions.values()) {
      const entry = stats.get(session.id);
      if (!entry || entry.messages === 0) continue;
      const model = modelId(session.model);
      result.push({
        nativeId: session.id,
        title: session.title.trim() !== '' ? session.title.trim() : titleFromPrompt(entry.firstUserText, 90) || '未命名会话',
        projectPath: session.directory,
        startedAt: session.createdAt,
        updatedAt: session.updatedAt || entry.lastTs,
        messages: entry.messages,
        userMessages: entry.userMessages,
        sizeBytes: entry.sizeBytes,
        preview: cleanPrompt(entry.firstUserText).slice(0, 220),
        lastPreview: cleanPrompt(entry.lastText).slice(0, 220),
        sourcePath: dbPath,
        extra: model || undefined,
        ref: { db: dbPath, id: session.id },
      });
    }
    return result;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * @param {any} db
 * @param {any} utils
 * @param {string} sessionId
 * @param {any[]} messages
 */
function collectSessionMessages(db, utils, sessionId, messages) {
  const rows = utils.querySqlite(
    db,
    'SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT 6000',
    [sessionId],
  );
  for (const row of rows) {
    if (messages.length >= MAX_MESSAGES) break;
    const data = safeJsonParse(typeof row.data === 'string' ? row.data : '');
    if (!data || typeof data !== 'object') continue;
    const ts = Number(data.time?.created) || Number(row.time_created) || 0;
    if (row.type === 'user') {
      const body = userText(data);
      if (body.trim() !== '') messages.push({ role: 'user', ts, text: truncate(body, MAX_TEXT) });
      continue;
    }
    if (row.type === 'system') {
      const body = typeof data.text === 'string' ? data.text : '';
      if (body.trim() !== '') messages.push({ role: 'system', ts, text: truncate(body, MAX_TEXT) });
      continue;
    }
    if (row.type !== 'assistant') continue;
    const content = Array.isArray(data.content) ? data.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: truncate(block.text, MAX_TEXT) });
      } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: truncate(block.text, MAX_TEXT), kind: 'thinking' });
      } else if (block.type === 'tool') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const state = block.state && typeof block.state === 'object' ? block.state : {};
        messages.push({
          role: 'tool',
          ts,
          kind: 'tool-call',
          name,
          text: truncate(JSON.stringify(state.input ?? data.input ?? {}), MAX_TOOL_TEXT),
        });
        const output = toolStateText(state);
        if (output.trim() !== '') {
          messages.push({ role: 'tool', ts, kind: 'tool-result', name, text: truncate(output, MAX_TOOL_TEXT * 2) });
        }
      }
    }
    if (typeof data.text === 'string' && data.text.trim() !== '' && !content.some((block) => block && block.type === 'text')) {
      messages.push({ role: 'assistant', ts, text: truncate(data.text, MAX_TEXT) });
    }
  }
}

/**
 * Read a legacy `message` + `part` transcript.
 * @param {any} db
 * @param {any} utils
 * @param {string} sessionId
 * @param {any[]} messages
 */
function collectLegacyMessages(db, utils, sessionId, messages) {
  const messageRows = utils.querySqlite(
    db,
    'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created LIMIT 5000',
    [sessionId],
  );
  const partRows = utils.querySqlite(
    db,
    'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created',
    [sessionId],
  );
  const partsByMessage = new Map();
  for (const part of partRows) {
    const key = typeof part.message_id === 'string' ? part.message_id : '';
    if (key === '') continue;
    let list = partsByMessage.get(key);
    if (!list) {
      list = [];
      partsByMessage.set(key, list);
    }
    list.push(part);
  }
  for (const message of messageRows) {
    if (messages.length >= MAX_MESSAGES) break;
    const data = safeJsonParse(typeof message.data === 'string' ? message.data : '');
    if (!data || typeof data !== 'object') continue;
    const ts = Number(message.time_created) || 0;
    const parts = partsByMessage.get(message.id) || [];
    if (data.role === 'user') {
      const body = partsText(parts, ['text']);
      if (body.trim() !== '') messages.push({ role: 'user', ts, text: truncate(body, MAX_TEXT) });
      continue;
    }
    if (data.role !== 'assistant') continue;
    for (const part of parts) {
      if (messages.length >= MAX_MESSAGES) break;
      const partData = safeJsonParse(typeof part.data === 'string' ? part.data : '');
      if (!partData || typeof partData !== 'object') continue;
      if (partData.type === 'text' && typeof partData.text === 'string' && partData.text.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: truncate(partData.text, MAX_TEXT) });
      } else if (partData.type === 'reasoning' && typeof partData.text === 'string' && partData.text.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: truncate(partData.text, MAX_TEXT), kind: 'thinking' });
      } else if (partData.type === 'tool') {
        const name = typeof partData.tool === 'string' ? partData.tool : 'tool';
        const state = partData.state && typeof partData.state === 'object' ? partData.state : {};
        messages.push({ role: 'tool', ts, kind: 'tool-call', name, text: truncate(JSON.stringify(state.input ?? {}), MAX_TOOL_TEXT) });
        const output = toolStateText(state);
        if (output.trim() !== '') messages.push({ role: 'tool', ts, kind: 'tool-result', name, text: truncate(output, MAX_TOOL_TEXT * 2) });
      }
    }
  }
}

/** @param {any} db @param {any} utils @returns {Set<string>} */
function tableNames(db, utils) {
  const rows = utils.querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Plain user text of one session_message row (`data.text`, or a content block array in newer rows).
 * @param {any} data
 */
function userText(data) {
  if (typeof data?.text === 'string') return data.text;
  if (Array.isArray(data?.content)) {
    const parts = [];
    for (const block of data.content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  return '';
}

/** @param {any} data */
function assistantText(data) {
  const parts = [];
  if (typeof data?.text === 'string' && data.text.trim() !== '') parts.push(data.text);
  const content = Array.isArray(data?.content) ? data.content : [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** @param {any} state */
function toolStateText(state) {
  if (!state || typeof state !== 'object') return '';
  const parts = [];
  if (typeof state.output === 'string') parts.push(state.output);
  if (Array.isArray(state.content)) {
    for (const block of state.content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (parts.length === 0 && state.structured !== undefined) {
    const body = JSON.stringify(state.structured);
    if (body && body !== '{}') parts.push(body);
  }
  if (state.status === 'error' && typeof state.error === 'string' && state.error !== '') parts.push(state.error);
  return parts.join('\n');
}

/**
 * Join the text parts of a legacy message's `part` rows.
 * @param {any[]} parts
 * @param {string[]} types
 */
function partsText(parts, types) {
  const wanted = new Set(types);
  const output = [];
  for (const part of parts) {
    const data = safeJsonParse(typeof part.data === 'string' ? part.data : '');
    if (data && typeof data === 'object' && wanted.has(data.type) && typeof data.text === 'string') output.push(data.text);
  }
  return output.join('\n');
}

/** @param {string} raw @returns {string} */
function modelId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const parsed = safeJsonParse(raw);
  if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') return parsed.id;
  return '';
}

/**
 * Cache-face adapter (see CONTRACT.md): support both the documented two-argument cache and the
 * provider-scoped three-argument cache the current Host passes through.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 */
function cacheGet(ctx, filePath, fingerprint) {
  const cache = ctx.cache;
  if (!cache || typeof cache.get !== 'function') return undefined;
  try {
    const rows = cache.get.length >= 3 ? cache.get(ctx.providerId, filePath, fingerprint) : cache.get(filePath, fingerprint);
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 * @param {any[]} rows
 */
function cacheSet(ctx, filePath, fingerprint, rows) {
  const cache = ctx.cache;
  if (!cache || typeof cache.set !== 'function') return;
  try {
    if (cache.set.length >= 4) cache.set(ctx.providerId, filePath, fingerprint, rows);
    else cache.set(filePath, fingerprint, rows);
  } catch {
    // Cache failures never fail a scan.
  }
}

/** @param {unknown} value @param {number} max @returns {string} */
function truncate(value, max) {
  const body = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(1, max - 1))}…`;
}
