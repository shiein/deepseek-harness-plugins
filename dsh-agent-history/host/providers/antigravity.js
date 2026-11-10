/**
 * Google Antigravity history provider.
 *
 * Antigravity (desktop / IDE / `agy` CLI) keeps one SQLite conversation store per conversation:
 *
 *   <root>/conversations/<conversation-id>.db
 *   <root>/conversation_summaries.db          (one metadata row per conversation)
 *   <root>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 *
 * where `<root>` is `~/.gemini/antigravity`, `~/.gemini/antigravity-cli`, `-ide`, `-backup`,
 * `-acp`, or `~/.config/antigravity`. `ANTIGRAVITY_DATA_DIR` (comma separated; data root or a
 * `conversations` directory) overrides/adds roots.
 *
 * `conversation_summaries.db` is the cheap index used for titles/workspace/timestamps:
 *   conversation_summaries(conversation_id, title, preview, step_count, last_modified_time,
 *                          workspace_uris JSON, last_user_input_time, …)
 *
 * The readable transcript is `transcript.jsonl`, one JSON record per step:
 *   { step_index, source: 'USER_EXPLICIT'|'MODEL'|'SYSTEM', type, status, created_at, content?,
 *     thinking?, tool_calls?: [{ name, args }] }
 *   - USER_INPUT            content wraps the prompt in <USER_REQUEST>…</USER_REQUEST>
 *   - PLANNER_RESPONSE      assistant text (content) + thinking + tool_calls
 *   - GENERIC/RUN_COMMAND/VIEW_FILE/CODE_ACTION/… tool results
 * This is the same private format the agent-usage plugin parses from `steps.metadata` /
 * `gen_metadata` Protobuf blobs; the Protobuf field maps below are used only as the fallback for
 * conversations whose brain transcript is missing (older roots), so a session is never invented.
 *
 * Resume: not supported by the local CLI store.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { fileUriToPath as decodeFileUri, readJsonl, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'antigravity',
  name: 'Antigravity',
  color: '#4285f4',
  homepage: 'https://antigravity.google',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

const APP_SUBDIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup', 'antigravity-acp'];
const MAX_CONVERSATIONS = 5000;
const MAX_MESSAGES = 4000;

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
 * Fingerprint a SQLite database and its WAL sidecars. `-shm` contributes only its size: opening a
 * WAL database read-only updates that file's mtime on this platform and would defeat the cache.
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

/** @param {string} value @param {string} tag @returns {string} */
function extractTag(value, tag) {
  const open = value.indexOf(`<${tag}>`);
  if (open < 0) return '';
  const start = open + tag.length + 2;
  const end = value.indexOf(`</${tag}>`, start);
  return (end >= 0 ? value.slice(start, end) : value.slice(start)).trim();
}

/** @param {string} uri @returns {string} */
function fileUriToPath(uri) {
  const path = decodeFileUri(uri);
  if (path !== '') return path;
  // Not a parseable URL (a raw protobuf string): take the text after the scheme.
  const match = /^file:\/\/(.*)$/.exec(uri);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/** @param {unknown} value @returns {string} */
function decodeWorkspaceUris(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return '';
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    const uri = typeof item === 'string' ? item : item && typeof item.uri === 'string' ? item.uri : '';
    if (typeof uri === 'string' && uri.startsWith('file://')) {
      const path = fileUriToPath(uri);
      if (path !== '') return path;
    }
  }
  return '';
}

// ── Minimal protobuf reader (fallback: conversation DBs without a brain transcript) ────────

/** @param {Buffer} buffer @param {number} start @returns {[number, number]} */
function readVarint(buffer, start) {
  let result = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) return [result, offset];
    shift += 7;
    if (shift > 56) return [result, offset];
  }
  return [result, offset];
}

/** @param {Buffer} buffer @returns {Map<number, Array<{wire: number, value: number|Buffer}>>} */
function readFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    let tag;
    [tag, offset] = readVarint(buffer, offset);
    if (!tag) break;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    let value;
    if (wire === 0) {
      [value, offset] = readVarint(buffer, offset);
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buffer, offset);
      if (!Number.isFinite(length) || length < 0 || offset + length > buffer.length) break;
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) break;
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) break;
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else {
      break;
    }
    const list = fields.get(field);
    if (list) list.push({ wire, value });
    else fields.set(field, [{ wire, value }]);
  }
  return fields;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {Buffer|null} */
