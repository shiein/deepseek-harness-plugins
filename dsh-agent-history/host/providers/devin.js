/**
 * Devin CLI history provider.
 *
 * Devin CLI persists its own session store under the XDG data directory:
 *
 *   macOS / Linux: ~/.local/share/devin/cli/sessions.db   (+ -wal, often several GB)
 *   Windows:       %LOCALAPPDATA%\devin\cli\sessions.db
 *                  %USERPROFILE%\.local\share\devin\cli\sessions.db
 *
 * Schema (verified on this machine):
 *
 *   sessions(id TEXT PK, working_directory, backend_type, model, agent_mode,
 *            created_at INTEGER, last_activity_at INTEGER, title, main_chain_id,
 *            hidden, metadata, …)
 *   message_nodes(row_id INTEGER PK, session_id, node_id, parent_node_id,
 *                 chat_message TEXT, created_at INTEGER, metadata,
 *                 UNIQUE(session_id, node_id))
 *   prompt_history(id, content, timestamp, session_id, is_shell)   // small
 *
 * `message_nodes.chat_message` is an ACP JSON message
 * `{ message_id, role: 'system'|'user'|'assistant'|'tool', content, metadata }`. One logical
 * message can be stored on more than one row (compaction/fork chains re-insert history), so a
 * session's forest contains several chains; `sessions.main_chain_id` is the head of the active
 * chain and `readMessages` walks `parent_node_id` back from it, which yields the real linear
 * conversation instead of duplicated system preambles.
 *
 * The database is multi-GB, so `scan` only uses index-only aggregates:
 *   - `SELECT session_id, COUNT(*) FROM message_nodes GROUP BY session_id` (covering index)
 *   - `SELECT session_id, COUNT(*) FROM prompt_history GROUP BY session_id`
 * plus one bounded first-user-message lookup per session for the preview. No full table scan.
 * The whole scan result is cached under the database path with a `db + -wal + -shm` fingerprint
 * (the WAL can hold GBs of uncheckpointed data while the main file's mtime stays put).
 *
 * Resume: `devin --resume <session-id>` in the session's working directory.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';

export const meta = {
  id: 'devin',
  name: 'Devin',
  color: '#7c6bf5',
  homepage: 'https://devin.ai',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'devin', args: ['--resume', '{id}'] },
};

const MAX_MESSAGES = 4000;
const MAX_CHAIN_NODES = 4000;
const MAX_MESSAGE_CHARS = 120000;

/** @param {unknown} value @returns {number} */
function toTs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    if (value > 1e12) return Math.round(value);
    if (value > 1e9) return Math.round(value * 1000);
    return 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 946684800000 ? parsed : 0;
  }
  return 0;
}

/**
 * Candidate CLI data roots, most specific first.
 * @param {import('../types.js').ScanContext} ctx
 * @returns {string[]}
 */
function cliDataRoots(ctx) {
  const { utils, env } = ctx;
  /** @type {string[]} */
  const roots = [];
  const configured = utils.expandPath(process.env.DEVIN_DATA_DIR || '');
  if (configured) roots.push(configured);
  if (typeof env.config?.devinDataDir === 'string' && env.config.devinDataDir.trim() !== '') {
    roots.push(utils.expandPath(env.config.devinDataDir));
  }
  if (env.platform === 'win32') {
    if (env.localAppData) roots.push(utils.joinPath(env.localAppData, 'devin'));
    roots.push(utils.joinPath(env.home, '.local', 'share', 'devin'));
  } else if (env.platform === 'darwin') {
    roots.push(utils.joinPath(env.home, '.local', 'share', 'devin'));
  } else {
    roots.push(utils.joinPath(env.xdgData, 'devin'));
  }
  return [...new Set(roots)];
}

/**
 * Fingerprint the SQLite database together with its write-ahead log. `-shm` only contributes its
 * size: opening a WAL database read-only bumps that file's mtime on this platform, which would
 * defeat the cache on every scan.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} path
 * @returns {Promise<string>}
 */
