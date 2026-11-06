/**
 * Devin usage provider.
 *
 * Devin CLI (the Windsurf-derived desktop app is separate and hides usage) persists its own
 * session store under the XDG data dir:
 *
 *   macOS / Linux: ~/.local/share/devin/cli/sessions.db   (+ -wal, often several GB)
 *   Windows:       %LOCALAPPDATA%\devin\cli\sessions.db
 *                  %USERPROFILE%\.local\share\devin\cli\sessions.db
 *
 * The `message_nodes` table stores each ACP message as JSON. Assistant responses carry the
 * generation metrics under `chat_message.metadata`:
 *
 *   { "num_tokens": 101,
 *     "request_id": "47429a8a-…",
 *     "generation_model": "claude-sonnet-4-6",
 *     "started_generation_at": "2026-06-09T07:32:29.676699Z",
 *     "metrics": { "input_tokens": 3, "output_tokens": 101,
 *                  "cache_read_tokens": null, "cache_creation_tokens": 17074,
 *                  "context_input_tokens": …, "ttft_ms": … } }
 *
 * One response can be stored on more than one row (a later row adds `extensions`), so rows are
 * deduplicated by message id before summing — without this the totals inflate ~2.4x on this
 * machine. `input_tokens` is the uncached input (Anthropic semantics); cache reads/writes are
 * separate counters.
 *
 * Aggregation runs inside SQLite (`json_extract`) so the multi-GB JSON is never transferred to
 * Node; only the ~50k de-duplicated `{model, observed_at, metrics}` rows cross the boundary, and
 * local-day bucketing happens in JS (`utils.localDay`). No SQLite `localtime` modifier is used
 * (it is unavailable when SQLite is built with SQLITE_OMIT_LOCALTIME, and Windows time zones must
 * not silently mis-bucket days). The result is cached per database fingerprint and only
 * re-computed when sessions.db (or its WAL) changed.
 *
 * Fallbacks: if the CLI database is absent, `cli/transcripts/*.json` (ATIF exports) carry one
 * `final_metrics` block per session and are parsed instead. The desktop app stores ACP messages
 * without token counters and its Cascade `.pb` files are encrypted, so it is reported as
 * detected-but-unavailable rather than guessed.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'devin',
  name: 'Devin',
  color: '#7c6bf5',
  homepage: 'https://devin.ai',
  cacheVersion: 3,
};

/**
 * Candidate CLI data directories, most specific first.
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {string[]}
 */
