/**
 * Trae / Trae CN usage provider.
 *
 * Trae (ByteDance, international) and Trae CN are VS Code-derived IDEs. Their agent history
 * lives outside `state.vscdb`, in a per-app SQLite database:
 *   macOS:   ~/Library/Application Support/{Trae,Trae CN}/ModularData/ai-agent/database.db
 *   Windows: %APPDATA%\{Trae,Trae CN}\ModularData\ai-agent\database.db
 *   Linux:   ~/.config/{Trae,Trae CN}/ModularData/ai-agent/database.db
 * (older builds used `ModularData/ai-chat/database.db`).
 *
 * ── Verified on this machine (Trae CN 2.3.82600) ──────────────────────────────────────────
 * The agent database is NOT a plaintext SQLite file: its header is opaque and `sqlite3`/the
 * node:sqlite driver rejects it ("file is not a database"). Trae encrypts the database with
 * SQLCipher; third-party readers decrypt it with Trae's shared application key. This package
 * intentionally does not embed a vendor decryption key or write decrypted copies of user data,
 * so the local database is reported as detected-but-unreadable instead of guessed.
 *
 * The plaintext VS Code stores (`User/globalStorage/state.vscdb`) carry only IDE state:
 * model catalog lists (`AI.agent.model.model_list_map`), draft session keys, theme data —
 * no token counters (verified). Workspace storage keeps `icube-ai-agent-storage-input-history`
 * (prompt text only).
 *
 * If a user exports/decrypts the database to a plaintext SQLite file at the same path (or via
 * the `TOKENTRACKER_TRAE_DB`-style explicit path in provider config), the documented
 * `chat_turn(context JSON)` schema is parsed:
 *   context.token_usage = { prompt_tokens, completion_tokens, cache_read_input_tokens,
 *                           cache_creation_input_tokens, reasoning_tokens, total_tokens, ... }
 *   context.persist_user_message_context.model_info.display_model_name / model_name
 * This path is unverified on this machine.
 */

import { open as openFile } from 'node:fs/promises';

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'trae',
  name: 'Trae',
  color: '#10b981',
  homepage: 'https://www.trae.ai',
  cacheVersion: 1,
};

const APP_DIRS = ['Trae', 'Trae CN', 'TRAE SOLO'];

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {number|null} */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 100_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return coerceEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {{root: string, database: string, altDatabase: string}[]}
 */
function appRoots(env, utils) {
  const roots = [];
  for (const app of APP_DIRS) {
    const root =
      env.platform === 'win32'
        ? utils.joinPath(env.appData, app)
        : env.platform === 'darwin'
          ? utils.joinPath(env.home, 'Library', 'Application Support', app)
          : utils.joinPath(env.home, '.config', app);
    roots.push({
      root,
      database: utils.joinPath(root, 'ModularData', 'ai-agent', 'database.db'),
      altDatabase: utils.joinPath(root, 'ModularData', 'ai-chat', 'database.db'),
    });
  }
  return roots;
}

/**
 * Read just the first 16 bytes so a 200 MB+ encrypted database is never loaded to test its type.
 * @param {string} path
 * @returns {Promise<Buffer|null>}
 */
async function readHeader(path) {
  let handle = null;
  try {
    handle = await openFile(path, 'r');
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}

/** @param {string} header @returns {boolean} */
function isSqlite(header) {
  return header.startsWith('SQLite format 3');
}

/** @param {any} context @returns {string} */
function modelFromContext(context) {
  const modelInfo =
    context?.persist_user_message_context?.model_info &&
    typeof context.persist_user_message_context.model_info === 'object'
      ? context.persist_user_message_context.model_info
      : context?.model_info && typeof context.model_info === 'object'
        ? context.model_info
        : {};
  const candidates = [
    modelInfo.display_model_name,
    modelInfo.model_name,
    modelInfo.config_name,
    context?.model_name,
    context?.model,
    context?.agent_model,
    context?.selected_model?.name,
    context?.selectedModel?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && candidate.trim() !== '-') {
      return candidate.trim();
    }
  }
  return 'trae-unknown';
}

