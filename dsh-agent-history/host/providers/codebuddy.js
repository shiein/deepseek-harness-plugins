/**
 * CodeBuddy (Tencent) history provider.
 *
 * The CodeBuddy CLI is a Claude-Code-shaped agent with its own transcript layout:
 *   <CODEBUDDY_CONFIG_DIR|~/.codebuddy>/projects/<mangled-cwd>/<sessionId>.jsonl
 * plus sub-agent transcripts under `<sessionId>/subagents/agent-*.jsonl` (we only read the
 * top-level session files; sub-agents belong to their parent conversation).
 *
 * Records are OpenAI Responses-style items, one JSON object per line:
 *   { type: 'message', role: 'user'|'assistant', content: [{ type: 'input_text'|'output_text', text }],
 *     timestamp: <epoch ms>, cwd, providerData }
 *   { type: 'function_call', callId, name, arguments }
 *   { type: 'function_call_result', callId, name, output: { type: 'text', text } }
 *   { type: 'reasoning' | 'summary' | 'ai-title' | 'custom-title' | 'topic' | ... }
 * The newest of custom-title / ai-title / topic is the session title; `cwd` on the records is
 * the project folder. Records that never reached the model (hook output, compaction, teammate
 * plumbing) are marked with providerData.skipRun / isMeta / isCompactInternal / ... and dropped.
 *
 * Resume: `codebuddy -c -r <sessionId>` must run in the session's own project folder, which the
 * framework's launcher already uses as the terminal cwd.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  color: '#06b6d4',
  homepage: 'https://www.codebuddy.cn',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'codebuddy', args: ['-c', '-r', '{id}'] },
};

const MAX_TRANSCRIPT_MESSAGES = 4000;
const MAX_TEXT = 8000;

/**
 * Cache access that tolerates both the documented 2-arg CacheFace and the 3-arg HistoryCache
 * the scanner currently passes. Never throws: caching is an optimization only.
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
 * @param {import('../types.js').EnvFace} env
 * @returns {string}
 */
function codebuddyHome(env) {
  const config = env.config && typeof env.config === 'object' ? env.config : {};
  const configured = config.codebuddyHome || config.codebuddyDir;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim().replace(/^~(?=$|[\\/])/, env.home);
  }
  const fromEnv = process.env.CODEBUDDY_CONFIG_DIR || '';
  if (fromEnv.trim() !== '') return fromEnv.trim();
  return join(env.home, '.codebuddy');
}

/**
 * @param {unknown} value
 * @returns {number} epoch ms, 0 when unparseable
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) return toEpochMs(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/** @param {any} value @returns {boolean} */
function truthy(value) {
  return value === true || value === 1 || (typeof value === 'string' && value !== '' && value !== 'false');
}

/**
 * Records CodeBuddy writes for its own plumbing; they are not part of the conversation.
 * @param {Record<string, any>} record
 * @returns {boolean}
 */
function isPlumbingRecord(record) {
  if (!record || typeof record !== 'object') return true;
  const providerData = record.providerData && typeof record.providerData === 'object' ? record.providerData : null;
  if (providerData && truthy(providerData.skipRun)) return true;
  if (providerData && providerData.agent === 'compact') return true;
  for (const key of ['isMeta', 'isCompactInternal', 'isCompacted', 'isSummary', 'teammateMessage', 'compactType']) {
    if (truthy(record[key])) return true;
  }
  return false;
}

const INJECTED_PREFIXES = [
  '<command-name>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<teammate-message>',
  '<task-notification>',
];