async function sqliteFingerprint(utils, path) {
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${path}${suffix}`);
    if (stat && stat.isFile) parts.push(suffix === '-shm' ? `${stat.size}` : `${stat.size}:${Math.round(stat.mtimeMs)}`);
    else if (suffix === '') return '';
    else parts.push('-');
  }
  return parts.join('|');
}

/**
 * Read one `sessions.db` into session summaries. Every query is bounded or index-only.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} databasePath
 * @param {AbortSignal} signal
 * @returns {Promise<any[]>}
 */
async function readSessionSummaries(utils, databasePath, signal) {
  /** @type {any[]} */
  const sessions = [];
  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  try {
    db = await utils.openSqliteDatabase(databasePath, { readOnly: true });

    const rows = utils.querySqlite(
      db,
      `SELECT id, working_directory, title, created_at, last_activity_at, model, agent_mode, main_chain_id
         FROM sessions WHERE hidden = 0 ORDER BY last_activity_at DESC`,
    );
    if (rows.length === 0) return sessions;

    /** @type {Map<string, number>} */
    const nodeCounts = new Map();
    for (const row of utils.querySqlite(db, 'SELECT session_id, COUNT(*) AS total FROM message_nodes GROUP BY session_id')) {
      const id = typeof row.session_id === 'string' ? row.session_id : '';
      if (id !== '') nodeCounts.set(id, Number(row.total) || 0);
    }
    /** @type {Map<string, number>} */
    const promptCounts = new Map();
    for (const row of utils.querySqlite(db, 'SELECT session_id, COUNT(*) AS total FROM prompt_history GROUP BY session_id')) {
      const id = typeof row.session_id === 'string' ? row.session_id : '';
      if (id !== '') promptCounts.set(id, Number(row.total) || 0);
    }

    for (const row of rows) {
      if (signal?.aborted) break;
      const id = typeof row.id === 'string' ? row.id : '';
      if (id === '' || !nodeCounts.has(id)) continue;
      const firstPrompt = firstUserPrompt(db, id);
      const lastAssistant = lastAssistantText(db, id);
      const rawTitle = typeof row.title === 'string' ? row.title.trim() : '';
      const title =
        rawTitle !== '' && rawTitle.toLowerCase() !== 'untitled' ? rawTitle : titleFromPrompt(firstPrompt, 90);
      const startedAt = toTs(row.created_at);
      const updatedAt = toTs(row.last_activity_at) || startedAt;
      const extra = [row.model, row.agent_mode].filter((value) => typeof value === 'string' && value !== '').join(' · ');
      sessions.push({
        nativeId: id,
        title: title || '未命名会话',
        projectPath: typeof row.working_directory === 'string' ? row.working_directory : '',
        startedAt,
        updatedAt,
        messages: nodeCounts.get(id) || 0,
        userMessages: promptCounts.get(id) || 0,
        sizeBytes: 0,
        preview: cleanPrompt(firstPrompt).slice(0, 220) || rawTitle.slice(0, 220),
        lastPreview: cleanPrompt(lastAssistant).slice(0, 220),
        sourcePath: databasePath,
        extra: extra || undefined,
        ref: { db: databasePath, id, head: Number(row.main_chain_id) || 0 },
      });
    }
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // A close failure must not discard the rows we already read.
      }
    }
  }
  return sessions;
}

/**
 * Agent-injected context is stored with role "user" in some sessions (DSH/MCP tool notices,
 * `<system_info>`, `<rules>`, skill catalogs). It must never become the first-prompt preview.
 * @param {string} value
 * @returns {boolean}
 */
function looksInjected(value) {
  const text = value.trim();
  if (text === '') return true;
  if (text.startsWith('<')) return true;
  const head = text.slice(0, 600);
  return /Current DSH tools connection|MCP server dsh|The following skills are available|system_reminder|Current workspace directories/i.test(head);
}

/**
 * First real user prompt of a session. Injected system context stored as role "user" is skipped;
 * if a session only contains injected context (its prompt was delivered over ACP and not
 * persisted) the empty string is returned and the caller falls back to the generated title.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {string}
 */
function firstUserPrompt(db, sessionId) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT substr(json_extract(chat_message, '$.content'), 1, 4000) AS content
           FROM message_nodes
          WHERE session_id = ? AND json_extract(chat_message, '$.role') = 'user'
          ORDER BY node_id LIMIT 8`,
      )
      .all(sessionId);
  } catch {
    return '';
  }
  let fallback = '';
  for (const row of rows) {
    const content = row && typeof row.content === 'string' ? row.content : '';
    if (fallback === '' && content.trim() !== '') fallback = content;
    if (!looksInjected(content)) return content;
  }
  return fallback !== '' && !looksInjected(fallback) ? fallback : '';
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} sessionId @returns {string} */
function lastAssistantText(db, sessionId) {
  return utilsQueryFirst(
    db,
    `SELECT substr(json_extract(chat_message, '$.content'), 1, 2000) AS content
       FROM message_nodes
      WHERE session_id = ? AND json_extract(chat_message, '$.role') = 'assistant'
      ORDER BY node_id DESC LIMIT 1`,
    [sessionId],
  );
}

/**
 * Single-column string query used per session (bounded by the (session_id, node_id) index).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {string}
 */
