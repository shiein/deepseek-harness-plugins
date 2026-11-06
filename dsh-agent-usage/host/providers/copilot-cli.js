/**
 * GitHub Copilot CLI provider.
 *
 * Copilot CLI keeps its data in `~/.copilot` (`%USERPROFILE%\.copilot` on Windows):
 *
 * 1. `session-store.db` (SQLite, written unconditionally by the CLI / desktop app). The
 *    `assistant_usage_events` table records one row per API request; it is the
 *    authoritative input/cache source:
 *      session_id, model, input_tokens (cache-INCLUSIVE),
 *      cache_read_tokens, cache_write_tokens, reasoning_tokens, output_tokens,
 *      created_at (SQLite UTC text), total_nano_aiu (billed Copilot AI credits * 1e9)
 *    `total_nano_aiu / 1e9` is the credit count and one AI credit is $0.01, so the billed
 *    USD amount is `total_nano_aiu / 1e11`.
 *
 * 2. `session-state/<sessionId>/events.jsonl`, an ACP event stream. For sessions without
 *    store rows, the last `session.shutdown` event per model carries a cumulative
 *    `data.modelMetrics[model].usage` rollup (inputTokens cache-inclusive, outputTokens,
 *    cacheReadTokens, cacheWriteTokens, totalNanoAiu). Older CLIs also write per-turn
 *    `assistant.message` output tokens; those are used only when no rollup exists.
 *
 * Store rows win for a session; events rollups fill in sessions the store does not cover.
 * NOT VERIFIED ON THIS MACHINE: `~/.copilot/session-state` exists here but holds only
 * `workspace.yaml`/`checkpoints` and there is no `session-store.db`, so no tokens exist.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'copilot-cli',
  name: 'GitHub Copilot CLI',
  color: '#6e40c9',
  homepage: 'https://github.com/github/copilot-cli',
  cacheVersion: 1,
};

const NANO_AIU_PER_USD = 1e11; // nano AI credits -> USD (1 credit = $0.01, 1e9 nano per credit)

/** @param {unknown} value @returns {number} */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * SQLite TEXT timestamps are UTC but usually lack the `Z`.
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

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];
  const root = join(env.home, '.copilot');
  const rootStat = await utils.statSafe(root);
  const storePath = join(root, 'session-store.db');
  const stateDir = join(root, 'session-state');
  /** @type {Set<string>} sessions covered by the authoritative SQLite store */
  const storeSessions = new Set();
  let anyUsage = false;

  // ---- authoritative per-request session store ---------------------------
  const storeStat = await utils.statSafe(storePath);
  if (storeStat !== null && storeStat.isFile) {
    const walStat = await utils.statSafe(`${storePath}-wal`);
    const fingerprint = `${storeStat.size}:${Math.round(storeStat.mtimeMs)}` + (walStat ? `|${walStat.size}:${Math.round(walStat.mtimeMs)}` : '');
    let storeCells = cache.get(storePath, fingerprint);
    let rowCount = 0;
    if (!storeCells) {
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byKey = new Map();
      try {
        const db = await utils.openSqliteDatabase(storePath, { readOnly: true });
        try {
          const columns = new Set(
            utils.querySqlite(db, "SELECT name FROM pragma_table_info('assistant_usage_events')").map((row) => String(row.name)),
          );
          if (!columns.has('input_tokens') || !columns.has('session_id')) {
            ctx.warn('Copilot CLI: session-store.db has no assistant_usage_events schema (older CLI build)');
          } else {
            const wanted = [
              'session_id',
              'model',
              'input_tokens',
              'output_tokens',
              'cache_read_tokens',
              'cache_write_tokens',
              'created_at',
              'total_nano_aiu',
            ].filter((name) => columns.has(name));
            const rows = utils.querySqlite(db, `SELECT ${wanted.map((name) => `"${name}"`).join(', ')} FROM assistant_usage_events`);
            for (const row of rows) {
              if (typeof row.session_id === 'string' && row.session_id !== '') storeSessions.add(row.session_id);
              const cacheRead = num(row.cache_read_tokens);
              const cacheWrite = num(row.cache_write_tokens);
              const input = Math.max(0, num(row.input_tokens) - cacheRead - cacheWrite);
              const output = num(row.output_tokens);
              if (input + output + cacheRead + cacheWrite === 0) continue;
              const ts = toTs(row.created_at) || storeStat.mtimeMs;
              addUsage(byKey, {
                model: (typeof row.model === 'string' && row.model) || 'unknown',
                day: utils.localDay(ts),
                ts,
                input,
                output,
                cacheRead,
                cacheWrite,
                costUsd: num(row.total_nano_aiu) / NANO_AIU_PER_USD || undefined,
                messages: 1,
              });
              rowCount += 1;
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
        ctx.warn(`Copilot CLI: cannot read ${storePath}: ${error?.message || error}`);
      }
      storeCells = finalizeCells([...byKey.values()]);
      cache.set(storePath, fingerprint, storeCells);
    }
    if (storeCells.length > 0) {
      anyUsage = true;
      allCells.push(...storeCells);
    }
    sources.push({
      label: 'Copilot CLI session store',
      path: storePath,
      exists: true,
      files: rowCount || 1,
      bytes: storeStat.size + (walStat?.size || 0),
      note:
        (storeCells.length > 0
          ? 'assistant_usage_events: per-request input/cache/output and total_nano_aiu/1e11 USD'
          : 'session-store.db found but no assistant_usage_events rows with tokens') + '; schema from Copilot CLI docs, unverified on this machine',
    });
  }

  // ---- ACP session-state event streams -----------------------------------
  const stateStat = await utils.statSafe(stateDir);
  if (stateStat !== null && stateStat.isDirectory) {
    const dirs = (await utils.readdirSafe(stateDir)).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    let eventsFiles = 0;
    let bytes = 0;
    for (const dir of dirs) {
      const sessionId = dir.name;
      if (storeSessions.has(sessionId)) continue; // store rows are authoritative
      const eventsPath = join(stateDir, sessionId, 'events.jsonl');
      const eventsStat = await utils.statSafe(eventsPath);
      if (eventsStat === null || !eventsStat.isFile) continue;
      eventsFiles += 1;
      bytes += eventsStat.size;
      const fingerprint = `${eventsStat.size}:${Math.round(eventsStat.mtimeMs)}`;
      let fileCells = cache.get(eventsPath, fingerprint);
      if (!fileCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        /** @type {Map<string, any>} model -> last rollup */
        const rollups = new Map();
        /** @type {Map<string, { output: number, calls: number, ts: number }>} */
        const perTurn = new Map();
        const fileTs = eventsStat.mtimeMs;
        try {
          await utils.readJsonl(
            eventsPath,
            (line) => {
              if (!line.includes('session.shutdown') && !line.includes('assistant.message')) return;
              const event = utils.safeJsonParse(line);
              if (!event || typeof event !== 'object') return;
              const data = event.data && typeof event.data === 'object' ? event.data : {};
              const ts = toTs(event.timestamp) || toTs(data.timestamp) || fileTs;
              if (event.type === 'session.shutdown') {
                const modelMetrics = data.modelMetrics && typeof data.modelMetrics === 'object' ? data.modelMetrics : null;
                if (!modelMetrics) return;
                for (const [model, metrics] of Object.entries(modelMetrics)) {
                  if (!metrics || typeof metrics !== 'object') continue;
                  rollups.set(model || 'unknown', { ...metrics, ts });
                }
              } else if (event.type === 'assistant.message') {
                const output = num(data.outputTokens);
                if (output === 0) return;
                const model = (typeof data.model === 'string' && data.model) || 'unknown';
                const entry = perTurn.get(model) || { output: 0, calls: 0, ts };
                entry.output += output;
                entry.calls += 1;
                entry.ts = entry.ts || ts;
                perTurn.set(model, entry);
              }
            },
            { signal: ctx.signal },
          );
        } catch (error) {
          ctx.warn(`Copilot CLI: cannot read ${eventsPath}: ${error?.message || error}`);
        }
        if (rollups.size > 0) {
          for (const [model, metrics] of rollups) {
            const usage = metrics.usage && typeof metrics.usage === 'object' ? metrics.usage : metrics;
            const cacheRead = num(usage.cacheReadTokens);
            const cacheWrite = num(usage.cacheWriteTokens);
            const input = Math.max(0, num(usage.inputTokens) - cacheRead - cacheWrite);
            const output = num(usage.outputTokens);
            if (input + output + cacheRead + cacheWrite === 0) continue;
            const ts = toTs(metrics.ts) || fileTs;
            addUsage(byKey, {
              model,
              day: utils.localDay(ts),
              ts,
              input,
              output,
              cacheRead,
              cacheWrite,
              costUsd: num(metrics.totalNanoAiu) / NANO_AIU_PER_USD || undefined,
              messages: 1,
            });
          }
        } else if (perTurn.size > 0) {
          for (const [model, entry] of perTurn) {
            const ts = entry.ts || fileTs;
            addUsage(byKey, {
              model,
              day: utils.localDay(ts),
              ts,
              input: 0,
              output: entry.output,
              cacheRead: 0,
              cacheWrite: 0,
              messages: entry.calls || 1,
            });
          }
        }
        fileCells = finalizeCells([...byKey.values()]);
        cache.set(eventsPath, fingerprint, fileCells);
      }
      if (fileCells.length > 0) {
        anyUsage = true;
        allCells.push(...fileCells);
      }
    }
    sources.push({
      label: 'Copilot CLI session state',
      path: stateDir,
      exists: true,
      files: eventsFiles,
      bytes,
      note:
        (eventsFiles > 0
          ? 'session.shutdown modelMetrics rollups for sessions without store rows'
          : 'session directories contain no events.jsonl (no token data recorded)') + '; unverified on this machine',
    });
  }

  if (!anyUsage) {
    ctx.warn(
      'Copilot CLI: session state detected but no token usage found ' +
        '(no session-store.db assistant_usage_events rows and no events.jsonl usage rollups)',
    );
  }

  if (rootStat === null) {
    sources.push({
      label: 'Copilot CLI data',
      path: root,
      exists: false,
      files: 0,
      bytes: 0,
      note: 'GitHub Copilot CLI is not installed on this machine; parser follows the documented session-store/events format but is unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
