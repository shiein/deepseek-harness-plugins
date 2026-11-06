/**
 * Amp provider (Sourcegraph's Amp CLI / editor extension).
 *
 * Amp keeps one JSON document per thread under `<data-dir>/threads/**` where the data dir
 * is `$AMP_DATA_DIR` (comma-separated list accepted, like Amp itself) or
 * `~/.local/share/amp` (`%LOCALAPPDATA%\amp` on Windows).
 *
 * A thread document is `{ id, messages: [...], usageLedger?: { events: [...] } }`.
 *   usageLedger.events[]: { id, timestamp, model, tokens: { input, output, total },
 *                           toMessageId, credits }
 * Cache token counts are not on the event; they live on the billed thread message,
 * joined through `toMessageId` -> `messages[].messageId`:
 *   message.usage = { inputTokens, outputTokens, cacheCreationInputTokens,
 *                     cacheReadInputTokens, totalTokens, timestamp?, model? }
 * A thread without a ledger falls back to those per-message usage blocks (one call each).
 * Any positive remainder of `tokens.total` beyond input+output+cache is output tokens.
 * Amp records `credits`, not USD, so no `costUsd` is reported.
 *
 * NOT VERIFIED ON THIS MACHINE: Amp is not installed here; the format follows ccusage's
 * Amp adapter (mapped against real thread files upstream).
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'amp',
  name: 'Amp',
  color: '#f34f29',
  homepage: 'https://ampcode.com',
  cacheVersion: 1,
};

/** @param {unknown} value @returns {number} */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
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
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function dataDirs(ctx) {
  const { utils, env } = ctx;
  const raw = process.env.AMP_DATA_DIR || '';
  if (raw.trim() !== '') {
    const dirs = raw
      .split(',')
      .map((part) => utils.expandPath(part.trim()))
      .filter(Boolean);
    if (dirs.length > 0) return [...new Set(dirs)];
  }
  const dirs = [];
  if (env.platform === 'win32' && env.localAppData) dirs.push(join(env.localAppData, 'amp'));
  dirs.push(join(env.xdgData, 'amp'));
  // Some Amp builds (and the Windows editor extension) keep threads under ~/.amp.
  dirs.push(join(env.home, '.amp'));
  return [...new Set(dirs)];
}

/**
 * Turn a thread message's usage block into token counts.
 * @param {any} usage
 */
function messageUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadInputTokens);
  const cacheWrite = num(usage.cacheCreationInputTokens);
  const total = num(usage.totalTokens);
  return { input, output, cacheRead, cacheWrite, total };
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

  for (const dataDir of dataDirs(ctx)) {
    const threadsDir = join(dataDir, 'threads');
    const stat = await utils.statSafe(threadsDir);
    if (stat === null || !stat.isDirectory) continue;
    found = true;
    const files = await utils.listFilesRecursive(threadsDir, {
      exts: ['.json'],
      maxDepth: 8,
      maxFiles: 50000,
      signal: ctx.signal,
    });
    let bytes = 0;
    let contributed = 0;

    for (const file of files) {
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        const raw = await utils.readText(file.path);
        const thread = utils.safeJsonParse(raw || '');
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        if (thread && typeof thread === 'object') {
          const messages = Array.isArray(thread.messages) ? thread.messages : [];
          /** @type {Map<string, any>} */
          const usageByMessageId = new Map();
          for (const message of messages) {
            if (!message || typeof message !== 'object' || !message.usage) continue;
            const messageId = message.messageId || message.id;
            if (typeof messageId === 'string' && messageId !== '') usageByMessageId.set(messageId, message.usage);
          }
          const ledger =
            thread.usageLedger && Array.isArray(thread.usageLedger.events) ? thread.usageLedger.events : [];
          if (ledger.length > 0) {
            for (const event of ledger) {
              if (!event || typeof event !== 'object') continue;
              const tokens = event.tokens && typeof event.tokens === 'object' ? event.tokens : {};
              let input = num(tokens.input);
              let output = num(tokens.output);
              const total = num(tokens.total);
              let cacheRead = 0;
              let cacheWrite = 0;
              const billed = typeof event.toMessageId === 'string' ? usageByMessageId.get(event.toMessageId) : null;
              const billedTokens = messageUsageTokens(billed);
              if (billedTokens) {
                cacheRead = billedTokens.cacheRead;
                cacheWrite = billedTokens.cacheWrite;
              }
              const remainder = Math.max(0, total - input - output - cacheRead - cacheWrite);
              output += remainder;
              if (input + output + cacheRead + cacheWrite === 0) continue;
              const ts = toTs(event.timestamp) || file.mtimeMs;
              addUsage(byKey, {
                model: (typeof event.model === 'string' && event.model) || 'unknown',
                day: utils.localDay(ts),
                ts,
                input,
                output,
                cacheRead,
                cacheWrite,
                messages: 1,
              });
            }
          } else {
            for (const message of messages) {
              if (!message || typeof message !== 'object') continue;
              const tokens = messageUsageTokens(message.usage);
              if (!tokens) continue;
              let input = tokens.input;
              let output = tokens.output;
              const remainder = Math.max(0, tokens.total - input - output - tokens.cacheRead - tokens.cacheWrite);
              output += remainder;
              if (input + output + tokens.cacheRead + tokens.cacheWrite === 0) continue;
              const ts = toTs(message.timestamp) || toTs(thread.updatedAt) || file.mtimeMs;
              addUsage(byKey, {
                model: (typeof message.model === 'string' && message.model) || 'unknown',
                day: utils.localDay(ts),
                ts,
                input,
                output,
                cacheRead: tokens.cacheRead,
                cacheWrite: tokens.cacheWrite,
                messages: 1,
              });
            }
          }
        }
        fileCells = finalizeCells([...byKey.values()]);
        cache.set(file.path, fingerprint, fileCells);
      }
      if (fileCells.length > 0) {
        contributed += 1;
        allCells.push(...fileCells);
      }
    }

    sources.push({
      label: 'Amp threads',
      path: threadsDir,
      exists: true,
      files: files.length,
      bytes,
      note:
        (contributed > 0
          ? 'usageLedger events with cache tokens joined from messages[].usage'
          : 'thread files found but none carried token usage') +
        '; format from ccusage Amp adapter, unverified on this machine',
    });
  }

  if (!found) {
    sources.push({
      label: 'Amp threads',
      path: join(dataDirs(ctx)[0] || join(env.home, '.local', 'share', 'amp'), 'threads'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Amp is not installed on this machine (or AMP_DATA_DIR points elsewhere); parser unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