function utilsQueryFirst(db, sql, params) {
  try {
    const row = db.prepare(sql).get(...params);
    return row && typeof row.content === 'string' ? row.content : '';
  } catch {
    return '';
  }
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];
  const seen = new Set();

  for (const root of cliDataRoots(ctx)) {
    const databasePath = join(root, 'cli', 'sessions.db');
    if (seen.has(databasePath)) continue;
    seen.add(databasePath);
    const databaseStat = await utils.statSafe(databasePath);
    if (databaseStat === null || !databaseStat.isFile) continue;

    const fingerprint = await sqliteFingerprint(utils, databasePath);
    let rows = cache.get(databasePath, fingerprint);
    if (!rows) {
      let readable = true;
      try {
        rows = await readSessionSummaries(utils, databasePath, ctx.signal);
      } catch (error) {
        readable = false;
        ctx.warn(`Devin CLI: cannot read ${databasePath}: ${error?.message || error}`);
        rows = [];
      }
      // Only a successful read is cached: a transient lock must be retried on the next scan.
      if (readable) cache.set(databasePath, fingerprint, rows);
    }
    sessions.push(...rows);

    let bytes = databaseStat.size;
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = await utils.statSafe(`${databasePath}${suffix}`);
      if (sidecar) bytes += sidecar.size;
    }
    sources.push({
      label: 'Devin CLI sessions',
      path: databasePath,
      exists: true,
      files: rows.length,
      bytes,
      note: 'SQLite sessions.db; transcript walked from sessions.main_chain_id',
    });
  }

  if (sources.length === 0) {
    sources.push({
      label: 'Devin CLI sessions',
      path: join(cliDataRoots(ctx)[0] || '~/.local/share/devin', 'cli', 'sessions.db'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Devin CLI is not installed for this user (or the sessions database moved)',
    });
  }

  return { sources, sessions };
}

/** @param {unknown} content @returns {string} */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Read the linear transcript of one session by walking the message-node parent chain back from
 * `sessions.main_chain_id`. The recursive CTE touches only the chain's rows (indexed by
 * session_id + node_id) and stops after MAX_CHAIN_NODES nodes, so it stays bounded on the 4 GB
 * database even for huge sessions.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 */
export async function readMessages(ctx, session) {
  const databasePath = session.ref?.db || session.sourcePath;
  const sessionId = session.ref?.id || session.nativeId;
  if (typeof databasePath !== 'string' || databasePath === '' || typeof sessionId !== 'string' || sessionId === '') {
    return { messages: [] };
  }
  /** @type {any[]} */
  const messages = [];
  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  try {
    db = await ctx.utils.openSqliteDatabase(databasePath, { readOnly: true });
    let head = Number(session.ref?.head) || 0;
    if (!head) {
      const row = ctx.utils.querySqlite(db, 'SELECT MAX(node_id) AS head FROM message_nodes WHERE session_id = ?', [sessionId])[0];
      head = Number(row?.head) || 0;
    }
    if (!head) return { messages };

    const sql = `
      WITH RECURSIVE chain(node_id, parent_node_id, chat_message, created_at, depth) AS (
        SELECT node_id, parent_node_id, chat_message, created_at, 0
          FROM message_nodes WHERE session_id = ? AND node_id = ?
        UNION ALL
        SELECT m.node_id, m.parent_node_id, m.chat_message, m.created_at, chain.depth + 1
          FROM message_nodes m
          JOIN chain ON m.session_id = ? AND m.node_id = chain.parent_node_id
         WHERE chain.depth < ${MAX_CHAIN_NODES}
      )
      SELECT node_id, parent_node_id, substr(chat_message, 1, ${MAX_MESSAGE_CHARS}) AS cm, created_at
        FROM chain ORDER BY node_id ASC
    `;
    const rows = ctx.utils.querySqlite(db, sql, [sessionId, head, sessionId]);

    for (const row of rows) {
      if (messages.length >= MAX_MESSAGES) break;
      if (ctx.signal?.aborted) break;
      const record = safeParse(row?.cm);
      if (!record || typeof record !== 'object') continue;
      const role = record.role;
      const text = messageText(record.content);
      const ts =
        toTs(record?.metadata?.created_at) || toTs(row?.created_at);
      if (role === 'user') {
        if (text.trim() === '' || looksInjected(text)) continue;
        messages.push({ role: 'user', ts, text });
      } else if (role === 'assistant') {
        if (text.trim() === '') continue;
        messages.push({
          role: 'assistant',
          ts,
          text,
          name: typeof record?.metadata?.generation_model === 'string' ? record.metadata.generation_model : undefined,
        });
      } else if (role === 'tool') {
        if (text.trim() === '') continue;
        messages.push({ role: 'tool', ts, kind: 'tool-result', text: clip(text, 700) });
      }
      // role 'system' is agent-injected context: not part of the readable conversation.
    }
  } catch (error) {
    ctx.warn(`Devin CLI: cannot read transcript ${sessionId}: ${error?.message || error}`);
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

/** @param {unknown} value @returns {any|null} */
function safeParse(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