/**
 * @param {Record<string, any>} usage
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|null}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const number = Number(usage[key]);
      if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
    }
    return 0;
  };
  const prompt = pick('prompt_tokens', 'input_tokens', 'prompt_tokens_total');
  const output = pick('completion_tokens', 'output_tokens', 'completion_tokens_total');
  const cacheRead = pick('cache_read_input_tokens');
  const cacheWrite = pick('cache_creation_input_tokens');
  if (prompt + output + cacheRead + cacheWrite <= 0) return null;
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
  };
}

/**
 * Parse a plaintext `chat_turn` table (only reachable for decrypted/exported databases).
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} path
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanPlaintextDatabase(ctx, path) {
  const { utils, cache } = ctx;
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${path}${suffix}`);
    if (stat && stat.isFile) parts.push(`${stat.size}:${Math.round(stat.mtimeMs)}`);
    else if (suffix === '') return [];
    else parts.push('-');
  }
  const fingerprint = parts.join('|');
  const cached = cache.get(path, fingerprint);
  if (cached) return cached;

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
    if (!tables.has('chat_turn')) return [];
    const rows = utils.querySqlite(
      db,
      'SELECT id, session_id, turn_id, context, created_at, updated_at FROM chat_turn',
    );
    /** @type {Map<string, import('../scanner-types.js').Cell>} */
    const byKey = new Map();
    for (const row of rows) {
      if (ctx.signal.aborted) break;
      const context = utils.safeJsonParse(typeof row?.context === 'string' ? row.context : '');
      if (!context || typeof context !== 'object') continue;
      const usage = normalizeUsage(context.token_usage);
      if (!usage) continue;
      const timestamp = coerceEpochMs(row?.created_at) ?? coerceEpochMs(row?.updated_at);
      if (!timestamp) continue;
      const model = modelFromContext(context);
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
      cell.input += usage.input;
      cell.output += usage.output;
      cell.cacheRead += usage.cacheRead;
      cell.cacheWrite += usage.cacheWrite;
      cell.messages += 1;
      if (timestamp < cell.firstTs) cell.firstTs = timestamp;
      if (timestamp > cell.lastTs) cell.lastTs = timestamp;
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

  let installed = false;
  let encrypted = false;
  let unreadable = false;

  for (const candidate of appRoots(env, utils)) {
    const rootStat = await utils.statSafe(candidate.root);
    if (!rootStat || !rootStat.isDirectory) continue;
    installed = true;

    // Pick whichever database exists (prefer ai-agent).
    let chosen = null;
    for (const path of [candidate.database, candidate.altDatabase]) {
      const stat = await utils.statSafe(path);
      if (stat && stat.isFile) {
        chosen = { path, size: stat.size };
        break;
      }
    }
    const stateDbPath = utils.joinPath(candidate.root, 'User', 'globalStorage', 'state.vscdb');
    const stateDbStat = await utils.statSafe(stateDbPath);

    if (!chosen) {
      sources.push({
        label: 'Trae agent database',
        path: candidate.root,
        exists: true,
        files: 0,
        bytes: 0,
        note: 'no ModularData/ai-agent/database.db found (state.vscdb only keeps IDE state)',
      });
      if (stateDbStat) {
        sources.push({
          label: 'Trae VS Code state',
          path: stateDbPath,
          exists: true,
          files: 0,
          bytes: stateDbStat.size,
          note: 'state.vscdb holds model catalog/theme/draft keys only; no token counters',
        });
      }
      continue;
    }

    const header = await readHeader(chosen.path);
    if (!header || !isSqlite(header.toString('latin1'))) {
      encrypted = true;
      sources.push({
        label: 'Trae agent database',
        path: chosen.path,
        exists: true,
        files: 0,
        bytes: chosen.size,
        note: 'SQLCipher-encrypted agent database; token usage is not locally readable without the vendor key',
      });
      continue;
    }

    const fileCells = await scanPlaintextDatabase(ctx, chosen.path);
    cells.push(...fileCells);
    unreadable = unreadable || fileCells.length === 0;
    sources.push({
      label: 'Trae agent database',
      path: chosen.path,
      exists: true,
      files: 1,
      bytes: chosen.size,
      note: 'plaintext SQLite chat_turn.context token_usage',
    });
  }

  if (!installed) return { sources, cells: mergeProviderCells(cells) };
  if (encrypted) {
    ctx.warn(
      'Trae: agent database is SQLCipher-encrypted on this installation; token usage is not locally readable (no cells reported)',
    );
  } else if (unreadable) {
    ctx.warn('Trae: plaintext agent database found but it contains no readable chat_turn token usage');
  }
  return { sources, cells: mergeProviderCells(cells) };
}
