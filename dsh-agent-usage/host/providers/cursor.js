/**
 * Cursor usage provider.
 *
 * Cursor changed where it keeps chat data over time; both generations live in the same
 * VS Code-derived SQLite stores:
 *   macOS:   ~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}/state.vscdb
 *   Windows: %APPDATA%\Cursor\User\{globalStorage,workspaceStorage}\state.vscdb
 *   Linux:   ~/.config/Cursor/User/...
 *
 * Current Cursor writes cross-workspace chats into the `cursorDiskKV` table of the
 * globalStorage database (per-workspace chats stay in that workspace's state.vscdb):
 *   key = composerData:<composerId>          one conversation
 *         { modelConfig: { modelName }, createdAt, lastUpdatedAt, ... }
 *   key = bubbleId:<composerId>:<bubbleId>   one message
 *         { tokenCount: { inputTokens, outputTokens }, createdAt, modelInfo: { modelName }, ... }
 * Older builds stored an aichat/composer JSON blob under `ItemTable`; that path is parsed only
 * when no `cursorDiskKV` bubbles are available.
 *
 * IMPORTANT / verified limitation: on real Cursor installs the per-message tokenCount is
 * almost always zeroed (independent implementations report ~3 of 275 bubbles non-zero), and
 * Cursor's authoritative account usage is served by Cursor's dashboard API using the CLI
 * login — it is NOT stored locally. This provider therefore only reports tokenCount values
 * that genuinely exist, and warns that Cursor usage is otherwise remote-only.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'cursor',
  name: 'Cursor',
  color: '#64748b',
  homepage: 'https://cursor.com',
  cacheVersion: 1,
};

/**
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {{appRoots: string[], cliDir: string}}
 */