function bytesField(fields, number) {
  const list = fields.get(number);
  if (!list) return null;
  for (const item of list) if (item.wire === 2) return /** @type {Buffer} */ (item.value);
  return null;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {number} */
function varintField(fields, number) {
  const list = fields.get(number);
  if (!list) return 0;
  for (const item of list) if (item.wire === 0) return Number(item.value) || 0;
  return 0;
}

/**
 * Recursively search a Protobuf blob for the first `file://` file URI.
 * @param {Buffer} buffer
 * @param {number} [depth]
 * @returns {string}
 */
function findFileUri(buffer, depth = 0) {
  if (!Buffer.isBuffer(buffer) || depth > 6) return '';
  const fields = readFields(buffer);
  for (const list of fields.values()) {
    for (const item of list) {
      if (item.wire !== 2 || !Buffer.isBuffer(item.value)) continue;
      const text = item.value.toString('utf8').replace(/\u0000+$/g, '').trim();
      if (text.startsWith('file://')) return text;
      const nested = findFileUri(item.value, depth + 1);
      if (nested !== '') return nested;
    }
  }
  return '';
}

/**
 * `steps.metadata` field 1 is a Timestamp { seconds, nanos }.
 * @param {Buffer|null} metadata
 * @returns {number}
 */
function parseStepTimestamp(metadata) {
  if (!Buffer.isBuffer(metadata) || metadata.length === 0) return 0;
  const outer = readFields(metadata);
  const timestampBytes = bytesField(outer, 1);
  if (!timestampBytes) return 0;
  const timestamp = readFields(timestampBytes);
  const seconds = varintField(timestamp, 1);
  if (seconds <= 0) return 0;
  const nanos = varintField(timestamp, 2);
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

// ── conversation parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse one brain transcript into the fields a session summary needs. Cached by the caller.
 * @param {string} transcriptPath
 * @param {AbortSignal} [signal]
 * @returns {Promise<{messages: number, userMessages: number, startedAt: number, updatedAt: number,
 *                    firstPrompt: string, lastPreview: string}|null>}
 */
async function parseTranscript(transcriptPath, signal) {
  let messages = 0;
  let userMessages = 0;
  let startedAt = 0;
  let updatedAt = 0;
  let firstPrompt = '';
  let lastPreview = '';

  await readJsonl(transcriptPath, (line) => {
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record || typeof record !== 'object') return;
    const ts = toTs(record.created_at);
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    if (record.type === 'USER_INPUT') {
      const raw = typeof record.content === 'string' ? record.content : '';
      const request = extractTag(raw, 'USER_REQUEST') || raw.trim();
      if (request.trim() === '') return;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = request;
      lastPreview = request;
      return;
    }
    if (record.type === 'PLANNER_RESPONSE') {
      const content = typeof record.content === 'string' ? record.content : '';
      if (content.trim() === '') return;
      messages += 1;
      lastPreview = content;
    }
  }, { signal });

  return { messages, userMessages, startedAt, updatedAt, firstPrompt, lastPreview };
}

/**
 * Fallback metadata for a conversation database with no brain transcript: step count, first/last
 * step timestamps (Protobuf) and the recorded workspace URI from `trajectory_metadata_blob`.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} databasePath
 * @returns {Promise<{messages: number, projectPath: string, startedAt: number, updatedAt: number}|null>}
 */
async function readConversationMetadata(utils, databasePath) {
  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  try {
    db = await utils.openSqliteDatabase(databasePath, { readOnly: true });
    const countRow = utils.querySqlite(db, 'SELECT COUNT(*) AS total FROM steps')[0];
    const total = Number(countRow?.total) || 0;
    const firstRow = utils.querySqlite(db, 'SELECT metadata FROM steps ORDER BY idx ASC LIMIT 1')[0];
    const lastRow = utils.querySqlite(db, 'SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1')[0];
    const startedAt = parseStepTimestamp(firstRow?.metadata ? Buffer.from(firstRow.metadata) : null);
    const updatedAt = parseStepTimestamp(lastRow?.metadata ? Buffer.from(lastRow.metadata) : null);
    let projectPath = '';
    const blobRow = utils.querySqlite(db, "SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")[0];
    if (blobRow?.data) {
      const uri = findFileUri(Buffer.from(blobRow.data));
      if (uri !== '') projectPath = fileUriToPath(uri);
    }
    return { messages: total, projectPath, startedAt, updatedAt };
  } catch {
    return null;
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

/**
 * Build the cached base row for one conversation.
 * @param {import('../types.js').ScanContext} ctx
 * @param {{id: string, databasePath: string, transcriptPath: string, summariesPath: string,
 *          databaseStat: any, transcriptStat: any}} conversation
 * @param {boolean} hasSummaries
 * @returns {Promise<any[]>}
 */
async function parseConversation(ctx, conversation, hasSummaries) {
  const { utils } = ctx;
  const { id, databasePath, transcriptPath, summariesPath, databaseStat, transcriptStat } = conversation;
  /** @type {any} */
  const base = {
    nativeId: id,
    title: '',
    projectPath: '',
    startedAt: 0,
    updatedAt: databaseStat ? Math.round(databaseStat.mtimeMs) : 0,
    messages: 0,
    userMessages: 0,
    sizeBytes: databaseStat ? databaseStat.size : 0,
    preview: '',
    lastPreview: '',
    sourcePath: databasePath,
    ref: { db: databasePath, transcript: transcriptPath, summaries: summariesPath, id },
  };

  if (transcriptStat) {
    try {
      const parsed = await parseTranscript(transcriptPath, ctx.signal);
      if (parsed && parsed.messages > 0) {
        base.messages = parsed.messages;
        base.userMessages = parsed.userMessages;
        base.startedAt = parsed.startedAt;
        base.updatedAt = parsed.updatedAt || base.updatedAt;
        base.preview = cleanPrompt(parsed.firstPrompt).slice(0, 220);
        base.lastPreview = cleanPrompt(parsed.lastPreview).slice(0, 220);
        base.title = titleFromPrompt(parsed.firstPrompt, 90);
        if (!hasSummaries) {
          // No summaries index: the conversation DB still records the workspace URI and precise
          // first/last step timestamps, so the session lands on the right project timeline.
          const metadata = await readConversationMetadata(utils, databasePath);
          if (metadata) {
            base.projectPath = metadata.projectPath || base.projectPath;
            base.startedAt = base.startedAt || metadata.startedAt;
            base.updatedAt = base.updatedAt || metadata.updatedAt;
          }
        }
        return [base];
      }
    } catch (error) {
      ctx.warn(`Antigravity: cannot read transcript for ${id}: ${error?.message || error}`);
    }
  }

  // No readable transcript: fall back to the conversation DB's step metadata only.
  const metadata = await readConversationMetadata(utils, databasePath);
  if (metadata) {
    base.messages = metadata.messages;
    base.projectPath = metadata.projectPath;
    base.startedAt = metadata.startedAt || base.startedAt;
    base.updatedAt = metadata.updatedAt || base.updatedAt;
    base.title = titleFromPrompt(base.projectPath, 90);
  }
  return [base];
}

/**
 * Read the conversation summaries index (title/workspace/last-modified), cached by fingerprint.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} summariesPath
 * @returns {Promise<Map<string, any>>}
 */
async function readSummaries(ctx, summariesPath) {
  const { utils, cache } = ctx;
  const map = new Map();
  const fingerprint = await sqliteFingerprint(utils, summariesPath);
  if (fingerprint === '') return map;
  let rows = cache.get(summariesPath, fingerprint);
  if (!rows) {
    rows = [];
    let readable = true;
    /** @type {import('node:sqlite').DatabaseSync|null} */
    let db = null;
    try {
      db = await utils.openSqliteDatabase(summariesPath, { readOnly: true });
      rows = utils.querySqlite(
        db,
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, last_user_input_time
           FROM conversation_summaries`,
      );
    } catch (error) {
      readable = false;
      ctx.warn(`Antigravity: cannot read ${summariesPath}: ${error?.message || error}`);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
    // Only a successful read is cached: a transient lock must be retried on the next scan.
    if (readable) cache.set(summariesPath, fingerprint, rows);
  }
  for (const row of rows) {
    const id = row && typeof row.conversation_id === 'string' ? row.conversation_id : '';
    if (id !== '') map.set(id, row);
  }
  return map;
}

/**
 * Apply the summaries index over a cached base row. Title/workspace/updatedAt can change without
 * the transcript changing, so this merge happens on every scan.
 * @param {any} base
 * @param {any} summary
 * @returns {any}
 */
function enrich(base, summary) {
  const row = { ...base };
  if (summary) {
    const title = typeof summary.title === 'string' ? summary.title.trim() : '';
    if (title !== '') row.title = title;
    const projectPath = decodeWorkspaceUris(summary.workspace_uris);
    if (projectPath !== '') row.projectPath = projectPath;
    const updatedAt = toTs(summary.last_modified_time) || toTs(summary.last_user_input_time);
    if (updatedAt > 0) row.updatedAt = Math.max(row.updatedAt || 0, updatedAt);
    const preview = typeof summary.preview === 'string' ? summary.preview.trim() : '';
    if (row.preview === '' && preview !== '' && preview !== title) row.preview = cleanPrompt(preview).slice(0, 220);
    const stepCount = Number(summary.step_count) || 0;
    if (row.messages === 0 && stepCount > 0) row.messages = stepCount;
  }
  if (typeof row.title !== 'string' || row.title.trim() === '') {
    row.title = titleFromPrompt(row.preview, 90) || '未命名会话';
  }
  return row;
}

/**
 * Conversation roots (each is a `conversations` directory).
 * @param {import('../types.js').ScanContext} ctx
 * @returns {string[]}
 */
function conversationRoots(ctx) {
  const { utils, env } = ctx;
  /** @type {string[]} */
  const roots = [];
  const configured = [
    typeof process.env.ANTIGRAVITY_DATA_DIR === 'string' ? process.env.ANTIGRAVITY_DATA_DIR : '',
    typeof env.config?.antigravityDataDir === 'string' ? env.config.antigravityDataDir : '',
  ]
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of configured) {
    const expanded = utils.expandPath(value);
    if (expanded === '') continue;
    roots.push(/[\\/]conversations$/.test(expanded) ? expanded : join(expanded, 'conversations'));
  }
  for (const app of APP_SUBDIRS) roots.push(join(env.home, '.gemini', app, 'conversations'));
  roots.push(join(env.home, '.config', 'antigravity', 'conversations'));
  return [...new Set(roots)];
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
  let foundRoot = false;

  for (const root of conversationRoots(ctx)) {
    const probe = await utils.statSafe(root);
    if (probe === null || !probe.isDirectory) continue;
    foundRoot = true;
    const appRoot = utils.dirnameOf(root);
    const summariesPath = join(appRoot, 'conversation_summaries.db');
    const summaries = await readSummaries(ctx, summariesPath);

    const entries = await utils.readdirSafe(root);
    const databases = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      if (databases.length >= MAX_CONVERSATIONS) break;
      const id = entry.name.slice(0, -3);
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      const databasePath = join(root, entry.name);
      const databaseStat = await utils.statSafe(databasePath);
      if (!databaseStat || !databaseStat.isFile) continue;
      databases.push({ id, databasePath, databaseStat });
      bytes += databaseStat.size;
    }

    let parsedCount = 0;
    for (const conversation of databases) {
      if (ctx.signal?.aborted) break;
      const transcriptPath = join(appRoot, 'brain', conversation.id, '.system_generated', 'logs', 'transcript.jsonl');
      const transcriptStat = await utils.statSafe(transcriptPath);
      const databaseFingerprint = await sqliteFingerprint(utils, conversation.databasePath);
      const transcriptFingerprint = transcriptStat ? `${transcriptStat.size}:${Math.round(transcriptStat.mtimeMs)}` : '-';
      const fingerprint = `${databaseFingerprint}|${transcriptFingerprint}`;
      let rows = cache.get(conversation.databasePath, fingerprint);
      if (!rows) {
        let readable = true;
        try {
          rows = await parseConversation(
            ctx,
            {
              id: conversation.id,
              databasePath: conversation.databasePath,
              transcriptPath,
              summariesPath,
              databaseStat: conversation.databaseStat,
              transcriptStat,
            },
            summaries.size > 0,
          );
        } catch (error) {
          readable = false;
          ctx.warn(`Antigravity: cannot read ${conversation.databasePath}: ${error?.message || error}`);
          rows = [];
        }
        // Only a successful parse is cached: a transient lock must be retried on the next scan.
        if (readable) cache.set(conversation.databasePath, fingerprint, rows);
      }
      parsedCount += 1;
      for (const base of rows) {
        if (!base || base.messages === 0) continue;
        const summary = summaries.get(conversation.id);
        const session = enrich(base, summary);
        if (session.projectPath === '' && summary) {
          // A few summaries omit workspace_uris; read the recorded URI from the conversation DB.
          const metadata = await readConversationMetadata(utils, conversation.databasePath);
          if (metadata && metadata.projectPath !== '') session.projectPath = metadata.projectPath;
        }
        sessions.push(session);
      }
    }

    sources.push({
      label: 'Antigravity conversations',
      path: root,
      exists: true,
      files: parsedCount,
      bytes,
      note: 'SQLite conversation stores; transcript from brain/<id>/.system_generated/logs/transcript.jsonl',
    });
  }

  if (!foundRoot) {
    sources.push({
      label: 'Antigravity conversations',
      path: conversationRoots(ctx)[0] || '',
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Antigravity is not installed for this user (or ANTIGRAVITY_DATA_DIR points elsewhere)',
    });
  }

  return { sources, sessions };
}

/**
 * Read one Antigravity conversation. Prefers the brain transcript; when it is missing (or carries
 * no readable text) falls back to the full-text index inside `conversation_summaries.db`.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 */
export async function readMessages(ctx, session) {
  const transcriptPath = session.ref?.transcript;
  /** @type {any[]} */
  const messages = [];

  if (typeof transcriptPath === 'string' && transcriptPath !== '') {
    try {
      await readJsonl(
        transcriptPath,
        (line) => {
          if (messages.length >= MAX_MESSAGES) return;
          if (!line.includes('"type"')) return;
          const record = safeJsonParse(line);
          if (!record || typeof record !== 'object') return;
          const ts = toTs(record.created_at);
          const type = record.type;
          if (type === 'USER_INPUT') {
            const raw = typeof record.content === 'string' ? record.content : '';
            const request = extractTag(raw, 'USER_REQUEST') || raw.trim();
            if (request === '') return;
            messages.push({ role: 'user', ts, text: request });
            return;
          }
          if (type === 'PLANNER_RESPONSE') {
            const content = typeof record.content === 'string' ? record.content : '';
            if (content.trim() !== '') messages.push({ role: 'assistant', ts, text: content });
            if (typeof record.thinking === 'string' && record.thinking.trim() !== '') {
              messages.push({ role: 'assistant', ts, kind: 'thinking', text: clip(record.thinking, 4000) });
            }
            for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
              if (!call || typeof call !== 'object') continue;
              messages.push({
                role: 'tool',
                ts,
                kind: 'tool-call',
                name: typeof call.name === 'string' ? call.name : 'tool',
                text: clip(JSON.stringify(call.args ?? {}), 600),
              });
            }
            return;
          }
          if (record.source === 'MODEL' && typeof contentText(record.content) !== '') {
            messages.push({
              role: 'tool',
              ts,
              kind: 'tool-result',
              name: String(type || 'tool').toLowerCase(),
              text: clip(contentText(record.content), 700),
            });
          }
        },
        { signal: ctx.signal },
      );
    } catch {
      // Missing/broken transcript: fall through to the full-text index.
    }
  }

  if (messages.length > 0) return { messages };

  const summariesPath = session.ref?.summaries;
  const conversationId = session.ref?.id || session.nativeId;
  const fromIndex = await readMessagesFromIndex(ctx, summariesPath, conversationId);
  if (fromIndex.length > 0) return { messages: fromIndex };

  ctx.warn(
    `Antigravity: conversation ${conversationId} has no readable local transcript (brain transcript and search index are both empty); the detail view is unavailable`,
  );
  return { messages: [] };
}

/** @param {unknown} content @returns {string} */
function contentText(content) {
  return typeof content === 'string' ? content : '';
}

/**
 * Fallback transcript source: the `conversations_fts_content` chunks that Antigravity keeps for
 * its full-text search index. Each chunk stores the user and agent body text of a step range.
 * @param {import('../types.js').ScanContext} ctx
 * @param {unknown} summariesPath
 * @param {string} conversationId
 * @returns {Promise<any[]>}
 */
async function readMessagesFromIndex(ctx, summariesPath, conversationId) {
  if (typeof summariesPath !== 'string' || summariesPath === '' || typeof conversationId !== 'string') return [];
  /** @type {any[]} */
  const messages = [];
  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  try {
    db = await ctx.utils.openSqliteDatabase(summariesPath, { readOnly: true });
    // Empty external-content FTS row ids: the shadow content table keeps the indexed columns.
    const rows = ctx.utils.querySqlite(
      db,
      'SELECT c1 AS chunk_index, c13 AS user_body, c14 AS agent_body FROM conversations_fts_content WHERE c0 = ? ORDER BY c1',
      [conversationId],
    );
    for (const row of rows) {
      if (messages.length >= MAX_MESSAGES) break;
      const userBody = typeof row.user_body === 'string' ? row.user_body.trim() : '';
      const agentBody = typeof row.agent_body === 'string' ? row.agent_body.trim() : '';
      if (userBody !== '') messages.push({ role: 'user', ts: 0, text: userBody });
      if (agentBody !== '') messages.push({ role: 'assistant', ts: 0, text: agentBody });
    }
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return messages;
}
