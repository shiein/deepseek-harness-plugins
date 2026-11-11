/**
 * Devin usage provider.
 *
 * Devin CLI (the Windsurf-derived desktop app is separate and hides usage) persists its own
 * session store under the XDG data dir:
 *
 *   macOS / Linux: ~/.local/share/devin/cli/sessions.db   (+ -wal, often several GB)
 *   Windows:       %APPDATA%\devin\cli\sessions.db        (Roaming; shares the Desktop product dir)
 *                  %LOCALAPPDATA%\devin\cli\sessions.db  (CLI binaries live here, data normally does not)
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
 * not silently mis-bucket days). When sessions.db (or its WAL) changed, only rows above the last
 * processed row_id are read and folded into the cached per-message state (see updateState); a
 * full pass over the multi-GB table happens only on the first scan or after old rows were removed.
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
  // v4: per-message resume state for incremental scans (see updateState).
  cacheVersion: 4,
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
    // Observed on Windows: the CLI writes its data under the Roaming product dir (`devin`,
    // shared with the desktop app), while %LOCALAPPDATA%\devin only holds the binaries.
    // Do not add a `Devin` casing variant: both spellings resolve to the same directory on
    // case-insensitive volumes and the same sessions.db would be counted twice.
    if (env.appData) roots.push(utils.joinPath(env.appData, 'devin'));
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
  if (env.platform === 'win32') return [utils.joinPath(env.appData, 'devin')];
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

const STATE_FORMAT = 1;

/**
 * Batch extraction: every metrics-bearing row in (fromRow, toRow], already folded per message id
 * inside SQLite. Folding with MAX is associative, so merging batch results into the persisted
 * per-message state gives exactly what one GROUP BY over the whole table would.
 */
const BATCH_SQL = `
  SELECT message_id,
         MAX(model) AS model,
         MAX(input_tokens) AS input_tokens,
         MAX(output_tokens) AS output_tokens,
         MAX(cache_read_tokens) AS cache_read_tokens,
         MAX(cache_creation_tokens) AS cache_creation_tokens,
         MAX(observed_at) AS observed_at
  FROM (
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
    WHERE row_id > ? AND row_id <= ?
      AND json_extract(chat_message, '$.metadata.metrics') IS NOT NULL
  )
  GROUP BY message_id
`;

/**
 * @typedef {[string|null, string, string|null, number|null, number|null, number|null, number|null]} MessageTuple
 *   [messageId, model, observedAt, input, output, cacheRead, cacheWrite] — MAX-folded per message id
 */

/**
 * @typedef {Object} DevinState
 * @property {number} format
 * @property {number} watermark        highest row_id folded into `messages`
 * @property {number} rowsAtWatermark  COUNT(*) of all message_nodes rows with row_id <= watermark
 * @property {MessageTuple[]} messages
 */

/** @param {unknown} state @returns {state is DevinState} */
function isUsableState(state) {
  return Boolean(state && typeof state === 'object'
    && /** @type {any} */ (state).format === STATE_FORMAT
    && Number.isInteger(/** @type {any} */ (state).watermark)
    && Number.isInteger(/** @type {any} */ (state).rowsAtWatermark)
    && Array.isArray(/** @type {any} */ (state).messages));
}

/** SQL MAX semantics: NULL loses to any value. @param {any} a @param {any} b */
function maxOf(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return b > a ? b : a;
}

/**
 * Bring the per-message state up to date with sessions.db.
 *
 * `message_nodes.row_id` is AUTOINCREMENT and Devin appends rows (a re-stored response is a new,
 * later row with the same message id), so only rows above the stored watermark need reading. Old
 * rows disappearing (a deleted session) is detected exactly — total row count minus the new rows
 * must still equal the count recorded at the watermark — and forces a full rebuild, because the
 * removed rows' contributions cannot be subtracted from MAX-folded state. Every statement runs in
 * one read transaction so the counts and the batch see the same snapshot while Devin keeps writing.
 *
 * @param {any} utils
 * @param {string} databasePath
 * @param {unknown} previous
 * @returns {Promise<{state: DevinState, mode: 'full'|'incremental', reason: string, rows: number}>}
 */
