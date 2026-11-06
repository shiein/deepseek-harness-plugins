/**
 * Pi coding agent history provider.
 *
 * Pi (`@earendil-works/pi-coding-agent`, binary `pi`) writes one append-only JSONL
 * transcript per session under
 *   `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`
 * where the agent directory is `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and the session
 * directory itself can be relocated with `PI_CODING_AGENT_SESSION_DIR` (`--session-dir`).
 *
 * Session files are JSONL with `type`-tagged entries:
 *   { type: 'session', id, timestamp, cwd }                       // header, first line
 *   { type: 'session_info', name }                                // generated/renamed title
 *   { type: 'message', timestamp, message: { role, content } }    // role: user | assistant |
 *                                                                 //        toolResult | system
 * Content is normally an array of blocks: { type: 'text' | 'thinking' | 'toolCall' }.
 * The per-message `message.timestamp` is epoch ms; the envelope `timestamp` is ISO 8601.
 *
 * Resume: `pi --session <session-uuid>` in the session's recorded cwd.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'pi',
  name: 'Pi',
  color: '#8b5cf6',
  homepage: 'https://github.com/earendil-works/pi',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'pi', args: ['--session', '{id}'] },
};

const MAX_SESSIONS = 5000;
const MAX_MESSAGES = 4000;

/** @param {unknown} value @returns {number} */
function toTs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    if (value > 1e12) return Math.round(value);
    if (value > 1e9) return Math.round(value * 1000);
    return 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    // Reject obviously bogus epochs (parsers accept '0001-01-01' as a positive number).
    return Number.isFinite(parsed) && parsed > 946684800000 ? parsed : 0;
  }
  return 0;
}

/**
 * Session storage roots, most specific first. Both a configured location and the default are
 * scanned so history written before a relocation is not lost; duplicates are removed.
 * @param {import('../types.js').ScanContext} ctx
 * @returns {string[]}
 */
function sessionRoots(ctx) {
  const { utils, env } = ctx;
  const overrideSessions = utils.expandPath(process.env.PI_CODING_AGENT_SESSION_DIR || '');
  const overrideAgent = utils.expandPath(process.env.PI_CODING_AGENT_DIR || '');
  /** @type {string[]} */
  const roots = [];
  if (overrideSessions) roots.push(overrideSessions);
  if (overrideAgent) roots.push(join(overrideAgent, 'sessions'));
  roots.push(join(env.home, '.pi', 'agent', 'sessions'));
  return [...new Set(roots.filter(Boolean))];
}

/** @param {string} filePath @returns {string} */
function nativeIdFromPath(filePath) {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const stem = base.replace(/\.jsonl$/i, '');
  const underscore = stem.lastIndexOf('_');
  return underscore >= 0 ? stem.slice(underscore + 1) : stem;
}

/** @param {unknown} content @returns {string} */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** @param {unknown} content @returns {string} */
function assistantText(content) {
  return contentText(content);
}

/**
 * Parse one Pi transcript into a single session summary. The whole file is streamed once; the
 * result is cached by the caller, so this cost is paid only when the file changes.
 * @param {string} filePath
 * @param {number} sizeBytes
 * @returns {Promise<any[]>}
 */
