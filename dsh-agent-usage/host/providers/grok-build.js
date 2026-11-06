/**
 * Grok Build (xAI Grok CLI) provider.
 *
 * `GROK_HOME` (default `~/.grok`, Windows `%USERPROFILE%\.grok`) holds one directory per
 * session at `<grok-home>/sessions/<url-encoded-cwd>/<session-id>/`.
 *
 * Two documented records carry token usage:
 *
 * 1. `updates.jsonl` — the ACP session update stream. Every completed prompt appends a
 *    `_x.ai/session/update` line whose `params.update.sessionUpdate === "turn_completed"`
 *    and `params.update.usage` holds:
 *      { inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens,
 *        totalTokens, modelCalls, costUsdTicks,
 *        modelUsage: { <model>: { ...same fields..., costUsdTicks } } }
 *    This is the most complete source: every finished turn is recorded here, including
 *    sessions whose `usage.json` was never flushed (67 of 162 session dirs on this machine).
 *    The bundled `docs/user-guide/17-sessions.md` documents `grok usage`, which reads
 *    `usage.json`; a cross-check on this machine showed the turn_completed sums equal the
 *    `usage.json` session totals for 94 of 95 finalized sessions.
 *
 * 2. `usage.json` — the finalized per-session summary:
 *      { sessionId, updatedAt, session: {...totals, modelUsage}, turns: [...] }
 *    Used as a fallback for session dirs that have no usage-bearing `updates.jsonl`.
 *
 * `costUsdTicks` is 10^10 ticks per USD (divide by 1e10 for dollars). `inputTokens` is the
 * uncached prompt size (totalTokens = input + output; cachedRead is a separate column), and
 * `reasoningTokens` is already counted inside `outputTokens`.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

const TICKS_PER_USD = 1e10;

export const meta = {
  id: 'grok-build',
  name: 'Grok Build',
  color: '#4b5563',
  homepage: 'https://x.ai',
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

/** @param {unknown} value @returns {number} */
function toTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Add one per-model turn usage record.
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 * @param {any} usage
 * @param {string} model
 * @param {number} ts
 * @param {number} costTicks
 * @param {typeof import('../scan-utils.js')} utils
 */
function addGrokUsage(byKey, usage, model, ts, costTicks, utils) {
  if (!usage || typeof usage !== 'object') return;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cachedReadTokens);
  const cacheWrite = num(usage.cacheCreationTokens);
  if (input + output + cacheRead + cacheWrite === 0) return;
  addUsage(byKey, {
    model,
    day: utils.localDay(ts),
    ts,
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd: positive(costTicks) / TICKS_PER_USD || undefined,
    messages: num(usage.modelCalls) || 1,
  });
}

