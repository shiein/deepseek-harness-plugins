/**
 * Pi coding agent provider.
 *
 * Pi (`@earendil-works/pi-coding-agent`, binary `pi`) writes one JSONL transcript per
 * session under `<agent-dir>/sessions/--<cwd-hash>--/<timestamp>_<uuid>.jsonl`.
 * The agent directory is `PI_CODING_AGENT_DIR` or `~/.pi/agent`; the session directory
 * can be relocated with `PI_CODING_AGENT_SESSION_DIR` (same as `--session-dir`).
 *
 * Session files are JSONL with `type`-tagged entries (see Pi docs `session-format.md`):
 *   { type: 'message', message: { role: 'assistant', model, timestamp,
 *       usage: { input, output, cacheRead, cacheWrite, reasoning, totalTokens,
 *                cost: { input, output, cacheRead, cacheWrite, total } } } }
 *   { type: 'usage', kind, provider, model, timestamp, usage: {...} }
 *   { type: 'compaction', ..., usage: {...} }   // summarization usage, optional
 *   { type: 'model_change', modelId }
 *
 * `usage.reasoning` is documented as already included in `usage.output`, so it is not
 * added again. `usage.cost.total` is the USD cost Pi recorded for that call.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'pi',
  name: 'Pi',
  color: '#8b5cf6',
  homepage: 'https://github.com/earendil-works/pi',
  cacheVersion: 3, // 3: rows carry the session folder (header `cwd`)
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

/**
 * Accept a string only if it plausibly is a Pi model id: no whitespace/control chars,
 * contains a letter, and is at least two characters long. This rejects the one-character
 * model ids ("a"/"b") written by Pi's integration fixtures together with other stray
 * strings, without filtering real ids such as `deepseek-flash`, `gpt-5.5` or
 * `openai/gpt-5.5`. Returns the trimmed id, or '' when unusable.
 * @param {unknown} value
 * @returns {string}
 */
function plausibleModelId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (id.length < 2 || id.length > 160) return '';
  if (!/[A-Za-z]/.test(id)) return '';
  if (/\s/.test(id)) return '';
  return id;
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
function sessionDirs(ctx) {
  const { utils, env } = ctx;
  const dirs = [];
  const overrideSessions = utils.expandPath(process.env.PI_CODING_AGENT_SESSION_DIR || '');
  const overrideAgent = utils.expandPath(process.env.PI_CODING_AGENT_DIR || '');
  if (overrideSessions) dirs.push(overrideSessions);
  if (overrideAgent) dirs.push(join(overrideAgent, 'sessions'));
  if (!overrideSessions && !overrideAgent) dirs.push(join(env.home, '.pi', 'agent', 'sessions'));
  return [...new Set(dirs.filter(Boolean))];
}

/**
 * Parse one Pi session file. `addUsage` keys cells by (model, day, tier).
 * @param {string} filePath
 * @param {number} fallbackTs
 * @param {typeof import('../scan-utils.js')} utils
 * @param {AbortSignal} signal
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 */
async function parseSessionFile(filePath, fallbackTs, utils, signal, byKey) {
  let resolvedModel = 'unknown';
  let cwd = '';
  /** @type {Set<string>} same-file duplicate guard (entry id + timestamp + model) */
  const seen = new Set();
  await utils.readJsonl(
    filePath,
    (line) => {
      // Cheap prefilter: only these entry kinds can carry usage (plus the session header's cwd).
      const header = cwd === '' && line.startsWith('{"type":"session"');
      if (!header && !line.includes('usage') && !line.includes('model_change') && !line.includes('modelId')) return;
      const record = utils.safeJsonParse(line);
      if (!record || typeof record !== 'object') return;
      if (record.type === 'session') {
        if (typeof record.cwd === 'string') cwd = record.cwd;
        return;
      }

      if (record.type === 'model_change') {
        const changed = plausibleModelId(record.modelId) || plausibleModelId(record.model);
        if (changed !== '') resolvedModel = changed;
        return;
      }

      let usage = null;
      let model = resolvedModel;
      let ts = toTs(record.timestamp) || fallbackTs;

      if (record.type === 'message') {
        const message = record.message;
        // assistant responses and toolResult entries (which can bill cache/tool tokens).
        if (!message || (message.role !== 'assistant' && message.role !== 'toolResult')) return;
        usage = message.usage;
        const messageModel = plausibleModelId(message.model);
        if (messageModel !== '') model = messageModel;
        ts = toTs(message.timestamp) || ts;
      } else if (record.type === 'usage' || record.type === 'model_usage') {
        // `usage` is the Pi entry kind; `model_usage` is the same shape used by OMP forks.
        usage = record.usage && typeof record.usage === 'object' ? record.usage : record;
        const recordModel = plausibleModelId(record.model);
        if (recordModel !== '') model = recordModel;
      } else if (record.type === 'compaction' || record.type === 'branch_summary') {
        usage = record.usage;
      } else {
        return;
      }

      if (!usage || typeof usage !== 'object') return;
      model = plausibleModelId(model) || 'unknown';
      const input = num(usage.input);
      const output = num(usage.output);
      const cacheRead = num(usage.cacheRead);
      const cacheWrite = num(usage.cacheWrite);
      if (input + output + cacheRead + cacheWrite === 0) return;
      // Forked Pi sessions preserve entry ids/timestamps; dedupe within the file so a
      // repeated entry (id+timestamp+model) is only counted once.
      const dedupeKey = `${record.id || ''}\u0000${ts}\u0000${model}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const cost = usage.cost && typeof usage.cost === 'object' ? positive(usage.cost.total) : 0;
      addUsage(byKey, {
        model,
        project: cwd,
        day: utils.localDay(ts),
        ts,
        input,
        output,
        cacheRead,
        cacheWrite,
        costUsd: cost || undefined,
        messages: 1,
      });
    },
    { signal },
  );
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
  const roots = sessionDirs(ctx);
  let found = false;

  for (const sessionsDir of roots) {
    const stat = await utils.statSafe(sessionsDir);
    if (stat === null || !stat.isDirectory) continue;
    found = true;
    const files = await utils.listFilesRecursive(sessionsDir, { exts: ['.jsonl'], signal: ctx.signal });
    let bytes = 0;
    let parsedFiles = 0;
    let contributed = 0;
    for (const file of files) {
      bytes += file.size;
      parsedFiles += 1;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        try {
          await parseSessionFile(file.path, file.mtimeMs, utils, ctx.signal, byKey);
        } catch (error) {
          ctx.warn(`Pi: cannot read ${file.path}: ${error?.message || error}`);
          continue;
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
      label: 'Pi sessions',
      path: sessionsDir,
      exists: true,
      files: parsedFiles,
      bytes,
      note:
        contributed > 0
          ? 'assistant usage + usage entries + compaction usage from Pi session JSONL'
          : 'Pi session files found but none carried token usage',
    });
  }

  if (!found) {
    sources.push({
      label: 'Pi sessions',
      path: roots[0] || join(env.home, '.pi', 'agent', 'sessions'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Pi is not installed on this machine (or PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR point elsewhere)',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
