/**
 * Cursor history provider.
 *
 * Cursor is a VS Code fork, so conversations live in SQLite state stores:
 *   macOS:   ~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}/state.vscdb
 *   Windows: %APPDATA%\Cursor\User\...
 *   Linux:   ~/.config/Cursor/User/...
 *
 * The authoritative chat data is the `cursorDiskKV` table of the globalStorage database:
 *   composerData:<composerId>          one conversation (name, createdAt, lastUpdatedAt, modelConfig)
 *   bubbleId:<composerId>:<bubbleId>   one message bubble (type 1=user / 2=assistant, text,
 *                                      createdAt, toolFormerData for agent tool calls)
 * Workspace databases contribute the `composer.composerData` ItemTable envelope
 * (allComposers metadata) plus `workspace.json` (`folder`), which is how a composer is mapped
 * to a project folder. Older builds used per-workspace aichat blobs in ItemTable; those are
 * detected but not converted into sessions because their schema is not stable enough to read
 * without guessing.
 *
 * Cursor has no entry in its CLI for resuming a composer, so `resume.kind` is 'none'.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'cursor',
  name: 'Cursor',
  color: '#64748b',
  homepage: 'https://cursor.com',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/** Upper bound on cursorDiskKV rows parsed per database (keeps a refresh bounded). */
const MAX_DB_ROWS = 200000;
const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function appRoots(env) {
  if (env.platform === 'win32') return [join(env.appData, 'Cursor')];
  if (env.platform === 'darwin') return [join(env.home, 'Library', 'Application Support', 'Cursor')];
  return [join(env.home, '.config', 'Cursor')];
}

/**
 * Cache access that tolerates both the documented 2-arg CacheFace and the 3-arg HistoryCache
 * the scanner currently passes. Never throws: caching is an optimization only.
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
 * @param {unknown} raw
 * @returns {any|null}
 */
function parseJsonValue(raw) {
  if (raw === null || raw === undefined) return null;
  let text;
  if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf8');
  else if (typeof raw === 'string') text = raw;
  else return null;
  if (text.trim() === '') return null;
  return safeJsonParse(text);
}

/**
 * @param {unknown} value
 * @returns {number} epoch ms, 0 when unparseable
 */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) return coerceEpochMs(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/**
 * `file:///Users/me/project` -> `/Users/me/project` (Windows drive URIs included).
 * @param {unknown} uri
 * @returns {string}
 */
function decodeFileUri(uri) {
  if (typeof uri !== 'string' || uri.trim() === '') return '';
  const text = uri.trim();
  if (!text.startsWith('file://')) return '';
  try {
    const parsed = new URL(text);
    let pathname = decodeURIComponent(parsed.pathname || '');
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    if (/\.code-workspace$/i.test(pathname)) {
      const index = Math.max(pathname.lastIndexOf('/'), pathname.lastIndexOf('\\'));
      return index > 0 ? pathname.slice(0, index) : pathname;
    }
    return pathname;
  } catch {
    return '';
  }
}

/**
 * Read a workspace's composer metadata and project folder.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} workspaceDir
 * @returns {Promise<{projectPath: string, composers: Map<string, Record<string, any>>}|null>}
 */
async function readWorkspaceComposers(utils, workspaceDir) {
  const dbPath = join(workspaceDir, 'state.vscdb');
  const dbStat = await utils.statSafe(dbPath);
  if (dbStat === null || !dbStat.isFile) return null;
  let projectPath = '';
  const workspaceJson = safeJsonParse((await utils.readText(join(workspaceDir, 'workspace.json'))) || '');
  if (workspaceJson && typeof workspaceJson === 'object') {
    const record = /** @type {Record<string, any>} */ (workspaceJson);
    projectPath = decodeFileUri(record.folder) || decodeFileUri(record.workspace) || (typeof record.folderPath === 'string' ? record.folderPath : '');
  }
  /** @type {Map<string, Record<string, any>>} */
  const composers = new Map();
  let db = null;
  try {
    db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
    const tables = new Set(
      utils.querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row?.name || '')),
    );
    if (!tables.has('ItemTable')) return { projectPath, composers };
    const rows = utils.querySqlite(db, "SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
    if (rows.length === 0) return { projectPath, composers };
    const envelope = parseJsonValue(rows[0]?.value);
    const allComposers = envelope && typeof envelope === 'object' ? envelope.allComposers : null;
    if (!allComposers || typeof allComposers !== 'object') return { projectPath, composers };
    const entries = Array.isArray(allComposers) ? allComposers : Object.values(allComposers);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = /** @type {Record<string, any>} */ (entry);
      const composerId = String(record.composerId || record.id || '');
      if (composerId === '') continue;
      composers.set(composerId, { ...record, projectPath });
    }
  } catch {
    return { projectPath, composers };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return { projectPath, composers };
}

