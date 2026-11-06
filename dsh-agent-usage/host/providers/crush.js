/**
 * Crush provider (Charmbracelet's Crush TUI coding agent).
 *
 * Crush keeps a registry of every project it touched and one SQLite database per project:
 *   registry: `$CRUSH_GLOBAL_DATA/projects.json`, else
 *             `~/.local/share/crush/projects.json` (XDG_DATA_HOME honored),
 *             Windows `%LOCALAPPDATA%\crush\projects.json`
 *   project db: `<project.path>/<project.data_dir>/crush.db` (data_dir defaults to `.crush`)
 *
 * The `sessions` table already holds per-session aggregate usage:
 *   prompt_tokens, completion_tokens, cost (USD), created_at, updated_at,
 *   parent_session_id, message_count
 * Timestamps are Unix *seconds* (`strftime('%s','now')`) despite the upstream migration
 * comments claiming milliseconds. The dominant model comes from `messages.model`.
 * Cache tokens and reasoning are not recorded by Crush.
 *
 * NOT VERIFIED ON THIS MACHINE: Crush is not installed here; schema follows the verified
 * charmbracilet/crush v0.66 migrations.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'crush',
  name: 'Crush',
  color: '#ec4899',
  homepage: 'https://github.com/charmbracelet/crush',
  cacheVersion: 1,
};

/** @param {unknown} value @returns {number} */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** @param {unknown} value @returns {number} */
function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Crush timestamps are Unix seconds; tolerate millisecond rows as well.
 * @param {unknown} value
 * @returns {number}
 */
function toTs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? number * 1000 : number;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function registries(ctx) {
  const { utils, env } = ctx;
  const override = utils.expandPath(process.env.CRUSH_GLOBAL_DATA || '');
  if (override) return [join(override, 'projects.json')];
  const paths = [];
  if (env.platform === 'win32' && env.localAppData) paths.push(join(env.localAppData, 'crush', 'projects.json'));
  paths.push(join(env.xdgData, 'crush', 'projects.json'));
  return [...new Set(paths)];
}

/**
 * @param {any} parsed
 * @returns {{path: string, dataDir: string}[]}
 */
