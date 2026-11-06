/**
 * Aider history provider.
 *
 * Aider appends Markdown to `.aider.chat.history.md` at the directory it was launched in (the
 * git root inside a repo, otherwise the launch directory). The home file
 * `~/.aider.chat.history.md` therefore exists for launches from home; project histories live at
 * `<project>/.aider.chat.history.md`. `AIDER_CHAT_HISTORY_FILE` relocates the file, and the
 * plugin config may list extra project histories in `aiderHistoryFiles`.
 *
 * One file contains many sessions. A session begins with
 *   # aider chat started at YYYY-MM-DD HH:MM:SS
 * and then interleaves:
 *   #### <prompt>          starts or continues a user message (outside fenced code blocks)
 *   plain Markdown         assistant output
 *   > <tool output>        tool/system output; it terminates an assistant block and is not indexed
 * Aider records no message timestamps and no session id, so every message uses the session start
 * and the stable id is derived from the history path and that start time. Fenced code blocks are
 * tracked so a `#### ` or `>` line inside them stays conversation content.
 *
 * `~/.aider/analytics.jsonl` (or `$AIDER_ANALYTICS_LOG`) is also detected; it contains token
 * accounting events, not conversation text, so sessions never come from it.
 *
 * Resume: aider refuses to reopen one session (it needs `--restore-chat-history`, which reloads
 * the whole file), so resume.kind is 'none'.
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readText } from '../scan-utils.js';

export const meta = {
  id: 'aider',
  name: 'Aider',
  color: '#0ea5e9',
  homepage: 'https://aider.chat',
  cacheVersion: 2,
  resume: { kind: 'none' },
};

const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;

/**
 * Cache access that tolerates both the documented 2-arg CacheFace (the scanner now binds the
 * provider id) and the 3-arg HistoryCache the self-test still passes. Never throws.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 * @returns {any[]|undefined}
 */
function cacheGet(ctx, filePath, fingerprint) {
  const cache = ctx.cache;
  if (!cache || typeof cache.get !== 'function') return undefined;
  try {
    return cache.get.length >= 3 ? cache.get(ctx.providerId, filePath, fingerprint) : cache.get(filePath, fingerprint);
  } catch {
    return undefined;
  }
}

/** @param {import('../types.js').ScanContext} ctx */
function cacheSet(ctx, filePath, fingerprint, rows) {
  const cache = ctx.cache;
  if (!cache || typeof cache.set !== 'function') return;
  try {
    if (cache.set.length >= 4) cache.set(ctx.providerId, filePath, fingerprint, rows);
    else cache.set(filePath, fingerprint, rows);
  } catch {
    // ignore
  }
}

/**
 * Local wall-clock `YYYY-MM-DD HH:MM:SS` header -> epoch ms. Aider writes local time, so the
 * timestamp is built component-wise (Date.parse would treat it as UTC in some engines).
 * @param {string} value
 * @returns {number}
 */
function parseLocalTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return 0;
  const epoch = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(epoch) && epoch > 0 ? epoch : 0;
}

/** @param {number} epochMs @returns {string} `YYYYMMDDTHHMMSS` in local time */
function stampForId(epochMs) {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '00000000T000000';
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** @param {string} filePath @returns {string} 8 hex chars, stable per history path */
function pathHash(filePath) {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 8);
}

/**
 * Aider's own slash/shell commands are logged as `#### ` lines but are not chat turns. Only
 * names aider actually has are dropped, so a question that merely starts with a path
 * ("/etc/hosts is wrong on the build box") stays a user message.
 */
const AIDER_COMMANDS = new Set([
  'add', 'architect', 'ask', 'chat-mode', 'clear', 'clipboard', 'code', 'commit', 'context',
  'copy', 'copy-context', 'diff', 'drop', 'edit', 'editor', 'editor-model', 'exit', 'git',
  'help', 'lint', 'load', 'ls', 'map', 'map-refresh', 'model', 'models', 'multiline-mode',
  'paste', 'quit', 'read-only', 'reasoning-effort', 'report', 'reset', 'run', 'save',
  'settings', 'test', 'think-tokens', 'tokens', 'undo', 'voice', 'weak-model', 'web',
]);

/**
 * True for an aider command line (`/add`, `/run`, ...) or a shell line (`!cmd`). None of those
 * is part of the conversation the user had with the model.
 * @param {string} text
 * @returns {boolean}
 */
function isAiderCommand(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('!')) return true;
  if (!trimmed.startsWith('/') || trimmed.length < 2) return false;
  const token = trimmed.slice(1).split(/[ \t]/, 1)[0].toLowerCase();
  if (token === 'run' || token === 'test' || token === 'git') return true;
  return AIDER_COMMANDS.has(token);
}

