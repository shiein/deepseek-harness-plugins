/**
 * Claude Code history provider.
 *
 * Claude Code writes one append-only JSONL transcript per session under
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<project-slug>/<session-uuid>.jsonl`. Every record
 * carries `cwd` and `sessionId`, assistant/user records carry the message content, and the
 * session's generated title arrives as an `ai-title` record later in the file.
 *
 * Resume: `claude --resume <session-uuid>` in the session's project folder.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'claude-code',
  name: 'Claude Code',
  color: '#d97757',
  homepage: 'https://www.anthropic.com/claude-code',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'claude', args: ['--resume', '{id}'] },
};

/** @param {string} envOverride @param {string} home */
function configRoots(envOverride, home) {
  const roots = [];
  if (envOverride) roots.push(envOverride);
  roots.push(join(home, '.claude'));
  return [...new Set(roots)];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];

  for (const root of configRoots(process.env.CLAUDE_CONFIG_DIR || '', env.home)) {
    const projects = join(root, 'projects');
    const probe = await utils.statSafe(projects);
    if (probe === null || !probe.isDirectory) {
      sources.push({ label: 'Claude Code transcripts', path: projects, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const files = await utils.listFilesRecursive(projects, { exts: ['.jsonl'], signal: ctx.signal });
    let bytes = 0;
    let parsedFiles = 0;
    for (const file of files) {
      if (ctx.signal?.aborted) break;
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileSessions = cache.get(file.path, fingerprint);
      if (!fileSessions) {
        try {
          fileSessions = await parseTranscript(file.path, file.size);
        } catch (error) {
          ctx.warn(`Claude Code: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        cache.set(file.path, fingerprint, fileSessions);
      }
      parsedFiles += 1;
      sessions.push(...fileSessions);
    }
    sources.push({
      label: 'Claude Code transcripts',
      path: projects,
      exists: true,
      files: parsedFiles,
      bytes,
      note: 'one JSONL transcript per session; title from the ai-title record',
    });
  }

  return { sources, sessions };
}

/**
 * Parse one transcript file into a single session summary.
 * @param {string} filePath
 * @param {number} sizeBytes
 * @returns {Promise<any[]>}
 */
async function parseTranscript(filePath, sizeBytes) {
  const stem = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.jsonl$/i, '');
  let sessionId = stem;
  let cwd = '';
  let title = '';
  let startedAt = 0;
  let updatedAt = 0;
  let userMessages = 0;
  let messages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  let lastTs = 0;

  await readJsonl(filePath, (line) => {
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record) return;
    const type = record.type;
    if (type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
      title = record.aiTitle.trim();
      return;
    }
    if (type !== 'user' && type !== 'assistant') return;
    if (typeof record.sessionId === 'string' && record.sessionId !== '') sessionId = record.sessionId;
    if (cwd === '' && typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd;
    const ts = Date.parse(record.timestamp || '') || 0;
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    if (record.isSidechain === true) return;
    if (record.isMeta === true) return;
    const message = record.message;
    if (!message || typeof message !== 'object') return;
    if (type === 'user') {
      const body = extractUserText(message.content);
      if (body === '') return;
      userMessages += 1;
      messages += 1;
      const readable = readableText(body);
      if (readable !== '') {
        if (firstPrompt === '') firstPrompt = readable;
        lastPreview = readable;
        lastTs = ts;
      }
    } else {
      const body = extractAssistantText(message.content);
      if (body === '') return;
      messages += 1;
      const readable = clip(cleanPrompt(body), 220);
      if (readable !== '') {
        lastPreview = readable;
        lastTs = ts;
      }
    }
  });

  if (messages === 0) return [];
  const resolvedTitle = title !== '' ? title : titleFromPrompt(firstPrompt, 90);
  return [
    {
      nativeId: sessionId,
      title: resolvedTitle || '未命名会话',
      projectPath: cwd,
      startedAt,
      updatedAt: updatedAt || lastTs,
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

/** @param {unknown} content @returns {string} */
function extractUserText(content) {
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
function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Read the full transcript of one session.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 */
export async function readMessages(ctx, session) {
  const filePath = session.ref?.file || session.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  /** @type {any[]} */
  const messages = [];
  await readJsonl(filePath, (line) => {
    if (messages.length >= 4000) return;
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) return;
    if (record.isSidechain === true || record.isMeta === true) return;
    const message = record.message;
    if (!message || typeof message !== 'object') return;
    const ts = Date.parse(record.timestamp || '') || 0;
    if (record.type === 'user') {
      const body = extractUserText(message.content);
      if (body === '' || isToolResultOnly(message.content)) return;
      if (isCommandWrapper(body)) return;
      messages.push({ role: 'user', ts, text: body });
      return;
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: block.text, name: typeof message.model === 'string' ? message.model : undefined });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        messages.push({ role: 'assistant', ts, text: block.thinking, kind: 'thinking' });
      } else if (block.type === 'tool_use') {
        messages.push({
          role: 'tool',
          ts,
          kind: 'tool-call',
          name: typeof block.name === 'string' ? block.name : 'tool',
          text: clip(JSON.stringify(block.input ?? {}), 600),
        });
      }
    }
    if (Array.isArray(message.content) && message.content.some((block) => block?.type === 'tool_result')) {
      for (const block of message.content) {
        if (block?.type !== 'tool_result') continue;
        const body = toolResultText(block.content);
        if (body !== '') messages.push({ role: 'tool', ts, kind: 'tool-result', text: clip(body, 700) });
      }
    }
    return;
  }, { signal: ctx.signal });
  return { messages };
}

/** Readable preview text, or '' for injected context / command wrappers. @param {string} body */
function readableText(body) {
  const cleaned = clip(cleanPrompt(body), 220);
  if (cleaned.length < 4) return '';
  if (/^(\/\w+|\[Request interrupted)/.test(cleaned)) return '';
  return cleaned;
}

/** Slash-command wrappers and their stdout are command plumbing, not conversation prompts. */
function isCommandWrapper(body) {
  const trimmed = body.trim();
  return trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command-');
}

/** @param {unknown} content */
function isToolResultOnly(content) {
  if (!Array.isArray(content)) return false;
  let hasText = false;
  let hasResult = false;
  for (const block of content) {
    if (block?.type === 'text') hasText = true;
    if (block?.type === 'tool_result') hasResult = true;
  }
  return hasResult && !hasText;
}

/** @param {unknown} content @returns {string} */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}
