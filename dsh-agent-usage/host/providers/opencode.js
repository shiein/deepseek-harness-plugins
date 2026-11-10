/**
 * OpenCode provider.
 *
 * OpenCode stores usage in two places under its data directory
 * (`$OPENCODE_DATA_DIR`, `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`):
 *
 * 1. SQLite `opencode.db` (and older `opencode-next.db`). Table `message` has one row
 *    per chat message; the `data` JSON of an assistant row carries:
 *      { role: "assistant", modelID, providerID, cost, time: { created },
 *        tokens: { input, output, reasoning, cache: { read, write } } }
 *    `tokens.input` is the uncached prompt size; cache read/write are separate.
 *    `cost` is the USD cost OpenCode computed for that response.
 *
 * 2. Legacy JSON store `storage/message/<sessionID>/<messageID>.json` with the same
 *    object shape. OpenCode migrated these rows into SQLite in place, so the same
 *    message id can exist in both stores: the SQLite row wins and the legacy file is
 *    skipped by id (verified on this machine: 455/455 legacy ids are in opencode.db).
 *
 * `reasoning` is folded into `output` by OpenCode's token accounting, so it is not
 * reported separately (avoids double counting output).
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'opencode',
  name: 'OpenCode',
  color: '#f97316',
  homepage: 'https://opencode.ai',
  cacheVersion: 2, // 2: rows carry the session folder (`session.directory`, or the message `path`)
};

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function dataDirs(ctx) {
  const raw = process.env.OPENCODE_DATA_DIR || '';
  const dirs = [];
  if (raw.trim() !== '') {
    for (const part of raw.split(',')) {
      const expanded = ctx.utils.expandPath(part.trim());
      if (expanded) dirs.push(expanded);
    }
  } else {
    if (ctx.env.platform === 'win32' && ctx.env.localAppData) dirs.push(join(ctx.env.localAppData, 'opencode'));
    dirs.push(join(ctx.env.xdgData, 'opencode'));
    if (ctx.env.platform === 'win32' && ctx.env.appData) dirs.push(join(ctx.env.appData, 'opencode'));
  }
  return [...new Set(dirs.filter(Boolean))];
}

/**
 * Fingerprint of a live SQLite database including its write-ahead log.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string} dbPath
 * @returns {Promise<string>}
 */
async function sqliteFingerprint(utils, dbPath) {
  const db = await utils.statSafe(dbPath);
  if (db === null) return '';
  let fp = `${db.size}:${Math.round(db.mtimeMs)}`;
  const wal = await utils.statSafe(`${dbPath}-wal`);
  if (wal !== null) fp += `|${wal.size}:${Math.round(wal.mtimeMs)}`;
  return fp;
}

