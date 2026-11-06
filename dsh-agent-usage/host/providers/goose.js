/**
 * Goose provider (Block's Goose CLI).
 *
 * Current Goose writes a SQLite database at
 * `$GOOSE_PATH_ROOT/data/sessions/sessions.db` when the override is set, else
 * `~/.local/share/goose/sessions/sessions.db` (macOS/Linux, honoring XDG_DATA_HOME) or
 * `%APPDATA%\Block\goose\sessions\sessions.db` (Windows).
 *
 * Token usage is stored per session, not per message, on the `sessions` table:
 *   accumulated_input_tokens, accumulated_output_tokens,
 *   model_config_json (JSON with `model_name`), created_at, updated_at
 * Cache and cost columns (`accumulated_cache_read/write_tokens`, `accumulated_cost`) are
 * read when the schema has them; `accumulated_cost` is already USD.
 *
 * Older Goose releases kept one JSONL file per session in the same `sessions/` folder;
 * those files carry conversation messages but not the accumulated token counters, so
 * they are reported as detected-but-unavailable instead of estimated.
 *
 * NOT VERIFIED ON THIS MACHINE: Goose is not installed here; the SQLite schema follows the
 * Goose upstream `sessions` table (as mapped by the codeburn Goose adapter).
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'goose',
  name: 'Goose',
  color: '#10b981',
  homepage: 'https://block.github.io/goose/',
  cacheVersion: 1,
};

/** @param {unknown} value @returns {number} */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Parse Goose timestamps: SQLite TEXT timestamps are UTC but sometimes lack the `Z`.
 * @param {unknown} value
 * @returns {number}
 */
function toTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return 0;
  }
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const text = value.trim();
  let parsed = Date.parse(text);
  if (Number.isNaN(parsed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) parsed = Date.parse(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** @param {unknown} value @returns {string} */
function blobToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function dbCandidates(ctx) {
  const { utils, env } = ctx;
  const override = utils.expandPath(process.env.GOOSE_PATH_ROOT || '');
  if (override) return [join(override, 'data', 'sessions', 'sessions.db')];
  const paths = [];
  if (env.platform === 'win32') {
    if (env.appData) paths.push(join(env.appData, 'Block', 'goose', 'sessions', 'sessions.db'));
    if (env.localAppData) paths.push(join(env.localAppData, 'Block', 'goose', 'sessions', 'sessions.db'));
  }
  paths.push(join(env.xdgData, 'goose', 'sessions', 'sessions.db'));
  return [...new Set(paths)];
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
  const candidates = dbCandidates(ctx);
  let foundDb = false;

  for (const dbPath of candidates) {
    const dbStat = await utils.statSafe(dbPath);
    if (dbStat === null || !dbStat.isFile) continue;
    foundDb = true;
    const walStat = await utils.statSafe(`${dbPath}-wal`);
    const bytes = dbStat.size + (walStat?.size || 0);
    const fingerprint = `${dbStat.size}:${Math.round(dbStat.mtimeMs)}` + (walStat ? `|${walStat.size}:${Math.round(walStat.mtimeMs)}` : '');
    let dbCells = cache.get(dbPath, fingerprint);
    let sessionRows = 0;
    if (!dbCells) {
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byKey = new Map();
      try {
        const db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
        try {
          const columnRows = utils.querySqlite(db, "SELECT name FROM pragma_table_info('sessions')");
          const columns = new Set(columnRows.map((row) => String(row.name)));
          if (columns.size === 0) {
            ctx.warn('Goose: sessions table not found in ' + dbPath);
          } else if (!columns.has('accumulated_input_tokens') && !columns.has('accumulated_output_tokens')) {
            ctx.warn('Goose: ' + dbPath + ' has no accumulated token columns (unsupported Goose version)');
          } else {
            const wanted = [
              'id',
              'created_at',
              'updated_at',
              'accumulated_input_tokens',
              'accumulated_output_tokens',
              'accumulated_cache_read_tokens',
              'accumulated_cache_write_tokens',
              'accumulated_cost',
              'model_config_json',
            ];
            const selected = wanted.filter((name) => columns.has(name));
            const rows = utils.querySqlite(
              db,
              `SELECT ${selected.map((name) => `"${name}"`).join(', ')} FROM sessions`,
            );
            for (const row of rows) {
              const input = num(row.accumulated_input_tokens);
              const output = num(row.accumulated_output_tokens);
              const cacheRead = num(row.accumulated_cache_read_tokens);
              const cacheWrite = num(row.accumulated_cache_write_tokens);
              const cost = Number(row.accumulated_cost);
              if (input + output + cacheRead + cacheWrite === 0) continue;
              let model = 'unknown';
              const configText = blobToText(row.model_config_json);
              if (configText !== '') {
                const config = utils.safeJsonParse(configText);
                if (config && typeof config.model_name === 'string' && config.model_name !== '') model = config.model_name;
              }
              const ts = toTs(row.updated_at) || toTs(row.created_at) || fileMtimeMs(dbStat.mtimeMs);
              addUsage(byKey, {
                model,
                day: utils.localDay(ts),
                ts,
                input,
                output,
                cacheRead,
                cacheWrite,
                costUsd: Number.isFinite(cost) && cost > 0 ? cost : undefined,
                messages: 1,
              });
              sessionRows += 1;
            }
          }
        } finally {
          try {
            db.close();
          } catch {
            // ignore
          }
        }
      } catch (error) {
        ctx.warn(`Goose: cannot read ${dbPath}: ${error?.message || error}`);
      }
      dbCells = finalizeCells([...byKey.values()]);
      cache.set(dbPath, fingerprint, dbCells);
    }
    if (dbCells.length > 0) allCells.push(...dbCells);
    sources.push({
      label: 'Goose sessions database',
      path: dbPath,
      exists: true,
      files: sessionRows > 0 ? sessionRows : 1,
      bytes,
      note:
        (dbCells.length > 0
          ? 'sessions.accumulated_input/output_tokens per session; model from model_config_json'
          : 'sessions table has no accumulated token usage yet') + '; schema unverified on this machine',
    });
  }

  // Legacy JSONL session files (pre-SQLite Goose): conversation only, no counters.
  if (!foundDb) {
    const legacyDir = join(env.xdgData, 'goose', 'sessions');
    const legacyStat = await utils.statSafe(legacyDir);
    if (legacyStat !== null && legacyStat.isDirectory) {
      const files = await utils.listFilesRecursive(legacyDir, { exts: ['.jsonl'], maxDepth: 3, maxFiles: 20000, signal: ctx.signal });
      if (files.length > 0) {
        let bytes = 0;
        for (const file of files) bytes += file.size;
        sources.push({
          label: 'Goose legacy JSONL sessions',
          path: legacyDir,
          exists: true,
          files: files.length,
          bytes,
          note:
            'legacy Goose JSONL sessions contain messages but no token usage; sessions.db is required to report tokens',
        });
        ctx.warn('Goose: legacy JSONL sessions found but Goose stores token usage only in sessions.db');
      }
    }
  }

  if (!foundDb && sources.length === 0) {
    sources.push({
      label: 'Goose sessions database',
      path: candidates[0],
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Goose is not installed on this machine (or GOOSE_PATH_ROOT points elsewhere); parser unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}

/** @param {number} mtimeMs @returns {number} */
function fileMtimeMs(mtimeMs) {
  return Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : Date.now();
}