function projectEntries(parsed) {
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    list = Array.isArray(parsed.projects) ? parsed.projects : Object.values(parsed);
  }
  if (!list) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const projectPath = typeof entry.path === 'string' ? entry.path : '';
    if (projectPath === '') continue;
    const dataDir = typeof entry.data_dir === 'string' && entry.data_dir !== '' ? entry.data_dir : '.crush';
    out.push({ path: projectPath, dataDir });
  }
  return out;
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
  let found = false;
  let foundDb = false;

  for (const registryPath of registries(ctx)) {
    const stat = await utils.statSafe(registryPath);
    if (stat === null || !stat.isFile) continue;
    found = true;
    const raw = await utils.readText(registryPath);
    const entries = projectEntries(utils.safeJsonParse(raw || ''));
    let dbCount = 0;

    for (const entry of entries) {
      const projectDataDir = isAbsolute(entry.dataDir) ? entry.dataDir : resolve(entry.path, entry.dataDir);
      const dbPath = join(projectDataDir, 'crush.db');
      const dbStat = await utils.statSafe(dbPath);
      if (dbStat === null || !dbStat.isFile) continue;
      foundDb = true;
      dbCount += 1;
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
            const columns = new Set(
              utils.querySqlite(db, "SELECT name FROM pragma_table_info('sessions')").map((row) => String(row.name)),
            );
            if (!columns.has('prompt_tokens') && !columns.has('completion_tokens')) {
              ctx.warn('Crush: unrecognized sessions schema in ' + dbPath);
            } else {
              const wanted = [
                'id',
                'prompt_tokens',
                'completion_tokens',
                'cost',
                'created_at',
                'updated_at',
                'parent_session_id',
                'message_count',
              ].filter((name) => columns.has(name));
              const rows = utils.querySqlite(db, `SELECT ${wanted.map((name) => `"${name}"`).join(', ')} FROM sessions`);
              for (const row of rows) {
                if (columns.has('parent_session_id') && row.parent_session_id !== null && row.parent_session_id !== undefined && row.parent_session_id !== '') {
                  // Child/sub-agent sessions inherit cost into the parent.
                  continue;
                }
                const input = num(row.prompt_tokens);
                const output = num(row.completion_tokens);
                if (input + output === 0) continue;
                let model = 'unknown';
                try {
                  const modelRows = utils.querySqlite(
                    db,
                    "SELECT model FROM messages WHERE session_id = ? AND model IS NOT NULL AND model <> '' GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1",
                    [row.id],
                  );
                  if (modelRows.length > 0 && typeof modelRows[0].model === 'string') model = modelRows[0].model;
                } catch {
                  // messages table may be missing; keep 'unknown'
                }
                const ts = toTs(row.updated_at) || toTs(row.created_at) || dbStat.mtimeMs;
                addUsage(byKey, {
                  model,
                  day: utils.localDay(ts),
                  ts,
                  input,
                  output,
                  cacheRead: 0,
                  cacheWrite: 0,
                  costUsd: positive(row.cost) || undefined,
                  messages: num(row.message_count) || 1,
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
          ctx.warn(`Crush: cannot read ${dbPath}: ${error?.message || error}`);
        }
        dbCells = finalizeCells([...byKey.values()]);
        cache.set(dbPath, fingerprint, dbCells);
      }
      if (dbCells.length > 0) allCells.push(...dbCells);
      sources.push({
        label: 'Crush project database',
        path: dbPath,
        exists: true,
        files: sessionRows > 0 ? sessionRows : 1,
        bytes,
        note:
          (dbCells.length > 0
            ? 'sessions.prompt_tokens/completion_tokens/cost; model from messages.model'
            : 'crush.db found but no session carried token usage') + '; schema unverified on this machine',
      });
    }

    sources.push({
      label: 'Crush project registry',
      path: registryPath,
      exists: true,
      files: dbCount,
      bytes: stat.size,
      note: dbCount === 0 ? 'registry lists no project with a readable crush.db' : 'lists Crush projects and their data dirs',
    });
    if (!foundDb) {
      sources.push({
        label: 'Crush project database',
        path: join(env.home, '.crush', 'crush.db'),
        exists: false,
        files: 0,
        bytes: 0,
        note: 'registry exists but no project crush.db was found; parser unverified on this machine',
      });
    }
  }

  // Fallback for Crush builds that keep one global database instead of the registry layout.
  if (!foundDb) {
    const roots = [];
    const override = utils.expandPath(process.env.CRUSH_GLOBAL_DATA || '');
    if (override) roots.push(override);
    if (env.platform === 'win32' && env.localAppData) roots.push(join(env.localAppData, 'crush'));
    roots.push(join(env.xdgData, 'crush'));
    for (const root of [...new Set(roots)]) {
      const dbPath = join(root, 'crush.db');
      const dbStat = await utils.statSafe(dbPath);
      if (dbStat === null || !dbStat.isFile) continue;
      found = true;
      foundDb = true;
      const walStat = await utils.statSafe(`${dbPath}-wal`);
      const fingerprint = `${dbStat.size}:${Math.round(dbStat.mtimeMs)}` + (walStat ? `|${walStat.size}:${Math.round(walStat.mtimeMs)}` : '');
      let dbCells = cache.get(dbPath, fingerprint);
      if (!dbCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        try {
          const db = await utils.openSqliteDatabase(dbPath, { readOnly: true });
          try {
            const columns = new Set(utils.querySqlite(db, "SELECT name FROM pragma_table_info('sessions')").map((row) => String(row.name)));
            if (columns.has('prompt_tokens') || columns.has('completion_tokens')) {
              const wanted = ['id', 'prompt_tokens', 'completion_tokens', 'cost', 'created_at', 'updated_at', 'parent_session_id', 'message_count'].filter((name) => columns.has(name));
              const rows = utils.querySqlite(db, `SELECT ${wanted.map((name) => `"${name}"`).join(', ')} FROM sessions`);
              for (const row of rows) {
                if (columns.has('parent_session_id') && row.parent_session_id !== null && row.parent_session_id !== undefined && row.parent_session_id !== '') continue;
                const input = num(row.prompt_tokens);
                const output = num(row.completion_tokens);
                if (input + output === 0) continue;
                let model = 'unknown';
                try {
                  const modelRows = utils.querySqlite(db, "SELECT model FROM messages WHERE session_id = ? AND model IS NOT NULL AND model <> '' GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1", [row.id]);
                  if (modelRows.length > 0 && typeof modelRows[0].model === 'string') model = modelRows[0].model;
                } catch {
                  // ignore
                }
                const ts = toTs(row.updated_at) || toTs(row.created_at) || dbStat.mtimeMs;
                addUsage(byKey, { model, day: utils.localDay(ts), ts, input, output, cacheRead: 0, cacheWrite: 0, costUsd: positive(row.cost) || undefined, messages: num(row.message_count) || 1 });
              }
            }
          } finally {
            try { db.close(); } catch { /* ignore */ }
          }
        } catch (error) {
          ctx.warn(`Crush: cannot read ${dbPath}: ${error?.message || error}`);
        }
        dbCells = finalizeCells([...byKey.values()]);
        cache.set(dbPath, fingerprint, dbCells);
      }
      if (dbCells.length > 0) allCells.push(...dbCells);
      sources.push({
        label: 'Crush sessions database',
        path: dbPath,
        exists: true,
        files: dbCells.reduce((sum, cell) => sum + (cell.messages || 0), 0) || 1,
        bytes: dbStat.size + (walStat?.size || 0),
        note: (dbCells.length > 0 ? 'global crush.db sessions table; schema unverified on this machine' : 'crush.db found but no usage rows'),
      });
    }
  }

  if (!found) {
    sources.push({
      label: 'Crush project registry',
      path: registries(ctx)[0],
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Crush is not installed on this machine (or CRUSH_GLOBAL_DATA points elsewhere); parser unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
