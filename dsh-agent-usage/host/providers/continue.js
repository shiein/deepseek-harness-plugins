/**
 * Continue provider.
 *
 * Continue (VS Code / JetBrains / `cn` CLI) stores one JSON document per chat under
 * `${CONTINUE_GLOBAL_DIR:-~/.continue}/sessions/<sessionId>.json`, with
 * `sessions.json` next to them holding `{ sessionId, dateCreated, workspaceDirectory,
 * messageCount }` for every chat. The session document has an optional cumulative usage
 * block (see Continue's `Session`/`SessionUsage` types):
 *
 *   { sessionId, title, workspaceDirectory, chatModelTitle,
 *     history: [ { message: { role, content, usage? }, ... } ],
 *     usage: { promptTokens, completionTokens, totalCost,
 *              promptTokensDetails: { cachedTokens, cacheWriteTokens },
 *              completionTokensDetails: { reasoningTokens } } }
 *
 * The session-level `usage` is cumulative and preferred; when absent, per-message
 * assistant `usage` blocks are summed. `promptTokens` is cache-inclusive (OpenAI-style),
 * so cache read/write are subtracted from the fresh input. `reasoningTokens` is inside
 * `completionTokens` and is not added again. Timestamps exist only in `sessions.json`
 * (`dateCreated`), so the file mtime is the fallback.
 *
 * NOT VERIFIED ON THIS MACHINE: `~/.continue` does not exist here.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'continue',
  name: 'Continue',
  color: '#ef4444',
  homepage: 'https://continue.dev',
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
 * Accumulate an OpenAI-shaped usage block into the cell map.
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 * @param {any} usage
 * @param {string} model
 * @param {number} ts
 * @param {number} messages
 * @param {typeof import('../scan-utils.js')} utils
 * @returns {boolean}
 */
function addContinueUsage(byKey, usage, model, ts, messages, utils) {
  if (!usage || typeof usage !== 'object') return false;
  const prompt = num(usage.promptTokens);
  const completion = num(usage.completionTokens);
  const promptDetails = usage.promptTokensDetails && typeof usage.promptTokensDetails === 'object' ? usage.promptTokensDetails : {};
  const cacheRead = num(promptDetails.cachedTokens);
  const cacheWrite = num(promptDetails.cacheWriteTokens);
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  if (input + completion + cacheRead + cacheWrite === 0) return false;
  addUsage(byKey, {
    model,
    day: utils.localDay(ts),
    ts,
    input,
    output: completion,
    cacheRead,
    cacheWrite,
    costUsd: positive(usage.totalCost) || undefined,
    messages,
  });
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

  const override = utils.expandPath(process.env.CONTINUE_GLOBAL_DIR || '');
  const root = override || join(env.home, '.continue');
  const sessionsDir = join(root, 'sessions');
  const sessionsStat = await utils.statSafe(sessionsDir);
  if (sessionsStat === null || !sessionsStat.isDirectory) {
    sources.push({
      label: 'Continue sessions',
      path: sessionsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Continue is not installed on this machine (no ~/.continue/sessions); parser unverified here',
    });
    return { sources, cells: [] };
  }

  // The session index is the only timestamp source; its stat participates in the cache
  // fingerprint so a newly indexed chat re-dates already-parsed session cells.
  const indexPath = join(sessionsDir, 'sessions.json');
  const indexStat = await utils.statSafe(indexPath);
  const indexFp = indexStat === null ? 'noindex' : `${indexStat.size}:${Math.round(indexStat.mtimeMs)}`;
  /** @type {Map<string, any>} */
  const metaById = new Map();
  if (indexStat !== null) {
    const raw = await utils.readText(indexPath);
    const list = utils.safeJsonParse(raw || '');
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string') metaById.set(entry.sessionId, entry);
      }
    }
  }

  const entries = await utils.readdirSafe(sessionsDir);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'sessions.json')
    .map((entry) => join(sessionsDir, entry.name));
  let bytes = 0;
  let contributed = 0;

  for (const filePath of files) {
    const fileStat = await utils.statSafe(filePath);
    if (fileStat === null) continue;
    bytes += fileStat.size;
    const fingerprint = `${fileStat.size}:${Math.round(fileStat.mtimeMs)}:${indexFp}`;
    let fileCells = cache.get(filePath, fingerprint);
    if (!fileCells) {
      const raw = await utils.readText(filePath);
      const session = utils.safeJsonParse(raw || '');
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byKey = new Map();
      if (session && typeof session === 'object') {
        const meta = metaById.get(String(session.sessionId || '')) || {};
        const ts = toTs(meta.dateCreated) || fileStat.mtimeMs;
        const model = (typeof session.chatModelTitle === 'string' && session.chatModelTitle) || 'unknown';
        const history = Array.isArray(session.history) ? session.history : [];
        const assistantMessages = history.filter((item) => item && item.message && item.message.role === 'assistant').length;
        if (!addContinueUsage(byKey, session.usage, model, ts, assistantMessages || 1, utils)) {
          // No cumulative block: sum per-assistant-message usage blocks when present.
          for (const item of history) {
            const message = item && item.message;
            if (!message || message.role !== 'assistant') continue;
            addContinueUsage(byKey, message.usage, model, ts, 1, utils);
          }
        }
      }
      fileCells = finalizeCells([...byKey.values()]);
      cache.set(filePath, fingerprint, fileCells);
    }
    if (fileCells.length > 0) {
      contributed += 1;
      allCells.push(...fileCells);
    }
  }

  sources.push({
    label: 'Continue sessions',
    path: sessionsDir,
    exists: true,
    files: files.length,
    bytes,
    note:
      (contributed > 0
        ? 'session.usage cumulative tokens/cost; dateCreated from sessions.json'
        : 'Continue session files found but none carried usage') +
      '; format from Continue core types, unverified on this machine (~/.continue absent)',
  });

  return { sources, cells: mergeCells(allCells) };
}