/** @param {unknown} value @returns {number} */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** @param {unknown} value @returns {number} */
function costNum(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Add one OpenCode assistant message payload to the cell map.
 * @param {Map<string, import('../scanner-types.js').Cell>} map
 * @param {any} data
 * @param {string} fallbackTs
 * @param {typeof import('../scan-utils.js')} utils
 * @returns {boolean} whether usage was added
 */
function addOpenCodeMessage(map, data, fallbackTs, utils, rowType, sessionFolder = '') {
  if (!data || typeof data !== 'object') return false;
  // V1 message rows keep the role in `data.role`; V2 `session_message` rows keep it in
  // the row's `type` column.
  const role = typeof rowType === 'string' && rowType !== '' ? rowType : data.role;
  if (role !== 'assistant') return false;
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
  if (!tokens) return false;
  const input = num(tokens.input);
  // OpenCode's `output` excludes reasoning tokens; fold reasoning in (T3 Code does the same).
  const output = num(tokens.output) + num(tokens.reasoning);
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  if (input + output + cacheRead + cacheWrite === 0) return false;
  const model =
    (data.model && typeof data.model.id === 'string' && data.model.id) ||
    (typeof data.modelID === 'string' && data.modelID) ||
    (data.model && typeof data.model.modelID === 'string' && data.model.modelID) ||
    'unknown';
  const ts = Number(data.time && data.time.created) || Number(fallbackTs) || 0;
  const fromMessage = data.path && typeof data.path === 'object'
    ? (typeof data.path.cwd === 'string' && data.path.cwd) || (typeof data.path.root === 'string' && data.path.root) || ''
    : '';
  const folder = fromMessage || sessionFolder;
  addUsage(map, {
    model,
    project: folder,
    day: utils.localDay(ts),
    ts,
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd: costNum(data.cost) || undefined,
    messages: 1,
  });
  return true;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];
  const roots = dataDirs(ctx);
  let foundRoot = false;

  for (const root of roots) {
    const rootStat = await utils.statSafe(root);
    if (rootStat === null || !rootStat.isDirectory) continue;
    foundRoot = true;

    /** @type {Set<string>} ids counted from any store, used to skip migrated legacy copies */
    const seenMessageIds = new Set();

    // ---- SQLite databases -------------------------------------------------
    const entries = await utils.readdirSafe(root);
    const dbFiles = entries
      .filter((entry) => entry.isFile() && /^opencode.*\.db$/i.test(entry.name) && !/-(wal|shm)$/i.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort();

    for (const dbPath of dbFiles) {
      const fingerprint = await sqliteFingerprint(utils, dbPath);
      if (fingerprint === '') continue;
      const dbStat = await utils.statSafe(dbPath);
      const walStat = await utils.statSafe(`${dbPath}-wal`);
      let dbBytes = (dbStat?.size || 0) + (walStat?.size || 0);
      let dbCellCount = 0;

      let rows = [];
      /** session id → the folder the session ran in (`session.directory`). */
      let folders = new Map();
      try {
        const db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
        try {
          try {
            utils.querySqlite(db, 'PRAGMA busy_timeout = 100');
          } catch {
            // read-only handles are fine without it
          }
          // Newer OpenCode builds (V2) moved message rows to `session_message`; read that
          // first so a migrated database never counts the same response from both tables.
          rows = utils.querySqlite(db, 'SELECT id, session_id, type, time_created, data FROM session_message ORDER BY time_created');
          if (rows.length === 0) {
            rows = utils.querySqlite(db, 'SELECT id, session_id, time_created, data FROM message ORDER BY time_created');
          }
          folders = new Map(utils.querySqlite(db, 'SELECT id, directory FROM session')
            .filter((row) => typeof row.directory === 'string' && row.directory !== '')
            .map((row) => [String(row.id), row.directory]));
        } finally {
          try {
            db.close();
          } catch {
            // ignore close failure
          }
        }
      } catch (error) {
        ctx.warn(`OpenCode: cannot read ${dbPath}: ${error?.message || error}`);
      }
      if (rows.length === 0) continue;

      const ids = new Set(rows.map((row) => String(row.id)));
      const freshRows = rows.filter((row) => !seenMessageIds.has(String(row.id)));
      for (const id of ids) seenMessageIds.add(id);
      if (freshRows.length === 0) continue;

      let dbCells = cache.get(dbPath, fingerprint);
      if (!dbCells || freshRows.length !== rows.length) {
        // A cache entry always covers the whole database. When a newer database
        // claimed some ids first the cached aggregate is stale; reparse.
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        for (const row of freshRows) {
          let data = null;
          try {
            data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          } catch {
            continue;
          }
          const folder = folders.get(String(row.session_id)) || '';
          if (addOpenCodeMessage(byKey, data, row.time_created, utils, row.type, folder)) dbCellCount += 1;
        }
        dbCells = finalizeCells([...byKey.values()]);
        if (freshRows.length === rows.length) cache.set(dbPath, fingerprint, dbCells);
      }
      if (dbCells.length > 0) allCells.push(...dbCells);
      sources.push({
        label: 'OpenCode SQLite database',
        path: dbPath,
        exists: true,
        files: dbCells.reduce((sum, cell) => sum + (cell.messages || 0), 0) || rows.length,
        bytes: dbBytes,
        note: 'message table: one assistant row per model response; tokens and cost stored by OpenCode',
      });
    }

    // ---- Legacy JSON storage ---------------------------------------------
    const storageDir = join(root, 'storage', 'message');
    const storageStat = await utils.statSafe(storageDir);
    if (storageStat !== null && storageStat.isDirectory) {
      const files = await utils.listFilesRecursive(storageDir, {
        exts: ['.json'],
        maxDepth: 4,
        maxFiles: 50000,
        signal: ctx.signal,
      });
      let bytes = 0;
      let parsedFiles = 0;
      let skippedMigrated = 0;
      let contributedFiles = 0;
      for (const file of files) {
        bytes += file.size;
        const messageId = utils.basenameOf(file.path).replace(/\.json$/i, '');
        if (seenMessageIds.has(messageId)) {
          skippedMigrated += 1;
          continue;
        }
        parsedFiles += 1;
        const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
        let fileCells = cache.get(file.path, fingerprint);
        if (!fileCells) {
          const raw = await utils.readText(file.path);
          const data = utils.safeJsonParse(raw || '');
          /** @type {Map<string, import('../scanner-types.js').Cell>} */
          const byKey = new Map();
          const contributed = addOpenCodeMessage(byKey, data, file.mtimeMs, utils);
          fileCells = finalizeCells([...byKey.values()]);
          cache.set(file.path, fingerprint, fileCells);
          if (contributed) contributedFiles += 1;
        } else if (fileCells.length > 0) {
          contributedFiles += 1;
        }
        if (fileCells.length > 0) allCells.push(...fileCells);
      }
      sources.push({
        label: 'OpenCode legacy JSON storage',
        path: storageDir,
        exists: true,
        files: files.length,
        bytes,
        note:
          contributedFiles > 0
            ? 'legacy message JSON (pre-SQLite sessions)'
            : `legacy message JSON; ${skippedMigrated} message(s) were already counted from SQLite`,
      });
    }

    if (dbFiles.length === 0 && (storageStat === null || !storageStat.isDirectory)) {
      sources.push({
        label: 'OpenCode data directory',
        path: root,
        exists: true,
        files: 0,
        bytes: 0,
        note: 'directory exists but contains no opencode*.db and no storage/message',
      });
    }
  }

  if (!foundRoot) {
    sources.push({
      label: 'OpenCode data directory',
      path: roots[0] || join(env.home, '.local', 'share', 'opencode'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'OpenCode is not installed on this machine (or OPENCODE_DATA_DIR points elsewhere)',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
