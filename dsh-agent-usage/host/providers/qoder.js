/**
 * Qoder usage provider.
 *
 * Qoder (and Qoder CN) is a VS Code-derived IDE whose agent usage lives in a single SQLite
 * cache database, not in `state.vscdb`:
 *   macOS:   ~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db
 *   Windows: %APPDATA%\Qoder\SharedClientCache\cache\db\local.db
 *   Linux:   ~/.config/Qoder/SharedClientCache/cache/db/local.db
 *
 * Verified schema (shared with Token Tracker's Qoder reader):
 *   chat_message(id, session_id, request_id, role, token_info, model_info, gmt_create, ...)
 *   chat_record(request_id, extra, ...)
 *   chat_session(session_id, preferred_model_info, project_uri, ...)
 *
 * Only assistant rows with a non-empty `token_info` JSON object are read:
 *   token_info = { "prompt_tokens": n, "cached_tokens": n, "completion_tokens": n }
 * `prompt_tokens` INCLUDES the cached prefix, so uncached input = prompt - cached.
 * Model: model_info.model_key (fallbacks: chat_record.extra.modelConfig.key,
 * chat_session.preferred_model_info.model_key).
 *
 * Qoder's local history is also reachable through its account/cloud services; this module
 * deliberately reads only the local database and never estimates missing tokens.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'qoder',
  name: 'Qoder',
  color: '#6366f1',
  homepage: 'https://qoder.com',
  cacheVersion: 1,
};

const APP_DIRS = ['Qoder', 'Qoder CN'];

/** @param {import('../scanner-types.js').ScanContext['env']} env @param {any} utils */
function databaseCandidates(env, utils) {
  /** @type {string[]} */
  const roots = [];
  for (const app of APP_DIRS) {
    if (env.platform === 'win32') {
      roots.push(utils.joinPath(env.appData, app));
    } else if (env.platform === 'darwin') {
      roots.push(utils.joinPath(env.home, 'Library', 'Application Support', app));
    } else {
      roots.push(utils.joinPath(env.home, '.config', app));
    }
  }
  return roots.map((root) => utils.joinPath(root, 'SharedClientCache', 'cache', 'db', 'local.db'));
}

/** @param {unknown} value @returns {number|null} epoch ms */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return coerceEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** @param {unknown} raw @returns {Record<string, any>|null} */
function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return /** @type {Record<string, any>} */ (raw);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {string|null} */
function cleanModel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text === '-' ? null : text;
}

/**
 * Qoder's token_info carries the last request's usage: prompt_tokens includes cached_tokens.
 * @param {unknown} tokenInfo
 * @returns {{input: number, cacheRead: number, output: number}|null}
 */
function normalizeTokens(tokenInfo) {
  const tokens = parseJsonObject(tokenInfo);
  if (!tokens) return null;
  const prompt = Number(tokens.prompt_tokens);
  const cached = Number(tokens.cached_tokens ?? 0);
  const completion = Number(tokens.completion_tokens);
  if (![prompt, cached, completion].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const cacheRead = Math.min(Math.trunc(prompt), Math.trunc(cached));
  return {
    input: Math.max(0, Math.trunc(prompt) - cacheRead),
    cacheRead,
    output: Math.trunc(completion),
  };
}

/** @param {Record<string, any>} row @returns {string} */
function modelFromRow(row) {
  const modelInfo = parseJsonObject(row.model_info);
  const recordExtra = parseJsonObject(row.record_extra);
  const preferred = parseJsonObject(row.preferred_model_info);
  return (
    cleanModel(modelInfo?.model_key) ||
    cleanModel(modelInfo?.modelKey) ||
    cleanModel(recordExtra?.modelConfig?.key) ||
    cleanModel(recordExtra?.model_config?.key) ||
    cleanModel(preferred?.model_key) ||
    cleanModel(preferred?.modelKey) ||
    cleanModel(preferred?.preferred_model) ||
    cleanModel(preferred?.preferredModel) ||
    'qoder-agent'
  );
}

/** @param {string} path @returns {Promise<string>} */
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
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} path
 * @returns {Promise<{cells: import('../scanner-types.js').Cell[]|null, unsupported: boolean}>}
 */