/**
 * Rich text fallback: Cursor stores some bubble bodies as a serialized document; collect its
 * `text` leaves only, never guessing structure.
 * @param {unknown} value
 * @returns {string}
 */
function richTextToPlain(value) {
  let root = value;
  if (typeof root === 'string') root = safeJsonParse(root);
  if (!root || typeof root !== 'object') return '';
  const parts = [];
  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (parts.length > 500 || depth > 32 || node === null || node === undefined) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const record = /** @type {Record<string, any>} */ (node);
    if (typeof record.text === 'string' && record.text !== '') parts.push(record.text);
    for (const key of ['content', 'children', 'blocks', 'docs']) {
      if (record[key] && typeof record[key] === 'object') walk(record[key], depth + 1);
    }
  };
  walk(root, 0);
  if (parts.length === 0) return '';
  return parts.join('\n');
}

/**
 * @param {Record<string, any>} bubble
 * @returns {'user'|'assistant'|''}
 */
function bubbleRole(bubble) {
  const type = bubble.type;
  if (type === 1 || type === '1') return 'user';
  if (type === 2 || type === '2') return 'assistant';
  if (bubble.role === 'user' || bubble.role === 'assistant') return bubble.role;
  return '';
}

/**
 * @param {Record<string, any>} bubble
 * @returns {string}
 */
function bubbleText(bubble) {
  if (typeof bubble.text === 'string' && bubble.text.trim() !== '') return bubble.text;
  if (typeof bubble.content === 'string' && bubble.content.trim() !== '') return bubble.content;
  if (typeof bubble.rawText === 'string' && bubble.rawText.trim() !== '') return bubble.rawText;
  const rich = richTextToPlain(bubble.richText);
  return rich;
}

/**
 * Tool calls stored on an assistant bubble (`toolFormerData` and the newer toolCalls array).
 * @param {Record<string, any>} bubble
 * @returns {{name: string, text: string}[]}
 */
function bubbleToolCalls(bubble) {
  /** @type {{name: string, text: string}[]} */
  const calls = [];
  const former = bubble.toolFormerData && typeof bubble.toolFormerData === 'object' ? bubble.toolFormerData : null;
  if (former) {
    const name = typeof former.name === 'string' ? former.name : typeof former.toolName === 'string' ? former.toolName : '';
    if (name !== '') {
      const params = former.params ?? former.rawArgs ?? former.arguments ?? {};
      calls.push({ name, text: typeof params === 'string' ? params : JSON.stringify(params) });
    }
  }
  if (Array.isArray(bubble.toolCalls)) {
    for (const call of bubble.toolCalls) {
      if (!call || typeof call !== 'object') continue;
      const name = typeof call.name === 'string' ? call.name : '';
      if (name === '') continue;
      const args = call.arguments ?? {};
      calls.push({ name, text: typeof args === 'string' ? args : JSON.stringify(args) });
    }
  }
  return calls;
}

/**
 * Parse one database's cursorDiskKV rows into composer metadata and grouped bubbles.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} dbPath
 * @param {Map<string, Record<string, any>>} composerMeta
 * @param {Map<string, {dbPaths: Set<string>, rows: {bubble: Record<string, any>, size: number}[]}>} bubbleGroups
 * @param {{legacy: boolean}} flags
 * @returns {Promise<{considered: number, bytes: number}>}
 */
