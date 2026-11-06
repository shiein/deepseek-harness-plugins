/**
 * Google Gemini CLI provider.
 *
 * Gemini CLI writes one session file per chat under
 * `~/.gemini/tmp/<project>/chats/session-*.json` (older releases, a single JSON document)
 * or `session-*.jsonl` (newer releases, one JSON record per line, with `$set` update
 * markers). Windows uses `%USERPROFILE%\.gemini\tmp\...`.
 *
 * Assistant records (`type: "gemini"`) carry the real token counts:
 *   { id, timestamp, type: "gemini", model,
 *     tokens: { input, output, cached, thoughts, tool, total } }
 * `tokens.cached` is a subset of `tokens.input` (subtract it out), `tokens.thoughts` is
 * billed at the output rate, and `total = input + output + thoughts + tool`. JSONL
 * rewrites the same message id several times, so the latest record per id wins.
 *
 * NOT VERIFIED ON THIS MACHINE: `~/.gemini/tmp` does not exist here (only Antigravity's
 * `~/.gemini/antigravity` tree, which is a different product). The parser follows the
 * observed Gemini CLI format documented in the research notes.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  color: '#4285f4',
  homepage: 'https://github.com/google-gemini/gemini-cli',
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
 * Add one Gemini CLI assistant message.
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 * @param {any} message
 * @param {string} startTime
 * @param {number} fallbackTs
 * @param {typeof import('../scan-utils.js')} utils
 */
function addGeminiMessage(byKey, message, startTime, fallbackTs, utils) {
  if (!message || typeof message !== 'object') return;
  if (message.type !== 'gemini') return;
  const tokens = message.tokens && typeof message.tokens === 'object' ? message.tokens : null;
  if (!tokens) return;
  const model = typeof message.model === 'string' && message.model !== '' ? message.model : 'unknown';
  const cached = num(tokens.cached);
  const input = Math.max(0, num(tokens.input) - cached);
  const output = num(tokens.output) + num(tokens.thoughts);
  if (input + output + cached === 0) return;
  const ts = toTs(message.timestamp) || toTs(startTime) || fallbackTs;
  addUsage(byKey, {
    model,
    day: utils.localDay(ts),
    ts,
    input,
    output,
    cacheRead: cached,
    cacheWrite: 0,
    messages: 1,
  });
}

/**
 * Parse a single-JSON session document (Gemini CLI <= 0.38).
 * @param {any} parsed
 */
function messagesFromJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.history)
      ? parsed.history
      : Array.isArray(parsed.chatHistory)
        ? parsed.chatHistory
        : null;
  if (!messages) return null;
  return { messages, startTime: parsed.startTime || parsed.lastUpdated || '' };
}

/**
 * Parse the JSONL variant: header line plus rewritten message lines.
 * @param {string} raw
 */
function messagesFromJsonl(raw) {
  let startTime = '';
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {string[]} */
  const order = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (record.$set) continue;
    if (typeof record.sessionId === 'string' && (record.startTime || record.kind)) {
      startTime = startTime || record.startTime || '';
      continue;
    }
    if (record.id !== undefined && record.type) {
      const key = String(record.id);
      if (!byId.has(key)) order.push(key);
      byId.set(key, record);
    }
  }
  return { messages: order.map((key) => byId.get(key)), startTime };
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {string[]}
 */
function geminiHomes(ctx) {
  const homes = [];
  const override = ctx.utils.expandPath(process.env.GEMINI_DIR || process.env.GEMINI_CLI_HOME || '');
  if (override) homes.push(override);
  homes.push(join(ctx.env.home, '.gemini'));
  return [...new Set(homes.filter(Boolean))];
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

  for (const home of geminiHomes(ctx)) {
    const tmpDir = join(home, 'tmp');
    const stat = await utils.statSafe(tmpDir);
    if (stat === null || !stat.isDirectory) continue;
    found = true;
    const files = await utils.listFilesRecursive(tmpDir, {
      exts: ['.json', '.jsonl'],
      maxDepth: 5,
      maxFiles: 50000,
      signal: ctx.signal,
    });
    const sessionFiles = files.filter((file) => {
      const base = utils.basenameOf(file.path);
      return base.startsWith('session-') || /[\\/]chats[\\/]/.test(file.path);
    });
    let bytes = 0;
    let contributed = 0;
    for (const file of sessionFiles) {
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        const raw = await utils.readText(file.path);
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        if (raw !== null && raw.trim() !== '') {
          let parsed = null;
          if (/\.jsonl?$/i.test(file.path)) {
            // Try a whole-document JSON parse first; fall back to JSONL.
            let whole = null;
            try {
              whole = JSON.parse(raw);
            } catch {
              whole = null;
            }
            parsed = messagesFromJson(whole);
            if (!parsed) parsed = messagesFromJsonl(raw);
          }
          if (parsed) {
            for (const message of parsed.messages) {
              addGeminiMessage(byKey, message, parsed.startTime, file.mtimeMs, utils);
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
      label: 'Gemini CLI sessions',
      path: tmpDir,
      exists: true,
      files: sessionFiles.length,
      bytes,
      note:
        (contributed > 0
          ? 'tokens from type=gemini messages (input minus cached; output plus thoughts)'
          : 'Gemini CLI tree found but no session files with token data') +
        '; format from observed Gemini CLI logs, NOT verified on this machine (no ~/.gemini/tmp here)',
    });
  }

  if (!found) {
    sources.push({
      label: 'Gemini CLI sessions',
      path: join(geminiHomes(ctx)[0] || join(env.home, '.gemini'), 'tmp'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Gemini CLI is not installed on this machine; parser follows the observed JSON/JSONL session format but is unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
