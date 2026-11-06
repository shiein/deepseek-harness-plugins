/**
 * DeepSeek Harness (DSH) history provider — the harness's own agent sessions.
 *
 * DSH appends one JSON event per line to
 * `<home>/.dsh/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd` (older stores use
 * `session.v3.jsonl.zstd`). The file is a concatenation of zstd frames (one frame per appended
 * record), so it must be decoded with `zstdDecompressAll`, never `zstdDecompressSync`.
 *
 * Line 0 is a `session` header (`id`, `createdAt`, `cwd`, `agentPreset`, ...); every following line
 * is an event with `seq`, `time` (epoch ms) and `data`. The interesting events are
 * `session/title`, `user/message`, `assistant/message`, `tool/call` and `tool/result`.
 *
 * Resume: the DSH Web GUI reopens these sessions by native id (`resume.kind === 'dsh'`), so the
 * client half handles the launch — the host only reports the session id.
 */

import { basename, dirname } from 'node:path';
import { cleanPrompt, titleFromPrompt } from '../model.js';
import { readBuffer, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  color: '#4d6bfe',
  homepage: 'https://github.com/deepseek-ai',
  cacheVersion: 1,
  resume: { kind: 'dsh' },
};

/**
 * User-message `source.kind` values that are harness-injected context (runtime snapshot, skill
 * catalogue, time context, ...) rather than something a human typed. They must not become a
 * preview/title or a transcript bubble.
 */
const INJECTED_USER_KINDS = new Set([
  'runtime-context',
  'skill-catalog',
  'time-context',
  'tool-jobs',
  'subagent-settled',
  'working-directory',
  'agent-instructions',
  'plugin',
  'model-selection',
  'user-approval',
]);

const MAX_FILES = 20000;
const MAX_MESSAGES = 4000;
const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 900;

/**
 * @param {import('../types.js').ScanContext} ctx
 * @returns {Promise<{sources: import('../types.js').SourceInfo[], sessions: any[]}>}
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  const sources = [];
  const sessions = [];

  const root = utils.join(env.home, '.dsh', 'sessions');
  const probe = await utils.statSafe(root);
  if (probe === null || !probe.isDirectory) {
    sources.push({ label: 'DeepSeek Harness sessions', path: root, exists: false, files: 0, bytes: 0 });
    return { sources, sessions };
  }

  const files = await utils.listFilesRecursive(root, {
    exts: ['.zstd', '.jsonl', '.zst'],
    maxFiles: MAX_FILES,
    signal: ctx.signal,
  });
  let filesRead = 0;
  let bytes = 0;
  for (const file of files) {
    if (ctx.signal?.aborted) break;
    bytes += file.size;
    const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
    let rows = cacheGet(ctx, file.path, fingerprint);
    if (!rows) {
      try {
        rows = await parseSessionFile(ctx, file.path, file.size);
      } catch (error) {
        ctx.warn(`DeepSeek Harness: cannot read ${file.path}: ${error?.message || error}`);
        continue;
      }
      cacheSet(ctx, file.path, fingerprint, rows);
    }
    filesRead += 1;
    sessions.push(...rows);
  }

  sources.push({
    label: 'DeepSeek Harness sessions',
    path: root,
    exists: true,
    files: filesRead,
    bytes,
    note: 'one multi-frame zstd event log per session under <encoded-cwd>/<session-id>/',
  });
  return { sources, sessions };
}

/**
 * Parse one session log into zero or one session summary. Metadata only: no message bodies are
 * kept beyond the previews.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {number} sizeBytes
 * @returns {Promise<any[]>}
 */