async function scanDatabase(ctx, dbPath, composerMeta, bubbleGroups, flags) {
  const { utils } = ctx;
  let db = null;
  let considered = 0;
  try {
    db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
    const tables = new Set(
      utils.querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row?.name || '')),
    );
    if (!tables.has('cursorDiskKV')) {
      if (tables.has('ItemTable')) {
        const legacyRows = utils.querySqlite(
          db,
          "SELECT key FROM ItemTable WHERE key LIKE '%aichat%' OR key LIKE '%composer%' OR key LIKE '%chatdata%' LIMIT 50",
        );
        if (legacyRows.length > 0) flags.legacy = true;
      }
      return { considered, bytes: 0 };
    }
    const rows = utils.querySqlite(
      db,
      `SELECT key, value FROM cursorDiskKV
        WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'
        LIMIT ${MAX_DB_ROWS}`,
    );
    for (const row of rows) {
      if (ctx.signal?.aborted) break;
      considered += 1;
      const key = typeof row?.key === 'string' ? row.key : '';
      if (key === '') continue;
      const value = row?.value;
      const rawSize = Buffer.isBuffer(value) ? value.length : value instanceof Uint8Array ? value.length : typeof value === 'string' ? value.length : 0;
      const parsed = parseJsonValue(value);
      if (!parsed || typeof parsed !== 'object') continue;
      if (key.startsWith('composerData:')) {
        const composerId = key.slice('composerData:'.length);
        if (composerId === '') continue;
        const previous = composerMeta.get(composerId) || {};
        composerMeta.set(composerId, {
          ...previous,
          .../** @type {Record<string, any>} */ (parsed),
          composerId,
        });
        continue;
      }
      const parts = key.split(':');
      const composerId = parts[1] || '';
      if (composerId === '') continue;
      let group = bubbleGroups.get(composerId);
      if (!group) {
        group = { dbPaths: new Set(), rows: [] };
        bubbleGroups.set(composerId, group);
      }
      group.dbPaths.add(dbPath);
      group.rows.push({ bubble: /** @type {Record<string, any>} */ (parsed), size: rawSize });
    }
  } catch {
    return { considered, bytes: 0 };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return { considered, bytes: 0 };
}

/**
 * @param {Map<string, Record<string, any>>} composerMeta
 * @param {Map<string, {dbPaths: Set<string>, rows: {bubble: Record<string, any>, size: number}[]}>} bubbleGroups
 * @returns {any[]}
 */