function cliDataRoots(env, utils) {
  const roots = [];
  if (process.env.DEVIN_DATA_DIR) roots.push(process.env.DEVIN_DATA_DIR);
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
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {string[]}
 */
function desktopRoots(env, utils) {
  if (env.platform === 'win32') return [utils.joinPath(env.appData, 'Devin')];
  if (env.platform === 'darwin') return [utils.joinPath(env.home, 'Library', 'Application Support', 'Devin')];
  return [utils.joinPath(env.appData, 'Devin')];
}

/**
 * Fingerprint the SQLite database together with its write-ahead log. `-shm` only contributes its
 * size: opening a WAL database read-only bumps that file's mtime on this platform, which would
 * defeat the cache on every scan.
 * @param {any} utils
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
 * Aggregate every recorded generation, de-duplicated by message id, into (model, local day) cells.
 * Runs entirely inside SQLite.
 * @param {any} utils
 * @param {string} databasePath
 * @returns {Promise<any[]>}
 */
async function aggregateSessionsDatabase(utils, databasePath) {
  /** @type {any} */
  let db = null;
  try {
    db = await utils.openSqliteDatabase(databasePath, { readOnly: true });
    return utils.querySqlite(
      db,
      `
      WITH extracted AS (
        SELECT
          json_extract(chat_message, '$.message_id') AS message_id,
          COALESCE(
            NULLIF(json_extract(chat_message, '$.metadata.generation_model'), ''),
            NULLIF(json_extract(chat_message, '$.metadata.model'), ''),
            'unknown'
          ) AS model,
          CAST(json_extract(chat_message, '$.metadata.metrics.input_tokens') AS INTEGER) AS input_tokens,
          CAST(json_extract(chat_message, '$.metadata.metrics.output_tokens') AS INTEGER) AS output_tokens,
          CAST(json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS INTEGER) AS cache_read_tokens,
          CAST(json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS INTEGER) AS cache_creation_tokens,
          COALESCE(
            NULLIF(json_extract(chat_message, '$.metadata.started_generation_at'), ''),
            NULLIF(json_extract(chat_message, '$.metadata.created_at'), '')
          ) AS observed_at
        FROM message_nodes
        WHERE json_extract(chat_message, '$.metadata.metrics') IS NOT NULL
      ),
      deduped AS (
        SELECT message_id,
               MAX(model) AS model,
               MAX(input_tokens) AS input_tokens,
               MAX(output_tokens) AS output_tokens,
               MAX(cache_read_tokens) AS cache_read_tokens,
               MAX(cache_creation_tokens) AS cache_creation_tokens,
               MAX(observed_at) AS observed_at
        FROM extracted
        GROUP BY message_id
      )
      SELECT model,
             observed_at,
             COALESCE(input_tokens, 0) AS input_tokens,
             COALESCE(output_tokens, 0) AS output_tokens,
             COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
             COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens
      FROM deduped
      WHERE observed_at IS NOT NULL
      `,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Parse ATIF transcript exports (fallback when the CLI database is absent).
 * @param {any} utils
 * @param {string} directory
 * @param {AbortSignal} signal
 * @returns {Promise<{cells: any[], files: number, bytes: number}>}
 */
async function scanTranscripts(utils, directory, signal) {
  const files = await utils.listFilesRecursive(directory, { exts: ['.json'], signal, maxDepth: 2 });
  /** @type {Map<string, any>} */
  const byKey = new Map();
  let bytes = 0;
  let parsed = 0;
  for (const file of files) {
    bytes += file.size;
    const raw = await utils.readText(file.path);
    if (!raw) continue;
    const document = utils.safeJsonParse(raw);
    if (!document || typeof document !== 'object') continue;
    const metrics = document.final_metrics;
    if (!metrics || typeof metrics !== 'object') continue;
    const model =
      typeof document.agent?.model_name === 'string' && document.agent.model_name !== ''
        ? document.agent.model_name
        : 'unknown';
    const steps = Array.isArray(document.steps) ? document.steps : [];
    const first = steps.find((step) => step && typeof step.timestamp === 'string');
    let ts = first ? Date.parse(first.timestamp) : 0;
    if (!Number.isFinite(ts) || ts <= 0) {
      const stat = await utils.statSafe(file.path);
      ts = stat ? stat.mtimeMs : Date.now();
    }
    const totalPrompt = num(metrics.total_prompt_tokens);
    const cached = num(metrics.total_cached_tokens);
    addUsage(byKey, {
      model,
      day: utils.localDay(ts),
      ts,
      input: Math.max(0, totalPrompt - cached),
      output: num(metrics.total_completion_tokens),
      cacheRead: cached,
      messages: num(metrics.total_steps) || 1,
    });
    parsed += 1;
  }
  return { cells: finalizeCells([...byKey.values()]), files: parsed, bytes };
}

/** @param {unknown} value */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {any[]} */
  const allCells = [];

  const roots = cliDataRoots(env, utils);
  let foundCli = false;

  for (const root of roots) {
    const databasePath = join(root, 'cli', 'sessions.db');
    const databaseStat = await utils.statSafe(databasePath);
    if (databaseStat === null || !databaseStat.isFile) continue;
    foundCli = true;
    const fingerprint = await sqliteFingerprint(utils, databasePath);
    let cells = cache.get(databasePath, fingerprint);
    if (!cells) {
      const rows = await aggregateSessionsDatabase(utils, databasePath);
      /** @type {Map<string, any>} */
      const byKey = new Map();
      for (const row of rows) {
        const ts = Date.parse(String(row.observed_at || ''));
        if (!Number.isFinite(ts) || ts <= 0) continue;
        addUsage(byKey, {
          model: String(row.model || 'unknown'),
          day: utils.localDay(ts),
          ts,
          input: num(row.input_tokens),
          output: num(row.output_tokens),
          cacheRead: num(row.cache_read_tokens),
          cacheWrite: num(row.cache_creation_tokens),
          messages: 1,
        });
      }
      cells = finalizeCells([...byKey.values()]);
      cache.set(databasePath, fingerprint, cells);
    }
    allCells.push(...cells);

    let bytes = databaseStat.size;
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = await utils.statSafe(`${databasePath}${suffix}`);
      if (sidecar) bytes += sidecar.size;
    }
    sources.push({
      label: 'Devin CLI sessions',
      path: databasePath,
      exists: true,
      files: 1,
      bytes,
      note: 'message_nodes metrics, deduplicated by message id',
    });

    if (cells.length === 0) ctx.warn('Devin CLI: sessions.db found but no recorded generation metrics');
  }

  // Fallback: ATIF transcript exports.
  if (!foundCli) {
    for (const root of roots) {
      const transcripts = join(root, 'cli', 'transcripts');
      const stat = await utils.statSafe(transcripts);
      if (stat === null || !stat.isDirectory) continue;
      foundCli = true;
      const parsed = await scanTranscripts(utils, transcripts, ctx.signal);
      allCells.push(...parsed.cells);
      sources.push({
        label: 'Devin CLI transcripts',
        path: transcripts,
        exists: true,
        files: parsed.files,
        bytes: parsed.bytes,
        note: 'ATIF final_metrics per session',
      });
    }
  }

  // Desktop app: detected but not locally readable.
  for (const root of desktopRoots(env, utils)) {
    const acp = join(root, 'User', 'acp-messages');
    const acpStat = await utils.statSafe(acp);
    const state = join(root, 'User', 'globalStorage', 'state.vscdb');
    const stateStat = await utils.statSafe(state);
    if (acpStat === null && stateStat === null) continue;
    sources.push({
      label: 'Devin Desktop (ACP)',
      path: acpStat ? acp : state,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'desktop app persists messages and state but no token counters; usage is served remotely',
    });
    if (allCells.length === 0) {
      ctx.warn('Devin Desktop: local ACP/state stores carry no token usage; the Devin CLI store is required for local accounting');
    }
  }

  if (sources.length === 0) {
    sources.push({
      label: 'Devin CLI sessions',
      path: join(roots[0] || '~/.local/share/devin', 'cli', 'sessions.db'),
      exists: false,
      files: 0,
      bytes: 0,
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
