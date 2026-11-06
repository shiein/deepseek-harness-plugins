/**
 * Qwen Code provider.
 *
 * Qwen Code is a Gemini CLI fork, so it has two on-disk generations:
 *
 * 1. Current: `$QWEN_DATA_DIR` (default `~/.qwen/projects`), one JSONL file per chat at
 *    `<projects>/<encoded-cwd>/chats/*.jsonl`. Assistant records carry
 *    `usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount,
 *                      totalTokenCount, cachedContentTokenCount }`,
 *    `model`, `uuid`, `sessionId`, `timestamp`.
 * 2. Legacy Gemini-CLI-style: `~/.qwen/tmp/<project>/chats/session-*.json(l)` with
 *    `tokens: { input, output, cached, thoughts, tool, total }` and `type: "gemini"`.
 *
 * `cachedContentTokenCount` / `tokens.cached` is a subset of the prompt/input count.
 * Thoughts are billed at the output rate and are folded into `output`.
 *
 * NOT VERIFIED ON THIS MACHINE: `~/.qwen` does not exist here; format taken from the
 * Qwen Code / Gemini CLI session schemas documented in the research notes.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'qwen-code',
  name: 'Qwen Code',
  color: '#6366f1',
  homepage: 'https://github.com/QwenLM/qwen-code',
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
 * Add one Qwen usage record from either on-disk generation.
 * @param {Map<string, import('../scanner-types.js').Cell>} byKey
 * @param {any} message
 * @param {number} ts
 * @param {string} fallbackModel
 * @param {typeof import('../scan-utils.js')} utils
 * @returns {boolean}
 */
function addQwenMessage(byKey, message, ts, fallbackModel, utils) {
  if (!message || typeof message !== 'object') return false;
  const usage = message.usageMetadata && typeof message.usageMetadata === 'object' ? message.usageMetadata : null;
  if (usage) {
    const cached = num(usage.cachedContentTokenCount);
    const input = Math.max(0, num(usage.promptTokenCount) - cached);
    const output = num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount);
    if (input + output + cached === 0) return false;
    const model = (typeof message.model === 'string' && message.model) || fallbackModel || 'unknown';
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
    return true;
  }
  const tokens = message.tokens && typeof message.tokens === 'object' ? message.tokens : null;
  if (!tokens) return false;
  if (message.type !== undefined && message.type !== 'gemini' && message.type !== 'assistant') return false;
  const cached = num(tokens.cached);
  const input = Math.max(0, num(tokens.input) - cached);
  const output = num(tokens.output) + num(tokens.thoughts);
  if (input + output + cached === 0) return false;
  const model = (typeof message.model === 'string' && message.model) || fallbackModel || 'unknown';
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
  return true;
}

/**
 * @param {string} filePath
 * @param {typeof import('../scan-utils.js')} utils
 * @returns {Promise<{messages: any[], startTime: string} | null>}
 */
async function readGeminiStyleFile(filePath, utils) {
  const raw = await utils.readText(filePath);
  if (raw === null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed.history)
        ? parsed.history
        : null;
    if (messages) return { messages, startTime: parsed.startTime || parsed.lastUpdated || '' };
  } catch {
    // fall through to JSONL
  }
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
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];

  const override = utils.expandPath(process.env.QWEN_DATA_DIR || '');
  const projectsDir = override || join(env.home, '.qwen', 'projects');
  const legacyTmpDir = join(env.home, '.qwen', 'tmp');
  let found = false;

  // ---- current format: <projects>/<cwd>/chats/*.jsonl --------------------
  const projectsStat = await utils.statSafe(projectsDir);
  if (projectsStat !== null && projectsStat.isDirectory) {
    found = true;
    const files = await utils.listFilesRecursive(projectsDir, {
      exts: ['.jsonl'],
      maxDepth: 5,
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
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        /** @type {Set<string>} */
        const seen = new Set();
        try {
          await utils.readJsonl(
            file.path,
            (line) => {
              if (!line.includes('usageMetadata')) return;
              const record = utils.safeJsonParse(line);
              if (!record || typeof record !== 'object') return;
              // Some builds wrap the message; both shapes are accepted.
              const message = record.usageMetadata ? record : record.message && typeof record.message === 'object' ? record.message : null;
              if (!message || !message.usageMetadata) return;
              const key = String(message.uuid || message.id || '');
              if (key !== '') {
                if (seen.has(key)) return;
                seen.add(key);
              }
              addQwenMessage(byKey, message, toTs(message.timestamp) || file.mtimeMs, record.model || 'unknown', utils);
            },
            { signal: ctx.signal },
          );
        } catch (error) {
          ctx.warn(`Qwen Code: cannot read ${file.path}: ${error?.message || error}`);
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
      label: 'Qwen Code chats',
      path: projectsDir,
      exists: true,
      files: files.length,
      bytes,
      note:
        (contributed > 0
          ? 'usageMetadata (prompt/candidates/thoughts/cached) from Qwen Code JSONL chats'
          : 'Qwen Code project tree found but no chat carried usageMetadata') +
        '; format unverified on this machine (~/.qwen absent)',
    });
  } else if (override) {
    sources.push({
      label: 'Qwen Code chats',
      path: projectsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: 'QWEN_DATA_DIR is set but the directory does not exist; parser unverified on this machine',
    });
  }

  // ---- legacy format: ~/.qwen/tmp/<project>/chats/session-*.json(l) -----
  const legacyStat = await utils.statSafe(legacyTmpDir);
  if (legacyStat !== null && legacyStat.isDirectory) {
    found = true;
    const files = await utils.listFilesRecursive(legacyTmpDir, {
      exts: ['.json', '.jsonl'],
      maxDepth: 5,
      maxFiles: 50000,
      signal: ctx.signal,
    });
    const sessionFiles = files.filter((file) => /[\\/]chats[\\/]/.test(file.path) || file.path.includes('session-'));
    let bytes = 0;
    let contributed = 0;
    for (const file of sessionFiles) {
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        const parsed = await readGeminiStyleFile(file.path, utils);
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        if (parsed) {
          for (const message of parsed.messages) {
            addQwenMessage(
              byKey,
              message,
              toTs(message.timestamp) || toTs(parsed.startTime) || file.mtimeMs,
              'unknown',
              utils,
            );
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
      label: 'Qwen Code legacy sessions',
      path: legacyTmpDir,
      exists: true,
      files: sessionFiles.length,
      bytes,
      note:
        (contributed > 0 ? 'Gemini-CLI-style legacy Qwen session files' : 'legacy tree found but no token data') +
        '; format unverified on this machine',
    });
  }

  if (!found) {
    sources.push({
      label: 'Qwen Code data',
      path: join(env.home, '.qwen'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Qwen Code is not installed on this machine; parser follows the documented Qwen/Gemini session format but is unverified here',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}
