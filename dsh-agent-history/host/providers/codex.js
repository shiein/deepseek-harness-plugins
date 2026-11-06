/**
 * OpenAI Codex history provider.
 *
 * Codex writes one append-only JSONL rollout per session under
 * `<CODEX_HOME|~/.codex>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. Older rollouts are compacted
 * to `.jsonl.zst` (zstd-compressed JSONL) and moved to `archived_sessions/` when archived; both
 * forms are readable here.
 *
 * Every line is `{timestamp, ordinal, type, payload}`. The first line is `session_meta` with the
 * session `id`, `cwd` and start timestamp; the conversation itself lives in
 * `response_item` records (`payload.type === 'message'`, roles user/assistant) and tool traffic in
 * `function_call` / `custom_tool_call` / `*_output` records. Codex also mirrors messages into
 * `event_msg` records — those are ignored so a transcript never shows the same text twice.
 *
 * Resume: `codex resume <session-id>` in the session's recorded cwd.
 */

import { createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { cleanPrompt, titleFromPrompt } from '../model.js';
import { safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'codex',
  name: 'Codex',
  color: '#10a37f',
  homepage: 'https://openai.com/codex',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'codex', args: ['resume', '{id}'] },
};

const MAX_FILES = 20000;
const MAX_MESSAGES = 4000;
const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 900;
const ROLLOUT_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * @param {import('../types.js').ScanContext} ctx
 * @returns {Promise<{sources: import('../types.js').SourceInfo[], sessions: any[]}>}
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  const sources = [];
  const sessions = [];
  const root = codexHome(env);
  const directories = [utils.join(root, 'sessions'), utils.join(root, 'archived_sessions')];

  for (const directory of directories) {
    const probe = await utils.statSafe(directory);
    if (probe === null || !probe.isDirectory) {
      sources.push({ label: 'Codex rollouts', path: directory, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const files = await utils.listFilesRecursive(directory, {
      exts: ['.jsonl', '.zst', '.zstd'],
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
          rows = await parseRollout(file.path, file.size, ctx.signal);
        } catch (error) {
          ctx.warn(`Codex: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        cacheSet(ctx, file.path, fingerprint, rows);
      }
      filesRead += 1;
      sessions.push(...rows);
    }
    sources.push({
      label: directory.endsWith('archived_sessions') ? 'Codex archived rollouts' : 'Codex rollouts',
      path: directory,
      exists: true,
      files: filesRead,
      bytes,
      note: 'one JSONL (or zstd-compressed JSONL) rollout per session; title from the first real prompt',
    });
  }

  return { sources, sessions };
}

/** @param {{home: string}} env @returns {string} */
function codexHome(env) {
  const override = process.env.CODEX_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(env.home, '.codex');
}

/**
 * Metadata-only parse of one rollout. Returns zero or one session summary.
 * @param {string} filePath
 * @param {number} sizeBytes
 * @param {AbortSignal} [signal]
 * @returns {Promise<any[]>}
 */
async function parseRollout(filePath, sizeBytes, signal) {
  let nativeId = '';
  let projectPath = '';
  let headerTs = 0;
  let firstTsString = '';
  let lastTsString = '';
  let model = '';
  let userMessages = 0;
  let messages = 0;
  let firstPrompt = '';
  let lastPreview = '';

  await eachLine(filePath, signal, (line) => {
    if (line.trim() === '') return;
    const tsMatch = line.match(/^\{"timestamp":"([^"]+)"/);
    if (tsMatch) {
      if (firstTsString === '') firstTsString = tsMatch[1];
      lastTsString = tsMatch[1];
    }

    if (line.includes('"type":"session_meta"')) {
      const record = safeJsonParse(line);
      const payload = record && record.payload;
      if (payload && typeof payload === 'object') {
        if (typeof payload.id === 'string' && payload.id !== '') nativeId = payload.id;
        else if (typeof payload.session_id === 'string' && payload.session_id !== '') nativeId = payload.session_id;
        if (typeof payload.cwd === 'string' && payload.cwd.trim() !== '') projectPath = payload.cwd.trim();
        const parsed = Date.parse(typeof payload.timestamp === 'string' ? payload.timestamp : '');
        if (Number.isFinite(parsed) && parsed > 0) headerTs = parsed;
      }
      return;
    }

    if (line.includes('"type":"thread_settings_applied"')) {
      const record = safeJsonParse(line);
      const settings = record?.payload?.thread_settings;
      if (settings && typeof settings.model === 'string' && settings.model !== '') model = settings.model;
      return;
    }

    // Only user/assistant response messages matter for the summary. Cheap pre-checks avoid a
    // JSON.parse for the overwhelming majority of lines (tool calls, token counters, ...).
    if (!line.includes('"type":"response_item"') || !line.includes('"type":"message"')) return;
    if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) return;
    const record = safeJsonParse(line);
    const payload = record && record.payload;
    if (!payload || payload.type !== 'message') return;
    const body = contentText(payload.content);
    if (body.trim() === '') return;
    if (payload.role === 'user') {
      if (isBootstrapUserText(body)) return;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = body;
      lastPreview = body;
    } else if (payload.role === 'assistant') {
      messages += 1;
      lastPreview = body;
    }
  });

  if (messages === 0) return [];
  const firstTs = Date.parse(firstTsString || '') || 0;
  const lastTs = Date.parse(lastTsString || '') || 0;
  const startedAt = headerTs || firstTs;
  const updatedAt = lastTs || startedAt;
  if (nativeId === '') {
    const match = ROLLOUT_UUID.exec(basename(filePath));
    nativeId = match ? match[1] : basename(filePath).replace(/\.jsonl(\.zst|\.zstd)?$/i, '');
  }

  return [
    {
      nativeId,
      title: titleFromPrompt(firstPrompt, 90) || '未命名会话',
      projectPath,
      startedAt,
      updatedAt,
      messages,
      userMessages,
      sizeBytes,
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: filePath,
      extra: model || undefined,
      ref: { file: filePath },
    },
  ];
}

/**
 * Read one rollout transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  /** @type {any[]} */
  const messages = [];
  try {
    await eachLine(filePath, ctx.signal, (line) => {
      if (messages.length >= MAX_MESSAGES) return;
      if (line.trim() === '' || !line.includes('"type":"response_item"')) return;
      const record = safeJsonParse(line);
      const payload = record && record.payload;
      if (!payload || typeof payload !== 'object') return;
      const ts = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '') || 0;
      switch (payload.type) {
        case 'message': {
          const body = contentText(payload.content);
          if (body.trim() === '') return;
          if (payload.role === 'user') {
            if (isBootstrapUserText(body)) return;
            messages.push({ role: 'user', ts, text: truncate(body, MAX_TEXT) });
          } else if (payload.role === 'assistant') {
            messages.push({ role: 'assistant', ts, text: truncate(body, MAX_TEXT) });
          }
          return;
        }
        case 'reasoning': {
          const body = reasoningText(payload);
          if (body.trim() !== '') messages.push({ role: 'assistant', ts, text: truncate(body, MAX_TEXT), kind: 'thinking' });
          return;
        }
        case 'function_call':
        case 'custom_tool_call': {
          const name = typeof payload.name === 'string' ? payload.name : 'tool';
          const args = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.arguments ?? payload.input ?? {});
          messages.push({ role: 'tool', ts, kind: 'tool-call', name, text: truncate(args, MAX_TOOL_TEXT) });
          return;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const body = contentText(payload.output);
          if (body.trim() === '') return;
          messages.push({ role: 'tool', ts, kind: 'tool-result', text: truncate(body, MAX_TOOL_TEXT * 2) });
          return;
        }
        case 'web_search_call': {
          messages.push({ role: 'tool', ts, kind: 'tool-call', name: 'web_search', text: truncate(JSON.stringify(payload.action ?? {}), MAX_TOOL_TEXT) });
          return;
        }
        default:
          return;
      }
    });
  } catch {
    // A truncated/corrupt rollout must render the messages decoded so far rather than fail.
  }
  return { messages };
}

/**
 * Stream JSONL lines out of a rollout, transparently decompressing `.zst`/`.zstd` rollouts.
 * @param {string} filePath
 * @param {AbortSignal|undefined} signal
 * @param {(line: string) => void} onLine
 */
async function eachLine(filePath, signal, onLine) {
  let stream = createReadStream(filePath);
  if (/\.(zst|zstd)$/i.test(filePath)) stream = stream.pipe(zlib.createZstdDecompress());
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let first = true;
    for await (const raw of reader) {
      if (signal?.aborted) break;
      let line = raw;
      if (first) {
        first = false;
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      }
      if (line === '' || line === '\r') continue;
      try {
        onLine(line);
      } catch {
        // One malformed record must not abort the whole rollout.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** @param {unknown} content @returns {string} */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** @param {any} payload @returns {string} */
function reasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload.summary)) {
    for (const entry of payload.summary) {
      if (entry && typeof entry.text === 'string' && entry.text.trim() !== '') parts.push(entry.text);
    }
  }
  if (typeof payload.text === 'string' && payload.text.trim() !== '') parts.push(payload.text);
  return parts.join('\n');
}

/**
 * Codex injects AGENTS.md + environment context as a synthetic first `user` message; it is not a
 * human prompt and must not become a preview/title or a transcript bubble.
 * @param {string} body
 */
function isBootstrapUserText(body) {
  const text = body.trimStart();
  if (/^#\s*AGENTS\.md instructions/i.test(text)) return true;
  // Codex also delivers runtime warnings as synthetic user turns.
  if (text.startsWith('Warning: ')) return true;
  const tag = /^<([a-z][a-z0-9_ -]{0,60})>/i.exec(text);
  return tag !== null && INJECTED_USER_TAGS.has(tag[1].trim().toLowerCase());
}

/**
 * Synthetic `user` envelope tags Codex Desktop injects as if a user message had been typed:
 * context hand-offs (AGENTS.md, environment, permissions) and app-control/IDE round trips.
 * They carry no human prompt and must not become a preview, title or transcript bubble.
 */
const INJECTED_USER_TAGS = new Set([
  'environment_context',
  'user_instructions',
  'permissions instructions',
  'external_codex_apps_open_page',
  'send_user_message_question_reply',
  'user_action',
  'ide_context',
  'codex_internal_context',
  'turn_aborted',
  'user_message',
  'skills_instructions',
  'subagent_notification',
  'recommended_plugins',
  'heartbeat',
  'skill',
]);

/**
 * Cache-face adapter (see CONTRACT.md): support both the documented two-argument cache and the
 * provider-scoped three-argument cache the current Host passes through.
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
    // Cache failures never fail a scan.
  }
}

/** @param {unknown} value @param {number} max @returns {string} */
function truncate(value, max) {
  const body = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(1, max - 1))}…`;
}