async function updateState(utils, databasePath, previous) {
  const db = await utils.openSqliteDatabase(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    try {
      const maxRow = Number(db.prepare('SELECT COALESCE(MAX(row_id), 0) AS m FROM message_nodes').get().m);
      const totalRows = Number(db.prepare('SELECT COUNT(*) AS c FROM message_nodes').get().c);
      let base = isUsableState(previous) ? previous : null;
      let reason = base ? '' : 'no previous state';
      if (base !== null) {
        if (maxRow < base.watermark) {
          base = null;
          reason = 'database shrank below the watermark';
        } else {
          const newRows = Number(db.prepare('SELECT COUNT(*) AS c FROM message_nodes WHERE row_id > ?').get(base.watermark).c);
          if (totalRows - newRows !== base.rowsAtWatermark) {
            base = null;
            reason = 'rows below the watermark were removed';
          }
        }
      }
      const fromRow = base ? base.watermark : 0;
      /** @type {Map<string|null, MessageTuple>} */
      const messages = new Map((base ? base.messages : []).map((tuple) => [tuple[0], tuple]));
      const batch = fromRow < maxRow ? db.prepare(BATCH_SQL).all(fromRow, maxRow) : [];
      for (const row of batch) {
        const id = row.message_id === undefined ? null : /** @type {string|null} */ (row.message_id);
        const prior = messages.get(id);
        /** @type {MessageTuple} */
        const next = [
          id,
          String(maxOf(prior?.[1], row.model) ?? 'unknown'),
          /** @type {string|null} */ (maxOf(prior?.[2], row.observed_at)),
          /** @type {number|null} */ (maxOf(prior?.[3], row.input_tokens)),
          /** @type {number|null} */ (maxOf(prior?.[4], row.output_tokens)),
          /** @type {number|null} */ (maxOf(prior?.[5], row.cache_read_tokens)),
          /** @type {number|null} */ (maxOf(prior?.[6], row.cache_creation_tokens)),
        ];
        messages.set(id, next);
      }
      db.exec('COMMIT');
      return {
        state: { format: STATE_FORMAT, watermark: maxRow, rowsAtWatermark: totalRows, messages: [...messages.values()] },
        mode: base ? 'incremental' : 'full',
        reason,
        rows: batch.length,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The read transaction may never have started.
      }
      throw error;
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * @param {any} utils
 * @param {DevinState} state
 * @returns {any[]}
 */
function cellsFromState(utils, state) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const [, model, observedAt, input, output, cacheRead, cacheWrite] of state.messages) {
    if (observedAt === null) continue;
    const ts = Date.parse(String(observedAt));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    addUsage(byKey, {
      model: String(model || 'unknown'),
      day: utils.localDay(ts),
      ts,
      input: num(input),
      output: num(output),
      cacheRead: num(cacheRead),
      cacheWrite: num(cacheWrite),
      messages: 1,
    });
  }
  return finalizeCells([...byKey.values()]);
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
    let note = 'message_nodes metrics, deduplicated by message id; unchanged since last scan';
    if (!cells) {
      const previous = typeof cache.peek === 'function' ? cache.peek(databasePath)?.state : undefined;
      let updated;
      try {
        updated = await updateState(utils, databasePath, previous);
      } catch (error) {
        // Raw SQLite text ("database or disk is full") says nothing about which store failed; the
        // scanner reports this line in the source list, so name the file.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${databasePath}: ${detail}`, { cause: error });
      }
      cells = cellsFromState(utils, updated.state);
      cache.set(databasePath, fingerprint, cells, updated.state);
      note = updated.mode === 'incremental'
        ? `message_nodes metrics, deduplicated by message id; incremental: ${updated.rows} new message(s)`
        : `message_nodes metrics, deduplicated by message id; full rebuild (${updated.reason})`;
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
      note,
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

/** Internals exposed for host/tools/devin-incremental.mjs; not part of the provider contract. */
export const __test = { updateState, cellsFromState, BATCH_SQL };
