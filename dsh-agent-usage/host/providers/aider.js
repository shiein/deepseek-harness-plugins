/**
 * Aider provider.
 *
 * Aider's chat history (`~/.aider.chat.history.md`) is prose and stores no token counts.
 * The only local usage record is the opt-in analytics log written with
 * `aider --analytics-log FILE` (one JSON object per line; Aider appends to the same
 * `self.logfile` in `aider/analytics.py`). The event that carries usage is
 * `message_send`:
 *
 *   { "event": "message_send",
 *     "properties": { "main_model": "gemini/gemini-2.5-pro", "edit_format": "ask",
 *                     "prompt_tokens": 10006, "completion_tokens": 81,
 *                     "total_tokens": 10087, "cost": 0.0133, "total_cost": 0.0133 },
 *     "user_id": "...", "time": 1755100406 }
 *
 * `time` is Unix seconds; `cost` is the per-message USD cost Aider computed, `total_cost`
 * is cumulative and is not used. There is no default analytics-log path, so this provider
 * looks for `$AIDER_ANALYTICS_LOG` first and then any `analytics*.jsonl|log` file inside
 * `~/.aider/`.
 *
 * NOT VERIFIED ON THIS MACHINE: Aider is not installed here. The field names above come
 * from Aider's official `sample-analytics.jsonl` and `analytics.py` source.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'aider',
  name: 'Aider',
  color: '#0ea5e9',
  homepage: 'https://aider.chat',
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
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];

  const aiderDir = join(env.home, '.aider');
  const historyFile = join(env.home, '.aider.chat.history.md');
  const explicit = utils.expandPath(process.env.AIDER_ANALYTICS_LOG || '');

  /** @type {string[]} */
  const logFiles = [];
  if (explicit) {
    logFiles.push(explicit);
  } else {
    const entries = await utils.readdirSafe(aiderDir);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/analytics/i.test(entry.name)) continue;
      if (!/\.(jsonl|log|ndjson)$/i.test(entry.name)) continue;
      logFiles.push(join(aiderDir, entry.name));
    }
  }

  let contributed = 0;
  for (const filePath of logFiles) {
    const stat = await utils.statSafe(filePath);
    if (stat === null || !stat.isFile) continue;
    const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    let fileCells = cache.get(filePath, fingerprint);
    if (!fileCells) {
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byKey = new Map();
      const raw = await utils.readText(filePath);
      if (raw !== null) {
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue;
          const record = utils.safeJsonParse(line);
          if (!record || typeof record !== 'object') continue;
          if (record.event !== 'message_send') continue;
          const props = record.properties && typeof record.properties === 'object' ? record.properties : {};
          const input = num(props.prompt_tokens);
          const output = num(props.completion_tokens);
          if (input + output === 0) continue;
          const ts = toTs(record.time) || stat.mtimeMs;
          const model = (typeof props.main_model === 'string' && props.main_model) || 'unknown';
          addUsage(byKey, {
            model,
            day: utils.localDay(ts),
            ts,
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: positive(props.cost) || undefined,
            messages: 1,
          });
        }
      }
      fileCells = finalizeCells([...byKey.values()]);
      cache.set(filePath, fingerprint, fileCells);
    }
    if (fileCells.length > 0) contributed += 1;
    allCells.push(...fileCells);
    sources.push({
      label: 'Aider analytics log',
      path: filePath,
      exists: true,
      files: 1,
      bytes: stat.size,
      note: 'message_send events: prompt_tokens/completion_tokens/cost per call; format from Aider analytics.py, unverified on this machine',
    });
  }

  // ---- fallback: the summary lines Aider prints into ~/.aider.chat.history.md ----
  // Aider writes one line per turn such as
  //   Tokens: 1.2k sent, 34 received. Cost: $0.01 message, $0.02 session.
  // after a `# aider chat started at YYYY-MM-DD HH:MM:SS` header. This is plain text
  // (not a stable API), so it is parsed conservatively and only when no structured
  // analytics log exists; an unparsable line is skipped silently.
  if (contributed === 0) {
    const historyStat = await utils.statSafe(historyFile);
    if (historyStat !== null && historyStat.isFile) {
      const fingerprint = `history:${historyStat.size}:${Math.round(historyStat.mtimeMs)}`;
      let historyCells = cache.get(historyFile, fingerprint);
      if (!historyCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        const raw = await utils.readText(historyFile);
        const launchedRe = /^#\s*aider chat started at\s+(.+?)\s*$/;
        const tokensRe = /^>?\s*Tokens:\s*([\d.]+)\s*([kK]?)\s*sent,\s*([\d.]+)\s*([kK]?)\s*received/i;
        const costRe = /Cost:\s*\$([\d.]+)\s*message/i;
        let sessionTs = 0;
        for (const line of (raw || '').split('\n')) {
          const launched = launchedRe.exec(line.trim());
          if (launched) {
            const parsed = Date.parse(launched[1]);
            if (!Number.isNaN(parsed)) sessionTs = parsed;
            continue;
          }
          const match = tokensRe.exec(line.trim());
          if (!match) continue;
          const scale = (suffix) => (suffix && suffix.toLowerCase() === 'k' ? 1000 : 1);
          const input = Math.round(Number(match[1]) * scale(match[2]));
          const output = Math.round(Number(match[3]) * scale(match[4]));
          if (!Number.isFinite(input) || !Number.isFinite(output) || input + output === 0) continue;
          const costMatch = costRe.exec(line);
          const cost = costMatch ? Number(costMatch[1]) : 0;
          const ts = sessionTs || historyStat.mtimeMs;
          addUsage(byKey, {
            model: 'unknown',
            day: utils.localDay(ts),
            ts,
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: Number.isFinite(cost) && cost > 0 ? cost : undefined,
            messages: 1,
          });
        }
        historyCells = finalizeCells([...byKey.values()]);
        cache.set(historyFile, fingerprint, historyCells);
      }
      if (historyCells.length > 0) {
        contributed += 1;
        allCells.push(...historyCells);
        sources.push({
          label: 'Aider chat history',
          path: historyFile,
          exists: true,
          files: 1,
          bytes: historyStat.size,
          note:
            'parsed conservative "Tokens: X sent, Y received. Cost: $Z" summary lines; model unknown; ' +
            'text format is not a stable API and is unverified on this machine',
        });
      }
    }
  }

  if (contributed === 0) {
    const historyStat = await utils.statSafe(historyFile);
    const dirStat = await utils.statSafe(aiderDir);
    if (dirStat !== null || historyStat !== null) {
      sources.push({
        label: 'Aider history',
        path: dirStat !== null ? aiderDir : historyFile,
        exists: true,
        files: 0,
        bytes: historyStat?.size || 0,
        note:
          'Aider was detected but stores no token usage locally: ~/.aider.chat.history.md is prose and ' +
          'usage is only written with `aider --analytics-log FILE` (or $AIDER_ANALYTICS_LOG); parser unverified on this machine',
      });
      ctx.warn(
        'Aider: chat history found but no analytics log with token usage ' +
          '(run aider with --analytics-log FILE to record tokens)',
      );
    } else {
      sources.push({
        label: 'Aider history',
        path: aiderDir,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Aider is not installed on this machine; no analytics log found (token usage is opt-in via --analytics-log)',
      });
    }
  }

  return { sources, cells: mergeCells(allCells) };
}