async function parseSessionFile(ctx, filePath, sizeBytes) {
  const lines = await readLines(ctx, filePath);
  if (lines === null) return [];
  let header = null;
  let nativeId = '';
  let projectPath = '';
  let createdAt = 0;
  let startedAt = 0;
  let updatedAt = 0;
  let userMessages = 0;
  let messages = 0;
  let firstPrompt = '';
  let firstHumanPrompt = '';
  let lastPreview = '';
  let lastPreviewAt = 0;
  let bestTitle = '';
  let bestTitleRank = -1;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const record = safeJsonParse(line);
    if (!record) continue;

    if (record.type === 'session') {
      if (header === null) header = record;
      continue;
    }

    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const ts = Number(record.time) || 0;
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }

    if (record.type === 'session/title') {
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (title === '') continue;
      const rank = titleRank(data.source);
      if (rank >= bestTitleRank) {
        bestTitle = title;
        bestTitleRank = rank;
      }
      continue;
    }

    if (record.type === 'user/message') {
      if (!isRealUserMessage(data)) continue;
      const body = userText(data.content);
      if (body.trim() === '') continue;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = body;
      if (firstHumanPrompt === '' && isHumanUserMessage(data)) firstHumanPrompt = body;
      if (ts >= lastPreviewAt) {
        lastPreview = body;
        lastPreviewAt = ts;
      }
      continue;
    }

    if (record.type === 'assistant/message') {
      const body = assistantText(data);
      if (body.trim() === '') continue;
      messages += 1;
      if (ts >= lastPreviewAt) {
        lastPreview = body;
        lastPreviewAt = ts;
      }
    }
  }

  if (header !== null) {
    if (typeof header.id === 'string' && header.id.trim() !== '') nativeId = header.id.trim();
    if (typeof header.cwd === 'string' && header.cwd.trim() !== '') projectPath = header.cwd.trim();
    const created = Number(header.createdAt);
    if (Number.isFinite(created) && created > 0) createdAt = created;
  }
  // The session directory is named after the session id, so it is a safe fallback.
  if (nativeId === '') nativeId = basename(dirname(filePath));
  if (messages === 0) return [];

  const prompt = firstHumanPrompt || firstPrompt;
  const resolvedTitle = bestTitleRank >= 1 ? bestTitle : titleFromPrompt(prompt, 90);
  return [
    {
      nativeId,
      title: resolvedTitle || '未命名会话',
      projectPath,
      startedAt: startedAt || createdAt,
      updatedAt: updatedAt || startedAt || createdAt,
      messages,
      userMessages,
      sizeBytes,
      preview: cleanPrompt(prompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: filePath,
      extra: header !== null && typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
      ref: { file: filePath },
    },
  ];
}

/**
 * Read the readable transcript of one session.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  const lines = await readLines(ctx, filePath);
  if (lines === null) return { messages: [] };

  /** @type {any[]} */
  const messages = [];
  /** @type {Map<string, string>} */
  const callNames = new Map();

  for (const line of lines) {
    if (messages.length >= MAX_MESSAGES) break;
    if (line.trim() === '') continue;
    const record = safeJsonParse(line);
    if (!record) continue;
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const ts = Number(record.time) || 0;

    if (record.type === 'user/message') {
      if (!isRealUserMessage(data)) continue;
      const body = userText(data.content);
      if (body.trim() === '') {
        if (hasImage(data.content)) messages.push({ role: 'user', ts, text: '[图片]' });
        continue;
      }
      messages.push({ role: 'user', ts, text: truncate(body, MAX_TEXT) });
      continue;
    }

    if (record.type === 'assistant/message') {
      const content = assistantContent(data);
      const model = assistantModel(data);
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          messages.push({ role: 'assistant', ts, text: truncate(block.text, MAX_TEXT), name: model });
        } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
          messages.push({ role: 'assistant', ts, text: truncate(block.text, MAX_TEXT), kind: 'thinking' });
        } else if (block.type === 'tool-call') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          if (typeof block.id === 'string' && block.id !== '') callNames.set(block.id, name);
          messages.push({
            role: 'tool',
            ts,
            kind: 'tool-call',
            name,
            text: truncate(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}), MAX_TOOL_TEXT),
          });
        }
      }
      continue;
    }

    if (record.type === 'tool/result') {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const name = callNames.get(callId);
      const body = toolResultText(data.message?.content);
      if (body.trim() === '') continue;
      messages.push({
        role: 'tool',
        ts,
        kind: 'tool-result',
        name: name || (typeof data.name === 'string' ? data.name : undefined),
        text: truncate(body, MAX_TOOL_TEXT * 2),
      });
    }
  }

  return { messages };
}