async function parseTranscript(filePath, sizeBytes) {
  let sessionId = '';
  let cwd = '';
  let headerTs = 0;
  let title = '';
  let startedAt = 0;
  let updatedAt = 0;
  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';

  await readJsonl(filePath, (line) => {
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record || typeof record !== 'object') return;
    const type = record.type;

    if (type === 'session') {
      if (typeof record.id === 'string' && record.id !== '') sessionId = record.id;
      if (cwd === '' && typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd;
      const ts = toTs(record.timestamp);
      if (ts > 0) headerTs = ts;
      return;
    }
    if (type === 'session_info') {
      // Pi rewrites the generated title as the conversation evolves; the last one wins.
      if (typeof record.name === 'string' && record.name.trim() !== '') title = record.name.trim();
      return;
    }
    if (type !== 'message') return;
    const message = record.message;
    if (!message || typeof message !== 'object') return;
    const role = message.role;
    const ts = toTs(message.timestamp) || toTs(record.timestamp);
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    if (role === 'user') {
      const body = contentText(message.content);
      if (body.trim() === '') return;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = body;
      lastPreview = body;
      return;
    }
    if (role === 'assistant') {
      const body = assistantText(message.content);
      if (body.trim() === '') return;
      messages += 1;
      lastPreview = body;
      return;
    }
    if (role === 'toolResult') {
      const body = contentText(message.content);
      if (body.trim() !== '') lastPreview = body;
    }
  });

  if (messages === 0) return [];
  const id = sessionId !== '' ? sessionId : nativeIdFromPath(filePath);
  if (id === '') return [];
  const resolvedTitle = title !== '' ? title : titleFromPrompt(firstPrompt, 90);
  return [
    {
      nativeId: id,
      title: resolvedTitle || '未命名会话',
      projectPath: cwd,
      startedAt: startedAt || headerTs,
      updatedAt: updatedAt || headerTs || startedAt,
      messages,
      userMessages,
      sizeBytes,
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: filePath,
      ref: { file: filePath },
    },
  ];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];
  let foundRoot = false;

  for (const root of sessionRoots(ctx)) {
    const probe = await utils.statSafe(root);
    if (probe === null || !probe.isDirectory) continue;
    foundRoot = true;
    const files = await utils.listFilesRecursive(root, {
      exts: ['.jsonl'],
      maxFiles: MAX_SESSIONS,
      signal: ctx.signal,
    });
    let bytes = 0;
    let parsedFiles = 0;
    for (const file of files) {
      if (ctx.signal?.aborted) break;
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let rows = cache.get(file.path, fingerprint);
      if (!rows) {
        try {
          rows = await parseTranscript(file.path, file.size);
        } catch (error) {
          ctx.warn(`Pi: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        cache.set(file.path, fingerprint, rows);
      }
      parsedFiles += 1;
      if (rows.length > 0) sessions.push(...rows);
    }
    sources.push({
      label: 'Pi sessions',
      path: root,
      exists: true,
      files: parsedFiles,
      bytes,
      note: 'one JSONL transcript per session; title from the session_info record',
    });
  }

  if (!foundRoot) {
    sources.push({
      label: 'Pi sessions',
      path: sessionRoots(ctx)[0] || '',
      exists: false,
      files: 0,
      bytes: 0,
      note: 'pi is not installed for this user (or PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR point elsewhere)',
    });
  }

  return { sources, sessions };
}

/**
 * Read the full transcript of one Pi session.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 */
export async function readMessages(ctx, session) {
  const filePath = session.ref?.file || session.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  /** @type {any[]} */
  const messages = [];

  await readJsonl(
    filePath,
    (line) => {
      if (messages.length >= MAX_MESSAGES) return;
      if (!line.includes('"type"')) return;
      const record = safeJsonParse(line);
      if (!record || record.type !== 'message') return;
      const message = record.message;
      if (!message || typeof message !== 'object') return;
      const role = message.role;
      const ts = toTs(message.timestamp) || toTs(record.timestamp);

      if (role === 'user') {
        const body = contentText(message.content);
        if (body.trim() === '') return;
        messages.push({ role: 'user', ts, text: body });
        return;
      }
      if (role === 'toolResult') {
        const body = contentText(message.content);
        if (body.trim() === '') return;
        messages.push({
          role: 'tool',
          ts,
          kind: 'tool-result',
          name: typeof message.toolName === 'string' ? message.toolName : undefined,
          text: clip(body, 700),
        });
        return;
      }
      if (role !== 'assistant') return;
      const model = typeof message.model === 'string' ? message.model : undefined;
      if (typeof message.content === 'string') {
        if (message.content.trim() !== '') messages.push({ role: 'assistant', ts, text: message.content, name: model });
        return;
      }
      if (!Array.isArray(message.content)) return;
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          messages.push({ role: 'assistant', ts, text: block.text, name: model });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
          messages.push({ role: 'assistant', ts, text: clip(block.thinking, 8000), kind: 'thinking' });
        } else if (block.type === 'toolCall') {
          const args = block.arguments ?? block.input ?? {};
          messages.push({
            role: 'tool',
            ts,
            kind: 'tool-call',
            name: typeof block.name === 'string' ? block.name : 'tool',
            text: clip(JSON.stringify(args), 600),
          });
        }
      }
    },
    { signal: ctx.signal },
  );

  return { messages };
}