function rootsFor(env, utils) {
  const appRoots = [];
  if (env.platform === 'win32') {
    appRoots.push(utils.joinPath(env.appData, 'Cursor'));
  } else if (env.platform === 'darwin') {
    appRoots.push(utils.joinPath(env.home, 'Library', 'Application Support', 'Cursor'));
  } else {
    appRoots.push(utils.joinPath(env.home, '.config', 'Cursor'));
  }
  return { appRoots, cliDir: utils.joinPath(env.home, '.cursor') };
}

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {number|null} */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    if (value > 1e14) return Math.round(value / 1000); // microseconds
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return coerceEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** @param {unknown} raw @returns {any|null} */
function parseJson(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  let text;
  if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (typeof raw === 'string') text = raw;
  else return null;
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
 * Recursively walk a decoded JSON blob looking for explicit `tokenCount` objects.
 * @param {any} root
 * @param {{input: number, output: number, ts: number|null, model: string}[]} out
 * @param {number} depth
 */
function collectTokenCounts(root, out, depth) {
  if (!root || depth > 12 || out.length > 5000) return;
  if (Array.isArray(root)) {
    for (const item of root) collectTokenCounts(item, out, depth + 1);
    return;
  }
  if (typeof root !== 'object') return;
  const tokenCount = root.tokenCount && typeof root.tokenCount === 'object' ? root.tokenCount : null;
  if (tokenCount) {
    const input = toCount(tokenCount.inputTokens ?? tokenCount.input_tokens);
    const output = toCount(tokenCount.outputTokens ?? tokenCount.output_tokens);
    if (input + output > 0) {
      const ts =
        coerceEpochMs(root.createdAt) ??
        coerceEpochMs(root.timestamp) ??
        coerceEpochMs(root.lastUpdatedAt) ??
        null;
      const model =
        root.modelInfo?.modelName ||
        root.modelInfo?.model ||
        root.modelConfig?.modelName ||
        root.model ||
        'unknown';
      out.push({ input, output, ts, model: String(model) });
    }
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object') collectTokenCounts(value, out, depth + 1);
  }
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} path
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanDatabase(ctx, path) {
  const { utils, cache } = ctx;
  const fingerprint = await sqliteFingerprint(utils, path);
  if (fingerprint === '') return [];
  const cached = cache.get(path, fingerprint);
  if (cached) return cached;
  const fileStat = await utils.statSafe(path);
  if (!fileStat || !fileStat.isFile) return [];

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

    /** @type {Map<string, import('../scanner-types.js').Cell>} */
    const byKey = new Map();
    /** @type {(key: string, model: string, ts: number, input: number, output: number) => void} */
    const add = (key, model, ts, input, output) => {
      if (!(input + output > 0)) return;
      const day = utils.localDay(ts);
      const cellKey = `${model}\u0000${day}`;
      let cell = byKey.get(cellKey);
      if (!cell) {
        cell = {
          model,
          day,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          messages: 0,
          firstTs: ts,
          lastTs: ts,
        };
        byKey.set(cellKey, cell);
      }
      cell.input += input;
      cell.output += output;
      cell.messages += 1;
      if (ts < cell.firstTs) cell.firstTs = ts;
      if (ts > cell.lastTs) cell.lastTs = ts;
    };

    let usedDiskKv = false;
    if (tables.has('cursorDiskKV')) {
      /** @type {Map<string, {model: string, updatedAt: number|null}>} */
      const composers = new Map();
      for (const row of utils.querySqlite(
        db,
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      )) {
        const composerId = String(row?.key || '').slice('composerData:'.length);
        const composer = parseJson(row?.value);
        if (!composerId || !composer) continue;
        composers.set(composerId, {
          model: String(composer?.modelConfig?.modelName || composer?.modelInfo?.modelName || 'unknown'),
          updatedAt: coerceEpochMs(composer?.lastUpdatedAt) ?? coerceEpochMs(composer?.createdAt) ?? null,
        });
      }
      for (const row of utils.querySqlite(
        db,
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
      )) {
        if (ctx.signal.aborted) break;
        const bubble = parseJson(row?.value);
        if (!bubble) continue;
        const tokenCount = bubble.tokenCount && typeof bubble.tokenCount === 'object' ? bubble.tokenCount : null;
        if (!tokenCount) continue;
        const input = toCount(tokenCount.inputTokens ?? tokenCount.input_tokens);
        const output = toCount(tokenCount.outputTokens ?? tokenCount.output_tokens);
        if (input + output <= 0) continue;
        const parts = String(row?.key || '').split(':');
        const composerId = parts[1] || '';
        const composer = composers.get(composerId);
        const model = String(
          bubble?.modelInfo?.modelName || bubble?.modelConfig?.modelName || composer?.model || 'unknown',
        );
        const ts =
          coerceEpochMs(bubble.createdAt) ??
          coerceEpochMs(bubble.timestamp) ??
          composer?.updatedAt ??
          null;
        if (!ts) continue;
        usedDiskKv = true;
        add(String(row?.key || ''), model, ts, input, output);
      }
    }

    // Legacy fallback: ItemTable aichat/composer JSON blobs (old Cursor builds).
    if (!usedDiskKv && tables.has('ItemTable')) {
      const legacy = [];
      for (const row of utils.querySqlite(
        db,
        "SELECT key, value FROM ItemTable WHERE key LIKE '%aichat%' OR key LIKE '%composer%' OR key LIKE '%chatdata%'",
      )) {
        if (ctx.signal.aborted) break;
        const parsed = parseJson(row?.value);
        if (!parsed) continue;
        collectTokenCounts(parsed, legacy, 0);
      }
      for (const item of legacy) {
        const ts = item.ts ?? fileStat.mtimeMs;
        add(`legacy:${item.model}:${ts}:${item.input}:${item.output}`, item.model, ts, item.input, item.output);
      }
    }
    cells.push(...byKey.values());
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
  cache.set(path, fingerprint, cells);
  return cells;
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

  const { appRoots, cliDir } = rootsFor(env, utils);
  let appFound = false;
  /** @type {string[]} */
  const databases = [];
  for (const appRoot of appRoots) {
    const userDir = utils.joinPath(appRoot, 'User');
    const userStat = await utils.statSafe(userDir);
    if (!userStat || !userStat.isDirectory) {
      sources.push({ label: 'Cursor state.vscdb', path: appRoot, exists: false, files: 0, bytes: 0 });
      continue;
    }
    appFound = true;
    for (const database of [
      utils.joinPath(appRoot, 'User', 'globalStorage', 'state.vscdb'),
      ...(await collectWorkspaceDatabases(utils, appRoot)),
    ]) {
      if (databases.includes(database)) continue;
      databases.push(database);
    }
  }

  for (const path of databases) {
    const stat = await utils.statSafe(path);
    if (!stat || !stat.isFile) {
      sources.push({ label: 'Cursor state.vscdb', path, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const fileCells = await scanDatabase(ctx, path);
    cells.push(...fileCells);
    sources.push({
      label: 'Cursor state.vscdb',
      path,
      exists: true,
      files: 1,
      bytes: stat.size,
      note: 'cursorDiskKV bubbleId tokenCount; legacy ItemTable aichat blobs',
    });
  }

  const cliStat = await utils.statSafe(cliDir);
  sources.push({
    label: 'Cursor CLI config',
    path: cliDir,
    exists: Boolean(cliStat && cliStat.isDirectory),
    files: 0,
    bytes: 0,
    note: 'Cursor account usage is served by the dashboard API from the CLI login; not stored locally',
  });

  if (!appFound) return { sources, cells: mergeProviderCells(cells) };
  if (cells.length === 0) {
    ctx.warn(
      'Cursor: no locally recorded tokenCount found; Cursor keeps authoritative usage in its online dashboard (remote), not in local files',
    );
  }
  return { sources, cells: mergeProviderCells(cells) };
}

/**
 * @param {any} utils
 * @param {string} appRoot
 * @returns {Promise<string[]>}
 */
async function collectWorkspaceDatabases(utils, appRoot) {
  const workspaceStorage = utils.joinPath(appRoot, 'User', 'workspaceStorage');
  const out = [];
  for (const entry of await utils.readdirSafe(workspaceStorage)) {
    if (!entry.isDirectory()) continue;
    out.push(utils.joinPath(workspaceStorage, entry.name, 'state.vscdb'));
  }
  return out;
}
