/**
 * Factory Droid provider (Factory's Droid CLI).
 *
 * Droid writes `$FACTORY_DIR` (default `~/.factory`) under `sessions/<subdir>/*.jsonl`.
 * The first JSONL line is a `session_start` entry with the session id/cwd/timestamp;
 * conversation entries contain `message.role` / `message.content` blocks. Token usage is
 * NOT per message — it is only recorded once per session in the companion file next to
 * the transcript, `<name>.settings.json`:
 *
 *   { "model": "custom:GLM-5.1-[Proxy]-0",
 *     "tokenUsage": { "inputTokens", "outputTokens", "cacheCreationTokens",
 *                     "cacheReadTokens", "thinkingTokens" } }
 *
 * Because the totals are session-level, they are split evenly across the assistant calls
 * found in the transcript (remainder on the last call), exactly like the upstream Droid
 * adapter does; day attribution follows each call's entry timestamp. `thinkingTokens` are
 * billed like output and are folded into `output`.
 *
 * NOT VERIFIED ON THIS MACHINE: only `~/.factory/settings.json` exists here (no
 * `~/.factory/sessions`), so the parser follows the Droid format documented upstream.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'factory-droid',
  name: 'Factory Droid',
  color: '#22c55e',
  homepage: 'https://factory.ai',
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

/** @param {unknown} content @returns {boolean} */
function hasAssistantOutput(content) {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && (block.type === 'text' || block.type === 'tool_use'));
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

  const base = utils.expandPath(process.env.FACTORY_DIR || '') || join(env.home, '.factory');
  const sessionsDir = join(base, 'sessions');
  const sessionsStat = await utils.statSafe(sessionsDir);
  if (sessionsStat === null || !sessionsStat.isDirectory) {
    sources.push({
      label: 'Droid sessions',
      path: sessionsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Factory Droid sessions are not present on this machine; parser unverified here (format from the upstream Droid adapter)',
    });
    return { sources, cells: [] };
  }

  const files = await utils.listFilesRecursive(sessionsDir, { exts: ['.jsonl'], maxDepth: 4, maxFiles: 50000, signal: ctx.signal });
  let bytes = 0;
  let contributed = 0;
  let settingsWithoutUsage = 0;

  for (const file of files) {
    bytes += file.size;
    const settingsPath = file.path.replace(/\.jsonl$/i, '.settings.json');
    const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
    let fileCells = cache.get(file.path, fingerprint);
    if (!fileCells) {
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byKey = new Map();
      const raw = await utils.readText(file.path);
      if (raw !== null) {
        const lines = raw.split('\n').filter((line) => line.trim() !== '');
        let startTs = 0;
        /** @type {number[]} */
        const callTimestamps = [];
        if (lines.length > 0) {
          const first = utils.safeJsonParse(lines[0]);
          if (first && first.type === 'session_start') startTs = toTs(first.timestamp) || file.mtimeMs;
        }
        for (const line of lines) {
          if (!line.includes('"assistant"')) continue;
          const entry = utils.safeJsonParse(line);
          if (!entry || !entry.message || entry.message.role !== 'assistant') continue;
          if (!hasAssistantOutput(entry.message.content)) continue;
          callTimestamps.push(toTs(entry.timestamp) || startTs || file.mtimeMs);
        }
        const settingsRaw = await utils.readText(settingsPath);
        const settings = utils.safeJsonParse(settingsRaw || '');
        const usage = settings && settings.tokenUsage && typeof settings.tokenUsage === 'object' ? settings.tokenUsage : null;
        if (usage) {
          const totalInput = num(usage.inputTokens);
          const totalOutput = num(usage.outputTokens) + num(usage.thinkingTokens);
          const totalCacheRead = num(usage.cacheReadTokens);
          const totalCacheWrite = num(usage.cacheCreationTokens);
          const calls = callTimestamps.length > 0 ? callTimestamps : [startTs || file.mtimeMs];
          const count = calls.length;
          const model = (settings && typeof settings.model === 'string' && settings.model) || 'unknown';
          const perInput = Math.floor(totalInput / count);
          const perOutput = Math.floor(totalOutput / count);
          const perCacheRead = Math.floor(totalCacheRead / count);
          const perCacheWrite = Math.floor(totalCacheWrite / count);
          for (let index = 0; index < count; index += 1) {
            const last = index === count - 1;
            const ts = calls[index] || file.mtimeMs;
            addUsage(byKey, {
              model,
              day: utils.localDay(ts),
              ts,
              input: last ? totalInput - perInput * (count - 1) : perInput,
              output: last ? totalOutput - perOutput * (count - 1) : perOutput,
              cacheRead: last ? totalCacheRead - perCacheRead * (count - 1) : perCacheRead,
              cacheWrite: last ? totalCacheWrite - perCacheWrite * (count - 1) : perCacheWrite,
              messages: 1,
            });
          }
        } else {
          settingsWithoutUsage += 1;
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

  if (files.length > 0 && contributed === 0 && settingsWithoutUsage > 0) {
    ctx.warn(
      'Factory Droid: session transcripts found but no <name>.settings.json with tokenUsage (no local token data)',
    );
  }

  sources.push({
    label: 'Droid sessions',
    path: sessionsDir,
    exists: true,
    files: files.length,
    bytes,
    note:
      (contributed > 0
        ? 'session-level settings.tokenUsage split evenly across assistant calls'
        : 'transcripts found but no settings.tokenUsage to report') + '; format unverified on this machine',
  });

  return { sources, cells: mergeCells(allCells) };
}
