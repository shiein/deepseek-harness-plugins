/**
 * Zed agent-panel usage provider.
 *
 * Zed persists agent threads in a single SQLite database:
 *   macOS:   ~/Library/Application Support/Zed/threads/threads.db
 *   Windows: %LOCALAPPDATA%\Zed\threads\threads.db
 *   Linux:   $XDG_DATA_HOME/zed/threads/threads.db (defaults to ~/.local/share)
 *
 * The `threads` table has one row per thread: (id, summary, updated_at, data_type, data,
 * created_at, ...). `data` is either raw UTF-8 JSON (`data_type = 'json'`) or a zstd frame
 * (`data_type = 'zstd'`). The thread JSON carries:
 *
 *   model: { provider: 'zed.dev' | 'anthropic' | ..., model: 'gpt-5.5' }
 *   request_token_usage: { <request-id>: { input_tokens, output_tokens,
 *                                          cache_read_input_tokens, cache_creation_input_tokens } }
 *   cumulative_token_usage: { input_tokens, output_tokens, ... }
 *   imported: boolean
 *   updated_at: ISO timestamp
 *
 * `request_token_usage` is the per-request breakdown (summed here); `cumulative_token_usage`
 * is the fallback when the per-request map is empty. Imported threads are skipped because
 * their usage was produced by another agent and is reported by that agent's own provider.
 * Zed writes no per-request timestamps, so all requests in a thread are attributed to the
 * thread's `updated_at` day (documented limitation).
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'zed',
  name: 'Zed',
  color: '#3b82f6',
  homepage: 'https://zed.dev',
  cacheVersion: 1,
};

const MAX_THREAD_JSON_BYTES = 32 * 1024 * 1024;

/**
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {import('../scanner-types.js').ScanContext['utils']} utils
 * @returns {string[]}
 */
function databaseCandidates(env, utils) {
  if (env.platform === 'win32') {
    const local = env.localAppData || utils.joinPath(env.home, 'AppData', 'Local');
    return [utils.joinPath(local, 'Zed', 'threads', 'threads.db')];
  }
  if (env.platform === 'darwin') {
    return [utils.joinPath(env.home, 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')];
  }
  return [utils.joinPath(env.xdgData, 'zed', 'threads', 'threads.db')];
}

/** @param {number|string|undefined} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

/** @param {any} value @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}} */
function readUsage(value) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!value || typeof value !== 'object') return usage;
  usage.input = toCount(value.input_tokens);
  usage.output = toCount(value.output_tokens);
  usage.cacheRead = toCount(value.cache_read_input_tokens);
  usage.cacheWrite = toCount(value.cache_creation_input_tokens);
  return usage;
}

/** @param {any} value @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}} */
function sumRequestUsage(value) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!value) return total;
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.values(value)
      : [];
  for (const entry of entries) {
    const usage = readUsage(entry);
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
  }
  return total;
}

/** @param {number} total @returns {boolean} */
function hasTokens(total) {
  return total.input + total.output + total.cacheRead + total.cacheWrite > 0;
}

/**
 * Decode a thread row's `data` column to JSON text.
 * @param {import('../scanner-types.js').ScanContext['utils']} utils
 * @param {string} dataType
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function decodeThreadData(utils, dataType, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const type = String(dataType || '').trim().toLowerCase();
  if (type === 'json') {
    if (buffer.length > MAX_THREAD_JSON_BYTES) return null;
    return buffer.toString('utf8');
  }
  if (type === 'zstd' || utils.isZstd(buffer)) {
    if (buffer.length > MAX_THREAD_JSON_BYTES) return null;
    try {
      return utils.zstdDecompressAll(buffer).toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} path
 * @returns {Promise<{cells: import('../scanner-types.js').Cell[], threads: number, parsed: number}>}
 */
