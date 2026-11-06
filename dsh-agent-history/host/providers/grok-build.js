/**
 * Grok Build (xAI Grok CLI) history provider.
 *
 * `GROK_HOME` (default `~/.grok`) keeps one directory per session at
 *   `<grok-home>/sessions/<percent-encoded-cwd>/<session-id>/`
 * where the folder name is `encodeURIComponent(absolute project path)`. A session directory
 * holds:
 *
 *   summary.json       { info: { id, cwd }, generated_title, created_at, updated_at,
 *                        last_active_at, num_messages, num_chat_messages, current_model_id, … }
 *   chat_history.jsonl The conversation, one JSON record per line:
 *                        { type: 'system', content }
 *                        { type: 'user', content: [{ type: 'text', text }], synthetic_reason? }
 *                        { type: 'assistant', content, model_id }
 *                        { type: 'reasoning', summary: [{ type: 'summary_text', text }],
 *                          encrypted_content }
 *                        { type: 'tool_result', tool_call_id, content }
 *                      The real prompt lives inside `<user_query>…</user_query>`; the
 *                      surrounding blocks are injected rules/system reminders.
 *   usage.json / updates.jsonl  token accounting (not used here).
 *
 * `chat_history.jsonl` carries no timestamps, so `summary.json`'s message-derived
 * `created_at` / `last_active_at` provide the session boundaries; transcript messages keep
 * `ts: 0` and render in file order.
 *
 * Resume: `grok --resume <session-id>` in the session's recorded cwd.
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'grok-build',
  name: 'Grok Build',
  color: '#4b5563',
  homepage: 'https://x.ai',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'grok', args: ['--resume', '{id}'] },
};

const MAX_FILES = 50000;
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
    return Number.isFinite(parsed) && parsed > 946684800000 ? parsed : 0;
  }
  return 0;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @returns {string[]}
 */
function grokHomes(ctx) {
  const { utils, env } = ctx;
  /** @type {string[]} */
  const homes = [];
  const configured = utils.expandPath(process.env.GROK_HOME || '');
  if (configured) homes.push(configured);
  if (typeof env.config?.grokHome === 'string' && env.config.grokHome.trim() !== '') {
    homes.push(utils.expandPath(env.config.grokHome));
  }
  homes.push(join(env.home, '.grok'));
  return [...new Set(homes.filter(Boolean))];
}

/**
 * Decode the percent-encoded project folder name into an absolute path. This is only a fallback:
 * `summary.json.info.cwd` is the authoritative recorded cwd.
 * @param {string} name
 * @returns {string}
 */