/**
 * Parse `updates.jsonl` turn_completed lines.
 * @param {string} filePath
 * @param {number} fallbackTs
 * @param {typeof import('../scan-utils.js')} utils
 * @param {AbortSignal} signal
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 */
async function parseUpdatesFile(filePath, fallbackTs, utils, signal, byKey) {
  /** @type {Set<string>} */
  const seen = new Set();
  await utils.readJsonl(
    filePath,
    (line) => {
      if (!line.includes('turn_completed')) return;
      const record = utils.safeJsonParse(line);
      if (!record || typeof record !== 'object') return;
      const params = record.params && typeof record.params === 'object' ? record.params : {};
      const update = params.update && typeof params.update === 'object' ? params.update : null;
      if (!update || update.sessionUpdate !== 'turn_completed') return;
      const usage = update.usage && typeof update.usage === 'object' ? update.usage : null;
      if (!usage) return;
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const promptId = typeof update.prompt_id === 'string' ? update.prompt_id : '';
      const meta = record._meta && typeof record._meta === 'object' ? record._meta : {};
      const ts = toTs(meta.agentTimestampMs) || toTs(record.timestamp) || fallbackTs;
      const topTicks = positive(usage.costUsdTicks);
      const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object' ? usage.modelUsage : null;
      const entries =
        modelUsage && Object.keys(modelUsage).length > 0
          ? Object.entries(modelUsage).filter(([, value]) => value && typeof value === 'object')
          : [];
      if (entries.length > 0) {
        // A per-model split can omit cost on one model; share the remaining top-level cost
        // proportionally to that model's total tokens (same rule as T3 Code).
        const totalTicks = topTicks || entries.reduce((sum, [, value]) => sum + positive(value.costUsdTicks), 0);
        const knownTicks = entries.reduce((sum, [, value]) => sum + positive(value.costUsdTicks), 0);
        let tokensAll = 0;
        for (const [, value] of entries) tokensAll += num(value.totalTokens) || num(value.inputTokens) + num(value.outputTokens);
        const remainingTicks = Math.max(0, totalTicks - knownTicks);
        for (const [model, value] of entries) {
          const modelTicks = positive(value.costUsdTicks);
          let ticks = modelTicks;
          if (modelTicks === 0 && remainingTicks > 0 && tokensAll > 0) {
            const tokens = num(value.totalTokens) || num(value.inputTokens) + num(value.outputTokens);
            ticks = (remainingTicks * tokens) / tokensAll;
          }
          const key = `${sessionId}\u0000${promptId}\u0000${model}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addGrokUsage(byKey, value, model || 'grok', ts, ticks, utils);
        }
      } else {
        const model = (typeof update.modelId === 'string' && update.modelId) || 'grok';
        const key = `${sessionId}\u0000${promptId}\u0000${model}`;
        if (seen.has(key)) return;
        seen.add(key);
        addGrokUsage(byKey, usage, model, ts, topTicks, utils);
      }
    },
    { signal },
  );
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function grokHomes(ctx) {
  const homes = [];
  const override = ctx.utils.expandPath(process.env.GROK_HOME || '');
  if (override) homes.push(override);
  homes.push(join(ctx.env.home, '.grok'));
  return [...new Set(homes.filter(Boolean))];
}

/**
 * Parse a finalized `usage.json` document into the cell map.
 * @param {string} raw
 * @param {number} fallbackTs
 * @param {typeof import('../scan-utils.js')} utils
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 * @returns {boolean}
 */
function parseUsageDocument(raw, fallbackTs, utils, byKey) {
  const data = utils.safeJsonParse(raw);
  if (!data || typeof data !== 'object') return false;
  let turns = Array.isArray(data.turns) ? data.turns.filter((turn) => turn && typeof turn === 'object') : [];
  const fallback = toTs(data.updatedAt) || fallbackTs;
  if (turns.length === 0 && data.session && typeof data.session === 'object') {
    turns = [{ ...data.session, endedAt: data.updatedAt }];
  }
  for (const turn of turns) {
    const ts = toTs(turn.endedAt) || toTs(turn.completedAt) || toTs(turn.startedAt) || fallback;
    const modelUsage = turn.modelUsage;
    if (modelUsage && typeof modelUsage === 'object' && Object.keys(modelUsage).length > 0) {
      for (const [model, usage] of Object.entries(modelUsage)) {
        addGrokUsage(byKey, usage, model || turn.primaryModelId || 'grok', ts, positive(usage && usage.costUsdTicks), utils);
      }
    } else {
      addGrokUsage(byKey, turn, turn.primaryModelId || 'grok', ts, positive(turn.costUsdTicks), utils);
    }
  }
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
  let found = false;

  for (const home of grokHomes(ctx)) {
    const sessionsDir = join(home, 'sessions');
    const sessionsStat = await utils.statSafe(sessionsDir);
    if (sessionsStat === null || !sessionsStat.isDirectory) continue;
    found = true;

    const allFiles = await utils.listFilesRecursive(sessionsDir, {
      exts: ['.json', '.jsonl'],
      maxDepth: 4,
      maxFiles: 50000,
      signal: ctx.signal,
    });
    /** @type {Map<string, {updates?: any, usage?: any}>} */
    const byDir = new Map();
    for (const file of allFiles) {
      const base = utils.basenameOf(file.path);
      if (base !== 'updates.jsonl' && base !== 'usage.json') continue;
      const dir = file.path.slice(0, file.path.length - base.length - 1);
      const entry = byDir.get(dir) || {};
      if (base === 'updates.jsonl') entry.updates = file;
      else entry.usage = file;
      byDir.set(dir, entry);
    }

    let bytes = 0;
    let parsedFiles = 0;
    let contributed = 0;
    for (const [, entry] of [...byDir.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const primary = entry.updates || entry.usage;
      if (!primary) continue;
      const fingerprint =
        (entry.updates ? `${entry.updates.size}:${Math.round(entry.updates.mtimeMs)}` : '') +
        '|' +
        (entry.usage ? `${entry.usage.size}:${Math.round(entry.usage.mtimeMs)}` : '');
      let dirCells = cache.get(primary.path, fingerprint);
      let usedUpdates = false;
      if (!dirCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        if (entry.updates) {
          try {
            await parseUpdatesFile(entry.updates.path, entry.updates.mtimeMs, utils, ctx.signal, byKey);
          } catch (error) {
            ctx.warn(`Grok Build: cannot read ${entry.updates.path}: ${error?.message || error}`);
          }
          usedUpdates = byKey.size > 0;
        }
        if (!usedUpdates && entry.usage) {
          const raw = await utils.readText(entry.usage.path);
          if (raw !== null) parseUsageDocument(raw, entry.usage.mtimeMs, utils, byKey);
        }
        dirCells = finalizeCells([...byKey.values()]);
        cache.set(primary.path, fingerprint, dirCells);
      }
      if (entry.updates) {
        parsedFiles += 1;
        bytes += entry.updates.size;
      }
      if (!entry.updates || dirCells.length === 0) {
        if (entry.usage) {
          parsedFiles += 1;
          bytes += entry.usage.size;
        }
      }
      if (dirCells.length > 0) {
        contributed += 1;
        allCells.push(...dirCells);
      }
    }

    sources.push({
      label: 'Grok Build sessions',
      path: sessionsDir,
      exists: true,
      files: parsedFiles,
      bytes,
      note:
        (contributed > 0
          ? 'updates.jsonl turn_completed usage (fallback: usage.json); costUsdTicks/1e10 = USD'
          : 'Grok session directories found but no usage records') + '; verified on this machine',
    });
  }

  if (!found) {
    sources.push({
      label: 'Grok Build sessions',
      path: join(grokHomes(ctx)[0] || join(env.home, '.grok'), 'sessions'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Grok Build is not installed on this machine (or GROK_HOME points elsewhere)',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