/** @param {string} text @returns {boolean} */
function isInjectedUserText(text) {
  const trimmed = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Text blocks of a message record.
 * @param {Record<string, any>} record
 * @returns {string}
 */
function recordText(record) {
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const content = record.content !== undefined ? record.content : message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const type = typeof block.type === 'string' ? block.type : '';
    const text = typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : '';
    if (text === '') continue;
    // CodeBuddy uses input_text/output_text; tolerate plain text and legacy shapes too.
    if (type === '' || type === 'text' || type === 'input_text' || type === 'output_text' || type.endsWith('_text')) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * @param {Record<string, any>} record
 * @returns {'user'|'assistant'|''}
 */
function recordRole(record) {
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const role = record.role || message?.role;
  if (role === 'user' || role === 'assistant') return role;
  return '';
}

/**
 * One title candidate from a title-carrying record.
 * @param {Record<string, any>} record
 * @returns {{priority: number, text: string}|null}
 */
function titleCandidate(record) {
  const type = typeof record.type === 'string' ? record.type : '';
  /** @type {[number, string[], unknown][]} */
  const table = [
    [3, ['customTitle', 'custom_title'], record],
    [2, ['aiTitle', 'ai_title'], record],
    [1, ['topic'], record],
  ];
  for (const [priority, keys] of table) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '' && value.trim() !== '-') {
        return { priority, text: value.trim() };
      }
    }
  }
  if (type === 'ai-title' || type === 'custom-title' || type === 'topic') {
    for (const key of ['title', 'text', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return { priority: type === 'ai-title' ? 2 : type === 'custom-title' ? 3 : 1, text: value.trim() };
    }
  }
  return null;
}

/**
 * Parse one transcript file into one session row.
 * @param {string} filePath
 * @returns {Promise<any[]>}
 */