function decodeProjectDir(name) {
  try {
    const decoded = decodeURIComponent(name);
    return decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
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

/**
 * Paired context blocks that Grok Build injects as `user` chat messages but that are not user
 * prompts (rules, skills, MCP notices, T3/IDE instructions). They must not become the session
 * title/preview nor appear as a user turn.
 */
const INJECTED_TAGS = [
  'user_info',
  'system-reminder',
  'system_reminder',
  'rules',
  'user_rules',
  't3_code_instructions',
  'runtime_info',
  'pull_request_linking',
  'environment_context',
  'user_instructions',
  'available_skills',
  'agents_md',
  'ADDITIONAL_METADATA',
  'USER_SETTINGS_CHANGE',
];

/** @param {string} value @returns {string} */
function stripInjectedContext(value) {
  let out = value;
  for (const tag of INJECTED_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  out = out.replace(/<\/?user_query\b[^>]*>/gi, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the real user prompt from one `chat_history` user record, dropping injected context.
 * @param {any} record
 * @returns {string}
 */
function userPromptText(record) {
  const raw = contentText(record.content);
  if (raw.trim() === '') return '';
  const open = raw.indexOf('<user_query>');
  let candidate = '';
  if (open >= 0) {
    const start = open + '<user_query>'.length;
    const end = raw.indexOf('</user_query>', start);
    candidate = end >= 0 ? raw.slice(start, end) : raw.slice(start);
  } else if (!record.synthetic_reason) {
    candidate = raw;
  }
  if (candidate.trim() === '') return '';
  return stripInjectedContext(candidate);
}

/**
 * Parse one session directory (summary.json + chat_history.jsonl).
 * @param {{summaryPath: string, historyPath: string, projectDir: string, summaryStat: any, historyStat: any}} entry
 * @returns {Promise<any[]>}
 */
async function parseSessionDir(entry) {
  const { summaryPath, historyPath, projectDir, summaryStat, historyStat } = entry;
  let summary = null;
  if (summaryStat) {
    const raw = await readText(summaryPath);
    if (raw !== null) summary = safeJsonParse(raw);
  }
  const info = summary && typeof summary.info === 'object' && summary.info ? summary.info : {};

  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';

  if (historyStat) {
    await readJsonl(historyPath, (line) => {
      if (!line.includes('"type"')) return;
      const record = safeJsonParse(line);
      if (!record || typeof record !== 'object') return;
      if (record.type === 'user') {
        const body = userPromptText(record);
        if (body.trim() === '') return;
        userMessages += 1;
        messages += 1;
        if (firstPrompt === '') firstPrompt = body;
        lastPreview = body;
      } else if (record.type === 'assistant') {
        const body = contentText(record.content);
        if (body.trim() === '') return;
        messages += 1;
        lastPreview = body;
      }
    });
  }
  if (messages === 0) return [];

  const id =
    typeof info.id === 'string' && info.id !== '' ? info.id : entry.sessionId;
  if (!id) return [];

  const cwd =
    typeof info.cwd === 'string' && info.cwd !== '' ? info.cwd : decodeProjectDir(projectDir);
  const rawTitle =
    summary && typeof summary.generated_title === 'string' && summary.generated_title.trim() !== ''
      ? summary.generated_title.trim()
      : '';
  // A title generated from injected instructions may be truncated mid-tag; reject those.
  const title = /<[A-Za-z]/.test(stripInjectedContext(rawTitle)) ? '' : stripInjectedContext(rawTitle);
  const startedAt = toTs(summary?.created_at) || (historyStat ? Math.round(historyStat.mtimeMs) : 0);
  const updatedAt = toTs(summary?.last_active_at) || toTs(summary?.updated_at) || startedAt;
  const model = typeof summary?.current_model_id === 'string' ? summary.current_model_id : '';

  return [
    {
      nativeId: id,
      title: title || titleFromPrompt(firstPrompt, 90) || '未命名会话',
      projectPath: cwd,
      startedAt,
      updatedAt,
      messages,
      userMessages,
      sizeBytes: (summaryStat?.size || 0) + (historyStat?.size || 0),
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: historyPath,
      extra: model || undefined,
      ref: { file: historyPath },
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

  for (const home of grokHomes(ctx)) {
    const sessionsDir = join(home, 'sessions');
    const probe = await utils.statSafe(sessionsDir);
    if (probe === null || !probe.isDirectory) continue;
    foundRoot = true;

    const files = await utils.listFilesRecursive(sessionsDir, {
      exts: ['.json', '.jsonl'],
      maxFiles: MAX_FILES,
      maxDepth: 6,
      signal: ctx.signal,
    });
    /** @type {Map<string, {summaryPath: string, historyPath: string, projectDir: string, sessionId: string, summaryStat: any, historyStat: any}>} */
    const byDir = new Map();
    for (const file of files) {
      const base = utils.basenameOf(file.path);
      if (base !== 'summary.json' && base !== 'chat_history.jsonl') continue;
      const dir = file.path.slice(0, file.path.length - base.length - 1);
      const entry = byDir.get(dir) || {
        summaryPath: join(dir, 'summary.json'),
        historyPath: join(dir, 'chat_history.jsonl'),
        projectDir: utils.basenameOf(utils.dirnameOf(dir)),
        sessionId: utils.basenameOf(dir),
        summaryStat: null,
        historyStat: null,
      };
      if (base === 'summary.json') entry.summaryStat = file;
      else entry.historyStat = file;
      byDir.set(dir, entry);
    }

    let bytes = 0;
    let parsedFiles = 0;
    for (const dir of [...byDir.keys()].sort()) {
      if (ctx.signal?.aborted) break;
      const entry = byDir.get(dir);
      if (!entry.summaryStat && !entry.historyStat) continue;
      const fingerprint =
        (entry.summaryStat ? `${entry.summaryStat.size}:${Math.round(entry.summaryStat.mtimeMs)}` : '-') +
        '|' +
        (entry.historyStat ? `${entry.historyStat.size}:${Math.round(entry.historyStat.mtimeMs)}` : '-');
      const cacheKey = entry.historyPath || entry.summaryPath;
      let rows = cache.get(cacheKey, fingerprint);
      if (!rows) {
        try {
          rows = await parseSessionDir(entry);
        } catch (error) {
          ctx.warn(`Grok Build: cannot read ${dir}: ${error?.message || error}`);
          continue;
        }
        cache.set(cacheKey, fingerprint, rows);
      }
      parsedFiles += 1;
      bytes += (entry.summaryStat?.size || 0) + (entry.historyStat?.size || 0);
      if (rows.length > 0) sessions.push(...rows);
    }

    sources.push({
      label: 'Grok Build sessions',
      path: sessionsDir,
      exists: true,
      files: parsedFiles,
      bytes,
      note: 'one directory per session (summary.json + chat_history.jsonl); prompt from <user_query>',
    });
  }

  if (!foundRoot) {
    sources.push({
      label: 'Grok Build sessions',
      path: join(grokHomes(ctx)[0] || '', 'sessions'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Grok Build is not installed for this user (or GROK_HOME points elsewhere)',
    });
  }

  return { sources, sessions };
}

/**
 * Read one Grok Build transcript.
 * @param {import('../types.js').ScanContext} ctx
 * @param {import('../types.js').SessionSummary} session
 */
export async function readMessages(ctx, session) {
  const historyPath = session.ref?.file || session.sourcePath;
  if (typeof historyPath !== 'string' || historyPath === '') return { messages: [] };
  /** @type {any[]} */
  const messages = [];

  await readJsonl(
    historyPath,
    (line) => {
      if (messages.length >= MAX_MESSAGES) return;
      if (!line.includes('"type"')) return;
      const record = safeJsonParse(line);
      if (!record || typeof record !== 'object') return;
      switch (record.type) {
        case 'user': {
          const body = userPromptText(record);
          if (body.trim() === '') return;
          messages.push({ role: 'user', ts: 0, text: body });
          return;
        }
        case 'assistant': {
          const body = contentText(record.content);
          if (body.trim() === '') return;
          messages.push({
            role: 'assistant',
            ts: 0,
            text: body,
            name: typeof record.model_id === 'string' ? record.model_id : undefined,
          });
          return;
        }
        case 'reasoning': {
          for (const block of Array.isArray(record.summary) ? record.summary : []) {
            if (block && typeof block === 'object' && block.type === 'summary_text' && typeof block.text === 'string' && block.text.trim() !== '') {
              messages.push({ role: 'assistant', ts: 0, kind: 'thinking', text: clip(block.text, 4000) });
            }
          }
          return;
        }
        case 'tool_result': {
          const body = contentText(record.content);
          if (body.trim() === '') return;
          messages.push({ role: 'tool', ts: 0, kind: 'tool-result', text: clip(body, 700) });
          return;
        }
        default:
          return;
      }
    },
    { signal: ctx.signal },
  );

  return { messages };
}