/**
 * Read and decode one DSH session log into lines. Returns null when the file cannot be read.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @returns {Promise<string[]|null>}
 */
async function readLines(ctx, filePath) {
  const buffer = await readBuffer(filePath);
  if (!buffer || buffer.length === 0) return null;
  let text;
  try {
    text = ctx.utils.isZstd(buffer) ? ctx.utils.zstdDecompressAll(buffer).toString('utf8') : buffer.toString('utf8');
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r?\n/);
}

/**
 * Cache face adapter: CONTRACT.md documents `get(filePath, fingerprint)` while the current Host
 * cache is keyed per provider (`get(providerId, filePath, fingerprint)`). Support both by arity so
 * the provider works before and after the framework is normalized.
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 */
function cacheGet(ctx, filePath, fingerprint) {
  const cache = ctx.cache;
  if (!cache || typeof cache.get !== 'function') return undefined;
  try {
    const rows = cache.get.length >= 3 ? cache.get(ctx.providerId, filePath, fingerprint) : cache.get(filePath, fingerprint);
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fingerprint
 * @param {any[]} rows
 */
function cacheSet(ctx, filePath, fingerprint, rows) {
  const cache = ctx.cache;
  if (!cache || typeof cache.set !== 'function') return;
  try {
    if (cache.set.length >= 4) cache.set(ctx.providerId, filePath, fingerprint, rows);
    else cache.set(filePath, fingerprint, rows);
  } catch {
    // A broken cache must never fail a scan; the rows are already in memory.
  }
}

/** @param {any} source */
function titleRank(source) {
  const kind = source && typeof source === 'object' ? source.kind : undefined;
  if (kind === 'provider' || kind === 'user') return 2;
  if (kind === 'fallback') return 1;
  return kind ? 2 : 1;
}

/** A message a human actually typed (as opposed to a notice or another agent's message). */
/** @param {any} data */
function isHumanUserMessage(data) {
  const source = data && typeof data === 'object' ? data.source : undefined;
  const kind = source && typeof source === 'object' ? source.kind : undefined;
  return typeof kind !== 'string' || kind === '' || kind === 'user';
}

/** @param {any} data */
function isRealUserMessage(data) {
  const source = data && typeof data === 'object' ? data.source : undefined;
  const kind = source && typeof source === 'object' ? source.kind : undefined;
  if (typeof kind !== 'string' || kind === '') return true;
  return !INJECTED_USER_KINDS.has(kind);
}

/** @param {unknown} content @returns {string} */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** @param {unknown} content @returns {boolean} */
function hasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && typeof block === 'object' && block.type === 'image');
}

/** @param {any} data @returns {string} */
function assistantText(data) {
  const parts = [];
  for (const block of assistantContent(data)) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** @param {any} data @returns {any[]} */
function assistantContent(data) {
  if (!data || typeof data !== 'object') return [];
  if (data.message && Array.isArray(data.message.content)) return data.message.content;
  if (Array.isArray(data.content)) return data.content;
  return [];
}

/** @param {any} data @returns {string|undefined} */
function assistantModel(data) {
  const source = data?.message?.source;
  if (source && typeof source === 'object' && typeof source.model === 'string') return source.model;
  return undefined;
}

/** @param {unknown} content @returns {string} */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && typeof inner === 'object' && inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
      }
    }
  }
  return parts.join('\n');
}

/** @param {unknown} value @param {number} max @returns {string} */
function truncate(value, max) {
  const body = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(1, max - 1))}…`;
}