/**
 * Walk one Markdown history file and return the raw sessions (in file order), mirroring
 * aider's own writer:
 *   - a `#### ` line starts a user turn, or continues the current user turn when two arrive in a
 *     row (multiline prompts);
 *   - a plain Markdown line after a user turn starts the assistant reply;
 *   - a `> ` (or bare `>`) line is tool/system output: it ends the current block and is not a
 *     message, and the unprefixed lines under it belong to it until a blank line;
 *   - nothing before a session's first `#### ` is speech (banner / --verbose dump);
 *   - fenced code blocks are content, so markers inside them never change roles.
 * @param {string} raw
 * @param {number} fileMtimeMs
 * @returns {{startTs: number, sizeBytes: number, messages: {role: 'user'|'assistant', ts: number, text: string}[]}[]}
 */
function extractSessions(raw, fileMtimeMs) {
  /** @type {{startTs: number, sizeBytes: number, messages: {role: 'user'|'assistant', ts: number, text: string}[]}[]} */
  const sessions = [];
  /** @type {{startTs: number, sizeBytes: number, messages: {role: 'user'|'assistant', ts: number, text: string}[]}|null} */
  let current = null;
  /** @type {'user'|'assistant'|''} */
  let role = '';
  /** @type {string[]} */
  let buffer = [];
  let inFence = false;
  let afterOutput = false;
  let seenUser = false;

  const flush = () => {
    if (current === null || buffer.length === 0) {
      role = '';
      buffer = [];
      return;
    }
    const text = buffer.join('\n').trim();
    if (text !== '' && role !== '') current.messages.push({ role, ts: current.startTs, text: clip(text, MAX_TEXT * 2) });
    role = '';
    buffer = [];
  };
  const finish = () => {
    flush();
    if (current !== null) sessions.push(current);
    current = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(/\s+$/, '');
    if (current !== null) current.sizeBytes += Buffer.byteLength(line) + 1;
    if (!inFence && clean.startsWith('# aider chat started at ')) {
      finish();
      const startTs = parseLocalTimestamp(clean.slice('# aider chat started at '.length).trim()) || fileMtimeMs;
      current = { startTs, sizeBytes: Buffer.byteLength(line) + 1, messages: [] };
      role = '';
      buffer = [];
      inFence = false;
      afterOutput = false;
      seenUser = false;
      continue;
    }
    if (current === null) continue;
    if (clean.startsWith('```')) {
      inFence = !inFence;
      afterOutput = false;
      if (role === '') role = 'assistant';
      buffer.push(line);
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }
    if (clean.startsWith('#### ')) {
      afterOutput = false;
      seenUser = true;
      if (role !== 'user') flush();
      const prompt = clean.slice(5);
      if (prompt === '' || isAiderCommand(prompt)) {
        flush();
        role = '';
        continue;
      }
      if (role !== 'user') {
        flush();
        role = 'user';
      }
      buffer.push(prompt === '<blank>' ? '' : prompt);
      continue;
    }
    if (clean.startsWith('> ') || clean === '>') {
      flush();
      afterOutput = true;
      continue;
    }
    if (clean.trim() === '') {
      afterOutput = false;
      buffer.push('');
      continue;
    }
    if (afterOutput || !seenUser) continue;
    if (role !== 'assistant') {
      flush();
      role = 'assistant';
    }
    buffer.push(line);
  }
  finish();
  return sessions;
}

/**
 * Shape raw sessions into provider rows; ids are `<file hash>-<local start>` plus `-2`, `-3` when
 * the same file starts two sessions in the same second.
 * @param {{startTs: number, sizeBytes: number, messages: {role: 'user'|'assistant', ts: number, text: string}[]}[]} sessions
 * @param {string} filePath
 * @param {string} projectPath
 * @returns {any[]}
 */
function buildRows(sessions, filePath, projectPath) {
  /** @type {any[]} */
  const rows = [];
  const seenBase = new Map();
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const textMessages = session.messages.filter((message) => message.text.trim() !== '');
    if (textMessages.length === 0) continue;
    const userTexts = textMessages.filter((message) => message.role === 'user');
    const baseId = `aider-${pathHash(filePath)}-${stampForId(session.startTs)}`;
    const count = (seenBase.get(baseId) || 0) + 1;
    seenBase.set(baseId, count);
    const nativeId = count === 1 ? baseId : `${baseId}-${count}`;
    const firstPrompt = userTexts.length > 0 ? userTexts[0].text : textMessages[0].text;
    const lastText = textMessages[textMessages.length - 1].text;
    rows.push({
      nativeId,
      title: titleFromPrompt(firstPrompt, 90) || '未命名会话',
      projectPath,
      startedAt: session.startTs,
      updatedAt: session.startTs,
      messages: textMessages.length,
      userMessages: userTexts.length,
      sizeBytes: session.sizeBytes,
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastText).slice(0, 220),
      sourcePath: filePath,
      ref: { file: filePath, nativeId, index },
    });
  }
  return rows;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @returns {Promise<any[]>}
 */