async function scanDatabase(ctx, path) {
  const { utils, cache } = ctx;
  const fingerprint = await sqliteFingerprint(utils, path);
  if (fingerprint === '') return { cells: null, unsupported: false };
  const cached = cache.get(path, fingerprint);
  if (cached) return { cells: cached, unsupported: false };

  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];
  let db = null;
  try {
    db = await utils.openSqliteDatabase(path, { readOnly: true });
    const tables = new Set(
      utils
        .querySqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row?.name || '')),
    );
    if (!tables.has('chat_message')) return { cells: null, unsupported: true };

    const rows = utils.querySqlite(
      db,
      `SELECT cm.rowid AS row_id, cm.id, cm.session_id, cm.request_id, cm.token_info,
              cm.model_info, cm.gmt_create, cr.extra AS record_extra,
              cs.preferred_model_info, cs.project_uri
         FROM chat_message AS cm
         LEFT JOIN chat_record AS cr ON cr.request_id = cm.request_id
         LEFT JOIN chat_session AS cs ON cs.session_id = cm.session_id
        WHERE cm.role = 'assistant'
          AND cm.token_info IS NOT NULL
        ORDER BY cm.gmt_create, cm.rowid`,
    );

    /** @type {Map<string, import('../scanner-types.js').Cell>} */
    const byKey = new Map();
    const seenMessages = new Set();
    const seenRequests = new Set();
    for (const row of rows) {
      if (ctx.signal.aborted) break;
      const tokens = normalizeTokens(row?.token_info);
      if (!tokens) continue;
      const timestamp = coerceEpochMs(row?.gmt_create);
      if (!timestamp) continue;
      const messageKey = `${row?.session_id ?? ''}\u0000${row?.id ?? `row:${row?.row_id}`}`;
      if (seenMessages.has(messageKey)) continue;
      seenMessages.add(messageKey);
      // A request is counted once even if Qoder attached token_info to several assistant rows.
      const requestKey = String(row?.request_id ?? '') || messageKey;
      if (seenRequests.has(requestKey)) continue;
      seenRequests.add(requestKey);

      const model = modelFromRow(/** @type {Record<string, any>} */ (row));
      const day = utils.localDay(timestamp);
      const key = `${model}\u0000${day}`;
      let cell = byKey.get(key);
      if (!cell) {
        cell = {
          model,
          day,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          messages: 0,
          firstTs: timestamp,
          lastTs: timestamp,
        };
        byKey.set(key, cell);
      }
      cell.input += tokens.input;
      cell.cacheRead += tokens.cacheRead;
      cell.output += tokens.output;
      cell.messages += 1;
      if (timestamp < cell.firstTs) cell.firstTs = timestamp;
      if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    }
    cells.push(...byKey.values());
  } catch {
    return { cells: null, unsupported: false };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  cache.set(path, fingerprint, cells);
  return { cells, unsupported: false };
}

/**
 * Merge cells so one bucket per (model, local day) is returned to the framework.
 * @param {import('../scanner-types.js').Cell[]} cells
 * @returns {import('../scanner-types.js').Cell[]}
 */
function mergeProviderCells(cells) {
  /** @type {Map<string, import('../scanner-types.js').Cell>} */
  const map = new Map();
  for (const cell of cells) {
    const key = `${cell.model}\u0000${cell.day}`;
    const target = map.get(key);
    if (!target) {
      map.set(key, { ...cell });
      continue;
    }
    target.input += cell.input;
    target.output += cell.output;
    target.cacheRead += cell.cacheRead;
    target.cacheWrite += cell.cacheWrite;
    target.messages += cell.messages;
    if (cell.reasoning) target.reasoning = (target.reasoning || 0) + cell.reasoning;
    if (typeof cell.costUsd === 'number') target.costUsd = (target.costUsd || 0) + cell.costUsd;
    if (typeof cell.firstTs === 'number' && (target.firstTs === undefined || cell.firstTs < target.firstTs)) {
      target.firstTs = cell.firstTs;
    }
    if (typeof cell.lastTs === 'number' && (target.lastTs === undefined || cell.lastTs > target.lastTs)) {
      target.lastTs = cell.lastTs;
    }
  }
  return [...map.values()];
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];

  const candidates = databaseCandidates(env, utils);
  let found = false;
  let unsupported = false;
  for (const path of candidates) {
    const stat = await utils.statSafe(path);
    if (!stat || !stat.isFile) {
      sources.push({ label: 'Qoder agent cache', path, exists: false, files: 0, bytes: 0 });
      continue;
    }
    found = true;
    const result = await scanDatabase(ctx, path);
    if (result.unsupported) unsupported = true;
    if (result.cells) cells.push(...result.cells);
    sources.push({
      label: 'Qoder agent cache',
      path,
      exists: true,
      files: 1,
      bytes: stat.size,
      note: 'SharedClientCache/local.db; assistant token_info JSON',
    });
  }

  if (!found) return { sources, cells: mergeProviderCells(cells) };
  if (unsupported) {
    ctx.warn('Qoder: local.db has an unsupported schema (chat_message table missing)');
  } else if (cells.length === 0) {
    ctx.warn('Qoder: local.db was found but contains no assistant token_info usage');
  }
  return { sources, cells: mergeProviderCells(cells) };
}