function buildSessions(composerMeta, bubbleGroups) {
  /** @type {any[]} */
  const sessions = [];
  const composerIds = new Set([...composerMeta.keys(), ...bubbleGroups.keys()]);
  for (const composerId of composerIds) {
    const group = bubbleGroups.get(composerId);
    if (!group) continue;
    const meta = composerMeta.get(composerId) || {};
    let userMessages = 0;
    let messages = 0;
    let firstPrompt = '';
    let lastPreview = '';
    let firstTs = 0;
    let lastTs = 0;
    let sizeBytes = 0;
    let model = '';
    /** @type {Set<string>} */
    const files = new Set(group.dbPaths);
    for (const entry of group.rows) {
      const bubble = entry.bubble;
      sizeBytes += entry.size;
      const ts = coerceEpochMs(bubble.createdAt) || coerceEpochMs(bubble.timestamp);
      if (ts > 0) {
        if (firstTs === 0 || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      if (model === '' && bubble.modelInfo && typeof bubble.modelInfo === 'object' && typeof bubble.modelInfo.modelName === 'string') {
        model = bubble.modelInfo.modelName;
      }
      const role = bubbleRole(bubble);
      if (role === '') continue;
      const text = bubbleText(bubble);
      if (text.trim() === '') continue;
      if (role === 'user') {
        userMessages += 1;
        messages += 1;
        if (firstPrompt === '') firstPrompt = text;
        lastPreview = text;
      } else {
        messages += 1;
        lastPreview = text;
      }
    }
    if (messages === 0) continue;
    const modelConfig = meta.modelConfig && typeof meta.modelConfig === 'object' ? meta.modelConfig : null;
    if (model === '' && modelConfig && typeof modelConfig.modelName === 'string') model = modelConfig.modelName;
    const createdAt = coerceEpochMs(meta.createdAt);
    const updatedAtMeta = coerceEpochMs(meta.lastUpdatedAt) || coerceEpochMs(meta.updatedAt);
    const title = [meta.name, meta.title].find((value) => typeof value === 'string' && value.trim() !== '');
    sessions.push({
      nativeId: composerId,
      title: typeof title === 'string' ? title.trim() : titleFromPrompt(firstPrompt, 90) || '未命名会话',
      projectPath: typeof meta.projectPath === 'string' ? meta.projectPath : '',
      startedAt: createdAt || firstTs,
      updatedAt: updatedAtMeta || lastTs || createdAt || firstTs,
      messages,
      userMessages,
      sizeBytes,
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: [...group.dbPaths][0] || '',
      extra: model !== '' ? model : undefined,
      ref: { files: [...files], composerId },
    });
  }
  return sessions;
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

  for (const appRoot of appRoots(env)) {
    const userDir = join(appRoot, 'User');
    const userStat = await utils.statSafe(userDir);
    if (userStat === null || !userStat.isDirectory) {
      sources.push({
        label: 'Cursor state.vscdb',
        path: join(appRoot, 'User', 'globalStorage', 'state.vscdb'),
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Cursor is not installed on this machine',
      });
      continue;
    }

    const globalDb = join(userDir, 'globalStorage', 'state.vscdb');
    const globalStat = await utils.statSafe(globalDb);
    const workspaceStorage = join(userDir, 'workspaceStorage');
    /** @type {{dbPath: string, stat: any, projectPath: string, composers: Map<string, Record<string, any>>}[]} */
    const workspaces = [];
    const fingerprintParts = [];
    const composerMeta = new Map();
    for (const entry of await utils.readdirSafe(workspaceStorage)) {
      if (!entry.isDirectory()) continue;
      const workspaceDir = join(workspaceStorage, entry.name);
      const parsed = await readWorkspaceComposers(utils, workspaceDir);
      if (parsed === null) continue;
      const dbPath = join(workspaceDir, 'state.vscdb');
      const dbStat = await utils.statSafe(dbPath);
      if (dbStat === null || !dbStat.isFile) continue;
      workspaces.push({ dbPath, stat: dbStat, projectPath: parsed.projectPath, composers: parsed.composers });
      fingerprintParts.push(`w:${await sqliteFingerprint(utils, dbPath)}`);
      const workspaceJsonStat = await utils.statSafe(join(workspaceDir, 'workspace.json'));
      if (workspaceJsonStat) fingerprintParts.push(`j:${workspaceJsonStat.size}:${Math.round(workspaceJsonStat.mtimeMs)}`);
      for (const [composerId, meta] of parsed.composers) {
        composerMeta.set(composerId, { ...(composerMeta.get(composerId) || {}), ...meta, projectPath: parsed.projectPath });
      }
    }

    const databases = [];
    if (globalStat && globalStat.isFile) databases.push(globalDb);
    for (const workspace of workspaces) databases.push(workspace.dbPath);
    if (globalStat && globalStat.isFile) fingerprintParts.unshift(`g:${await sqliteFingerprint(utils, globalDb)}`);
    for (const path of databases) {
      if (path === globalDb) continue;
      const stat = await utils.statSafe(path);
      if (stat && stat.isFile) fingerprintParts.push(`s:${path}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    }
    if (databases.length === 0) {
      sources.push({
        label: 'Cursor state.vscdb',
        path: globalDb,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Cursor state databases are not present',
      });
      continue;
    }

    const cacheKey = databases[0];
    const fingerprint = fingerprintParts.join('|');
    let legacyFound = false;
    let rows = fingerprint !== '' ? cacheGet(ctx, cacheKey, fingerprint) : undefined;
    if (!rows) {
      /** @type {Map<string, {dbPaths: Set<string>, rows: {bubble: Record<string, any>, size: number}[]}>} */
      const bubbleGroups = new Map();
      const flags = { legacy: false };
      for (const dbPath of databases) {
        await scanDatabase(ctx, dbPath, composerMeta, bubbleGroups, flags);
      }
      legacyFound = flags.legacy;
      rows = buildSessions(composerMeta, bubbleGroups);
      cacheSet(ctx, cacheKey, fingerprint, rows);
    }
    sessions.push(...rows);

    if (globalStat && globalStat.isFile) {
      sources.push({
        label: 'Cursor state.vscdb',
        path: globalDb,
        exists: true,
        files: rows.length,
        bytes: globalStat.size,
        note: 'cursorDiskKV composerData:<id> conversations with bubbleId:<id>:<id> messages',
      });
    } else {
      sources.push({
        label: 'Cursor state.vscdb',
        path: globalDb,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'globalStorage database missing; only workspace-scoped composers were readable',
      });
    }
    for (const workspace of workspaces) {
      sources.push({
        label: 'Cursor workspace state',
        path: workspace.dbPath,
        exists: true,
        files: 0,
        bytes: workspace.stat.size,
        note: workspace.projectPath !== '' ? `composer.composerData envelope; project ${workspace.projectPath}` : 'composer.composerData envelope',
      });
    }
    if (rows.length === 0) {
      ctx.warn(
        'Cursor: state.vscdb databases were found but contain no readable composer conversations' +
          (legacyFound ? ' (only legacy aichat/composer ItemTable blobs, whose schema varies between builds and is not parsed)' : ''),
      );
    }
  }

  return { sources, sessions };
}

/**
 * Read one composer's bubbles as a transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const rawFiles = Array.isArray(session?.ref?.files)
    ? session.ref.files
    : typeof session?.ref?.file === 'string'
      ? [session.ref.file]
      : [];
  const files = rawFiles.filter((file) => typeof file === 'string' && file !== '');
  const composerId = typeof session?.ref?.composerId === 'string' ? session.ref.composerId : session?.nativeId;
  if (files.length === 0 || typeof composerId !== 'string' || composerId === '') return { messages: [] };
  const { utils } = ctx;
  /** @type {{bubble: Record<string, any>, ts: number, order: number}[]} */
  const bubbles = [];
  let order = 0;
  for (const dbPath of files) {
    let db = null;
    try {
      db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
      const rows = utils.querySqlite(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? LIMIT 100000", [`bubbleId:${composerId}:%`]);
      for (const row of rows) {
        if (bubbles.length >= MAX_TRANSCRIPT_MESSAGES) break;
        const bubble = parseJsonValue(row?.value);
        if (!bubble || typeof bubble !== 'object') continue;
        bubbles.push({
          bubble: /** @type {Record<string, any>} */ (bubble),
          ts: coerceEpochMs(bubble.createdAt) || coerceEpochMs(bubble.timestamp),
          order: order++,
        });
      }
    } catch {
      // One unreadable workspace database must not hide the rest of the transcript.
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
  bubbles.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.order - b.order);
  /** @type {any[]} */
  const messages = [];
  for (const entry of bubbles) {
    if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
    const role = bubbleRole(entry.bubble);
    const text = bubbleText(entry.bubble);
    if (role !== '' && text.trim() !== '') {
      messages.push({ role, ts: entry.ts, text: text.slice(0, MAX_TEXT) });
    }
    for (const call of bubbleToolCalls(entry.bubble)) {
      messages.push({ role: 'tool', ts: entry.ts, kind: 'tool-call', name: call.name, text: clip(call.text, 600) });
    }
    const former = entry.bubble.toolFormerData && typeof entry.bubble.toolFormerData === 'object' ? entry.bubble.toolFormerData : null;
    if (former && former.result !== undefined && former.result !== null) {
      let body;
      if (typeof former.result === 'string') body = former.result;
      else {
        try {
          body = JSON.stringify(former.result);
        } catch {
          body = '';
        }
      }
      if (typeof body === 'string' && body.trim() !== '') {
        messages.push({ role: 'tool', ts: entry.ts, kind: 'tool-result', text: body.slice(0, MAX_TEXT) });
      }
    }
  }
  return { messages };
}