async function parseTranscript(filePath) {
  const stem = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  let sessionId = stem.replace(/\.jsonl$/i, '');
  let cwd = '';
  let startedAt = 0;
  let updatedAt = 0;
  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  /** @type {{priority: number, ts: number, text: string}|null} */
  let bestTitle = null;

  await readJsonl(filePath, (line) => {
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record || typeof record !== 'object') return;
    const type = typeof record.type === 'string' ? record.type : '';
    if (typeof record.sessionId === 'string' && record.sessionId !== '') sessionId = record.sessionId;
    const recordCwd = typeof record.cwd === 'string' ? record.cwd : typeof record.workingDirectory === 'string' ? record.workingDirectory : '';
    if (cwd === '' && recordCwd !== '') cwd = recordCwd;
    const ts = toEpochMs(record.timestamp) || toEpochMs(record.createdAt) || toEpochMs(record.ts);
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    if (type === 'ai-title' || type === 'custom-title' || type === 'topic') {
      const candidate = titleCandidate(record);
      if (candidate) {
        if (bestTitle === null || candidate.priority > bestTitle.priority || (candidate.priority === bestTitle.priority && ts >= bestTitle.ts)) {
          bestTitle = { priority: candidate.priority, ts, text: candidate.text };
        }
      }
      return;
    }
    if (type !== 'message') return;
    if (isPlumbingRecord(record)) return;
    const role = recordRole(record);
    if (role === '') return;
    const text = recordText(record);
    if (text.trim() === '') return;
    if (role === 'user') {
      if (isInjectedUserText(text)) return;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = text;
      lastPreview = text;
    } else {
      messages += 1;
      lastPreview = text;
    }
  });

  if (messages === 0) return [];
  const title = bestTitle !== null ? bestTitle.text : '';
  return [
    {
      nativeId: sessionId,
      title: title !== '' ? title : titleFromPrompt(firstPrompt, 90) || '未命名会话',
      projectPath: cwd,
      startedAt,
      updatedAt: updatedAt || startedAt,
      messages,
      userMessages,
      sizeBytes: 0,
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
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  /** @type {any[]} */
  const sessions = [];

  const home = codebuddyHome(env);
  const projectsDir = join(home, 'projects');
  const homeStat = await utils.statSafe(home);
  const projectsStat = await utils.statSafe(projectsDir);

  if (projectsStat && projectsStat.isDirectory) {
    const files = (
      await utils.listFilesRecursive(projectsDir, { exts: ['.jsonl'], signal: ctx.signal })
    ).filter((file) => !/[\\/]subagents[\\/]/i.test(file.path));
    let bytes = 0;
    let parsedFiles = 0;
    for (const file of files) {
      if (ctx.signal?.aborted) break;
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let rows = cacheGet(ctx, file.path, fingerprint);
      if (!rows) {
        try {
          rows = await parseTranscript(file.path);
          // The session size is the transcript size; patch it in after parsing.
          for (const row of rows) row.sizeBytes = file.size;
        } catch (error) {
          ctx.warn(`CodeBuddy: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        cacheSet(ctx, file.path, fingerprint, rows);
      }
      parsedFiles += 1;
      sessions.push(...rows);
    }
    sources.push({
      label: 'CodeBuddy transcripts',
      path: projectsDir,
      exists: true,
      files: parsedFiles,
      bytes,
      note: 'projects/<cwd>/<sessionId>.jsonl; one JSONL transcript per session',
    });
    if (files.length > 0 && sessions.length === 0) {
      ctx.warn('CodeBuddy: transcripts found but none contains a readable user/assistant message');
    }
  } else {
    sources.push({
      label: 'CodeBuddy transcripts',
      path: projectsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: homeStat && homeStat.isDirectory ? 'CodeBuddy home found but no projects/ transcripts' : 'CodeBuddy is not installed on this machine',
    });
  }

  // The VS Code-derived CodeBuddy IDE keeps a separate history store; report it honestly so the
  // panel shows the installation instead of "not installed".
  const ideRoots = [];
  if (env.platform === 'win32') {
    ideRoots.push(join(env.appData || '', 'CodeBuddy'), join(env.appData || '', 'CodeBuddy CN'), join(env.appData || '', 'CodeBuddyExtension'));
  } else if (env.platform === 'darwin') {
    ideRoots.push(
      join(env.home, 'Library', 'Application Support', 'CodeBuddy'),
      join(env.home, 'Library', 'Application Support', 'CodeBuddy CN'),
      join(env.home, 'Library', 'Application Support', 'CodeBuddyExtension'),
    );
  } else {
    ideRoots.push(join(env.home, '.config', 'CodeBuddy'), join(env.home, '.config', 'CodeBuddy CN'), join(env.home, '.config', 'CodeBuddyExtension'));
  }
  let ideFound = false;
  for (const root of ideRoots) {
    if (!root) continue;
    const stat = await utils.statSafe(root);
    if (stat === null || !stat.isDirectory) continue;
    ideFound = true;
    sources.push({
      label: 'CodeBuddy IDE storage',
      path: root,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'VS Code-derived IDE state; its agent history is kept in a separate store, not in ~/.codebuddy/projects',
    });
  }
  if (!(projectsStat && projectsStat.isDirectory) && ideFound) {
    ctx.warn('CodeBuddy: IDE installation found but no ~/.codebuddy/projects CLI transcripts are readable');
  }

  return { sources, sessions };
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function functionResultText(record) {
  const output = record.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const block of output) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (output.content !== undefined && output.content !== null) {
      try {
        return JSON.stringify(output.content);
      } catch {
        return '';
      }
    }
    try {
      return JSON.stringify(output);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Read one CodeBuddy transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const filePath = session?.ref?.file || session?.sourcePath;
  if (typeof filePath !== 'string' || filePath === '') return { messages: [] };
  /** @type {any[]} */
  const messages = [];
  try {
    await readJsonl(
      filePath,
      (line) => {
        if (messages.length >= MAX_TRANSCRIPT_MESSAGES) return;
        if (!line.includes('"type"')) return;
        const record = safeJsonParse(line);
        if (!record || typeof record !== 'object') return;
        const type = typeof record.type === 'string' ? record.type : '';
        const ts = toEpochMs(record.timestamp) || toEpochMs(record.createdAt) || toEpochMs(record.ts);
        if (type === 'message') {
          if (isPlumbingRecord(record)) return;
          const role = recordRole(record);
          if (role !== 'user' && role !== 'assistant') return;
          const text = recordText(record);
          if (text.trim() === '' || (role === 'user' && isInjectedUserText(text))) return;
          const model = record.model || record.providerData?.model || record.providerData?.requestModelId;
          messages.push({
            role,
            ts,
            text: text.slice(0, MAX_TEXT),
            name: role === 'assistant' && typeof model === 'string' ? model : undefined,
          });
          return;
        }
        if (type === 'function_call') {
          const name = typeof record.name === 'string' ? record.name : 'tool';
          const args = record.arguments ?? record.input ?? {};
          messages.push({ role: 'tool', ts, kind: 'tool-call', name, text: clip(typeof args === 'string' ? args : JSON.stringify(args), 600) });
          return;
        }
        if (type === 'function_call_result') {
          const body = functionResultText(record);
          if (body.trim() === '') return;
          messages.push({
            role: 'tool',
            ts,
            kind: 'tool-result',
            name: typeof record.name === 'string' ? record.name : undefined,
            text: body.slice(0, MAX_TEXT),
          });
        }
      },
      { signal: ctx.signal },
    );
  } catch {
    return { messages: [] };
  }
  return { messages };
}
