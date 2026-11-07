/**
 * OpenAI Codex provider.
 *
 * Codex writes rollout JSONL files under `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * plus `<CODEX_HOME>/archived_sessions/*.jsonl`; older rollouts may be zstd-compressed
 * (`*.jsonl.zst` / `*.zstd`, same content). A rollout seen in both forms (or in both directories) is
 * counted once, by file stem. Each line is one envelope
 * `{timestamp, ordinal, type, payload}`:
 *   - `turn_context` payload.model names the model used for the following turns.
 *   - `event_msg` payload.type === 'token_count' carries
 *       info.last_token_usage = { input_tokens, cached_input_tokens, cache_write_input_tokens,
 *                                 output_tokens, reasoning_output_tokens, total_tokens }
 *     `last_token_usage` is a per-response delta (the sibling `total_token_usage` is cumulative),
 *     so summing deltas never double counts. Codex `input_tokens` INCLUDES cached tokens:
 *     total_tokens = input_tokens + output_tokens, therefore uncached input = input - cached.
 *     `reasoning_output_tokens` is already part of `output_tokens`.
 *
 * The `rate_limits` blob on token_count events is intentionally ignored: this dashboard counts
 * tokens, it does not track subscription quotas.
 */

import { basename, join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'codex',
  name: 'Codex',
  color: '#10a37f',
  homepage: 'https://openai.com/codex',
  // v2: skip repeated token_count events whose cumulative total did not change.
  cacheVersion: 2,
};

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];

  /** Rollout stems already counted: the same rollout must not count twice in two forms/places. */
  const seenRollouts = new Set();
  const roots = [];
  const configured = process.env.CODEX_HOME || '';
  if (configured) roots.push(configured);
  roots.push(join(env.home, '.codex'));
  for (const root of [...new Set(roots)]) {
    for (const [label, subdirectory] of [
      ['Codex session rollouts', 'sessions'],
      ['Codex archived sessions', 'archived_sessions'],
    ]) {
      const dir = join(root, subdirectory);
      const stat = await utils.statSafe(dir);
      if (stat === null || !stat.isDirectory) {
        sources.push({ label, path: dir, exists: false, files: 0, bytes: 0 });
        continue;
      }
      const listed = await utils.listFilesRecursive(dir, { exts: ['.jsonl', '.zst', '.zstd'], signal: ctx.signal });
      // Plain JSONL first, so a rollout that exists both plain and compressed is read uncompressed.
      listed.sort((a, b) => Number(utils.isZstdPath(a.path)) - Number(utils.isZstdPath(b.path)));
      const files = [];
      for (const file of listed) {
        const stem = rolloutStem(file.path);
        if (seenRollouts.has(stem)) continue;
        seenRollouts.add(stem);
        files.push(file);
      }
      let bytes = 0;
      for (const file of files) {
        bytes += file.size;
        const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
        let fileCells = cache.get(file.path, fingerprint);
        if (!fileCells) {
          /** @type {Map<string, import('../scanner-types.js').Cell>} */
          const byKey = new Map();
          let currentModel = 'unknown';
          let previousTotal = '';
          try {
            await utils.readJsonl(
              file.path,
              (line) => {
                if (!line.includes('"model"') && !line.includes('token_count')) return;
                const record = utils.safeJsonParse(line);
                if (!record) return;
                const payload = record.payload;
                if (!payload || typeof payload !== 'object') return;
                if (record.type === 'turn_context') {
                  if (typeof payload.model === 'string' && payload.model !== '') currentModel = payload.model;
                  return;
                }
                if (record.type !== 'event_msg' || payload.type !== 'token_count') return;
                const usage = payload.info?.last_token_usage;
                if (!usage || typeof usage !== 'object') return;
                // Codex re-emits token_count (e.g. on rate-limit updates) with the same
                // last_token_usage; an unchanged cumulative total means no new response.
                const cumulative = payload.info?.total_token_usage;
                if (cumulative && typeof cumulative === 'object') {
                  const signature = JSON.stringify(cumulative);
                  if (signature === previousTotal) return;
                  previousTotal = signature;
                }
                const totalInput = num(usage.input_tokens);
                const cacheRead = num(usage.cached_input_tokens);
                const input = Math.max(0, totalInput - cacheRead);
                const output = num(usage.output_tokens);
                const cacheWrite = num(usage.cache_write_input_tokens);
                if (input + output + cacheRead + cacheWrite === 0) return;
                const ts = Date.parse(record.timestamp || '') || 0;
                addUsage(byKey, {
                  model: currentModel,
                  day: utils.localDay(ts),
                  ts,
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  messages: 1,
                });
              },
              { signal: ctx.signal },
            );
          } catch (error) {
            ctx.warn(`Codex: cannot read ${file.path}: ${error?.message || error}`);
            continue;
          }
          fileCells = finalizeCells([...byKey.values()]);
          cache.set(file.path, fingerprint, fileCells);
        }
        if (fileCells.length > 0) allCells.push(...fileCells);
      }
      sources.push({ label, path: dir, exists: true, files: files.length, bytes });
    }
  }

  return { sources, cells: mergeCells(allCells) };
}

/** `rollout-<ts>-<uuid>` without `.jsonl` / `.jsonl.zst` / `.zstd`. @param {string} path */
function rolloutStem(path) {
  return basename(path).replace(/(\.jsonl)?(\.zst|\.zstd)?$/i, '');
}

/** @param {unknown} value */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