async function scanHistoryFile(ctx, filePath) {
  const { utils } = ctx;
  const stat = await utils.statSafe(filePath);
  if (stat === null || !stat.isFile) return [];
  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}:v2`;
  const cached = cacheGet(ctx, filePath, fingerprint);
  if (cached) return cached;
  const raw = await readText(filePath);
  if (raw === null) return [];
  const rows = buildRows(extractSessions(raw, stat.mtimeMs), filePath, dirname(filePath));
  cacheSet(ctx, filePath, fingerprint, rows);
  return rows;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];

  /** @type {string[]} */
  const historyFiles = [];
  const explicit = (process.env.AIDER_CHAT_HISTORY_FILE || '').trim();
  if (explicit !== '') historyFiles.push(explicit.replace(/^~(?=$|[\\/])/, env.home));
  const config = env.config && typeof env.config === 'object' ? env.config : {};
  const configured = config.aiderHistoryFiles;
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry === 'string' && entry.trim() !== '') historyFiles.push(entry.trim().replace(/^~(?=$|[\\/])/, env.home));
    }
  }
  historyFiles.push(join(env.home, '.aider.chat.history.md'));

  let foundHistory = false;
  for (const filePath of [...new Set(historyFiles)]) {
    const stat = await utils.statSafe(filePath);
    if (stat === null || !stat.isFile) {
      sources.push({
        label: 'Aider chat history',
        path: filePath,
        exists: false,
        files: 0,
        bytes: 0,
        note:
          filePath === join(env.home, '.aider.chat.history.md')
            ? 'Aider is not installed (no ~/.aider.chat.history.md)'
            : 'configured Aider history file does not exist',
      });
      continue;
    }
    foundHistory = true;
    sessions.push(...(await scanHistoryFile(ctx, filePath)));
    sources.push({
      label: 'Aider chat history',
      path: filePath,
      exists: true,
      files: 1,
      bytes: stat.size,
      note: 'Markdown chat log; sessions split on "# aider chat started at" headers',
    });
  }

  // Analytics logs carry token accounting, not conversation text; report them but never derive
  // sessions from them.
  const analyticsCandidates = [];
  const analyticsOverride = (process.env.AIDER_ANALYTICS_LOG || '').trim();
  if (analyticsOverride !== '') analyticsCandidates.push(analyticsOverride.replace(/^~(?=$|[\\/])/, env.home));
  const aiderDir = join(env.home, '.aider');
  for (const entry of await utils.readdirSafe(aiderDir)) {
    if (!entry.isFile() || !/analytics/i.test(entry.name) || !/\.(jsonl|log|ndjson)$/i.test(entry.name)) continue;
    analyticsCandidates.push(join(aiderDir, entry.name));
  }
  for (const filePath of [...new Set(analyticsCandidates)]) {
    const stat = await utils.statSafe(filePath);
    if (stat === null || !stat.isFile) continue;
    sources.push({
      label: 'Aider analytics log',
      path: filePath,
      exists: true,
      files: 1,
      bytes: stat.size,
      note: 'message_send token events; contains no conversation text and is not used for sessions',
    });
  }

  if (foundHistory && sessions.length === 0) {
    ctx.warn('Aider: history file found but contains no readable "aider chat started" session with conversation text');
  }

  return { sources, sessions };
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  const stat = await ctx.utils.statSafe(filePath);
  const raw = await readText(filePath);
  if (raw === null) return { messages: [] };
  const rawSessions = extractSessions(raw, stat?.mtimeMs || Date.now());
  const rows = buildRows(rawSessions, filePath, dirname(filePath));
  const wanted = session?.ref?.nativeId || session?.nativeId;
  let row = rows.find((candidate) => candidate.nativeId === wanted);
  if (!row) {
    const index = Number(session?.ref?.index);
    if (Number.isInteger(index) && index >= 0 && index < rows.length) row = rows[index];
  }
  if (!row) return { messages: [] };
  const index = Number(row.ref?.index);
  const rawSession = Number.isInteger(index) && index >= 0 ? rawSessions[index] : null;
  if (!rawSession) return { messages: [] };
  /** @type {any[]} */
  const messages = [];
  for (const message of rawSession.messages) {
    if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
    if (message.text.trim() === '') continue;
    messages.push({ role: message.role, ts: message.ts, text: message.text.slice(0, MAX_TEXT) });
  }
  return { messages };
}