async function scanDatabase(ctx, path) {
  const { utils, cache } = ctx;
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${path}${suffix}`);
    if (stat && stat.isFile) parts.push(`${stat.size}:${Math.round(stat.mtimeMs)}`);
    else if (suffix === '') return { cells: [], threads: 0, parsed: 0 };
    else parts.push('-');
  }
  const fingerprint = parts.join('|');
  const cached = cache.get(path, fingerprint);
  if (cached) {
    return { cells: cached, threads: cached.length > 0 ? -1 : 0, parsed: -1 };
  }

  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];
  const fileStat = await utils.statSafe(path);
  if (!fileStat || !fileStat.isFile) return { cells, threads: 0, parsed: 0 };

  let db = null;
  let threads = 0;
  let parsed = 0;
  try {
    db = await utils.openSqliteDatabase(path, { readOnly: true });
    const columns = new Set(
      utils
        .querySqlite(db, 'PRAGMA table_info(threads)')
        .map((row) => String(row?.name || ''))
        .filter(Boolean),
    );
    if (!columns.has('data')) return { cells, threads: 0, parsed: 0 };
    const optional = (name) => (columns.has(name) ? name : `NULL AS ${name}`);
    const updatedAt = columns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';
    const rows = utils.querySqlite(
      db,
      `SELECT id, ${updatedAt}, ${optional('data_type')}, data, ${optional('created_at')}, ${optional('imported')} FROM threads`,
    );

    /** @type {Map<string, import('../scanner-types.js').Cell>} */
    const byKey = new Map();
    for (const row of rows) {
      if (ctx.signal.aborted) break;
      threads += 1;
      const text = decodeThreadData(utils, row?.data_type, row?.data ? Buffer.from(row.data) : null);
      if (!text) continue;
      let thread;
      try {
        thread = JSON.parse(text);
      } catch {
        continue;
      }
      if (!thread || typeof thread !== 'object') continue;
      if (thread.imported === true) continue;
      const model = thread.model && typeof thread.model === 'object' ? thread.model : null;
      const modelId = typeof model?.model === 'string' ? model.model.trim() : '';
      if (!modelId) continue;

      let usage = sumRequestUsage(thread.request_token_usage);
      let messages = 0;
      if (hasTokens(usage)) {
        const iter = Array.isArray(thread.request_token_usage)
          ? thread.request_token_usage
          : Object.values(thread.request_token_usage || {});
        for (const entry of iter) {
          const one = readUsage(entry);
          if (hasTokens(one)) messages += 1;
        }
      } else {
        usage = readUsage(thread.cumulative_token_usage);
        messages = hasTokens(usage) ? 1 : 0;
      }
      if (!hasTokens(usage)) continue;

      let timestamp = Date.parse(String(thread.updated_at ?? row?.updated_at ?? ''));
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        timestamp = Date.parse(String(thread.created_at ?? row?.created_at ?? ''));
      }
      if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = fileStat.mtimeMs;
      parsed += 1;

      const day = utils.localDay(timestamp);
      const key = `${modelId}\u0000${day}`;
      let cell = byKey.get(key);
      if (!cell) {
        cell = {
          model: modelId,
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
      cell.input += usage.input;
      cell.output += usage.output;
      cell.cacheRead += usage.cacheRead;
      cell.cacheWrite += usage.cacheWrite;
      cell.messages += messages;
      if (timestamp < cell.firstTs) cell.firstTs = timestamp;
      if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    }
    cells.push(...byKey.values());
  } catch {
    return { cells: [], threads, parsed: 0 };
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
  return { cells, threads, parsed };
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

  let found = false;
  for (const path of databaseCandidates(env, utils)) {
    const stat = await utils.statSafe(path);
    if (!stat || !stat.isFile) {
      sources.push({ label: 'Zed agent threads', path, exists: false, files: 0, bytes: 0 });
      continue;
    }
    found = true;
    const result = await scanDatabase(ctx, path);
    cells.push(...result.cells);
    sources.push({
      label: 'Zed agent threads',
      path,
      exists: true,
      files: result.threads > 0 || result.cells.length > 0 ? 1 : 0,
      bytes: stat.size,
      note: 'threads.db; per-thread request_token_usage (zstd/json payloads)',
    });
    if (result.parsed === 0) {
      ctx.warn('Zed: threads.db contains no readable request_token_usage');
    }
  }
  if (!found) return { sources, cells: mergeProviderCells(cells) };
  return { sources, cells: mergeProviderCells(cells) };
}
