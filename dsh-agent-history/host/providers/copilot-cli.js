/**
 * GitHub Copilot CLI history provider.
 *
 * Copilot CLI keeps one directory per session under
 *   `${COPILOT_HOME:-~/.copilot}/session-state/<sessionId>/`
 * on every platform (`%USERPROFILE%\.copilot` on Windows). A session directory holds:
 *   events.jsonl     append-only conversation event log, one `{type, data, timestamp}` per line
 *                    (`session.start`, `user.message`, `assistant.message`,
 *                     `tool.execution_start/_complete`, `session.shutdown`, ...)
 *   workspace.yaml   `id`, `cwd`, `repository`, `branch`, `summary`, timestamps
 *   checkpoints/     bookkeeping, no conversation text
 * Older builds also wrote flat `session-state/<sessionId>.jsonl` event logs.
 *
 * A directory with only workspace.yaml/checkpoints has no readable conversation and is not
 * reported as a session. `session-store.db` holds per-request token accounting, not transcripts.
 *
 * Resume: `copilot --resume=<sessionId>` (verified CLI syntax; the launcher runs it in the
 * session's recorded project folder).
 */

import { join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { readJsonl, readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'copilot-cli',
  name: 'GitHub Copilot CLI',
  color: '#6e40c9',
  homepage: 'https://github.com/github/copilot-cli',
  cacheVersion: 1,
  resume: { kind: 'cli', command: 'copilot', args: ['--resume={id}'] },
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

/** @param {import('../types.js').EnvFace} env @returns {string} */
function copilotHome(env) {
  const override = process.env.COPILOT_HOME || '';
  if (override.trim() !== '') return override.trim();
  return join(env.home, '.copilot');
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
    let parsed = Date.parse(text);
    if (Number.isNaN(parsed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
      parsed = Date.parse(`${text.replace(' ', 'T')}Z`);
    }
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Minimal `key: value` YAML reader for workspace.yaml (no nested documents are used there).
 * @param {string|null} raw
 * @returns {Record<string, string>}
 */
function parseWorkspaceYaml(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === 'null' || value === '~') value = '';
    out[match[1]] = value;
  }
  return out;
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
function eventText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.content === 'string') return data.content;
  if (typeof data.text === 'string') return data.text;
  if (data.message && typeof data.message === 'object') {
    if (typeof data.message.content === 'string') return data.message.content;
    if (typeof data.message.text === 'string') return data.message.text;
  }
  return '';
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function toolResultText(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts = [];
    for (const block of result) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  if (typeof result === 'object') {
    const record = /** @type {Record<string, any>} */ (result);
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (record.content && typeof record.content === 'object') {
      const content = /** @type {Record<string, any>} */ (record.content);
      if (typeof content.text === 'string') return content.text;
    }
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * @param {Record<string, any>} record
 * @returns {string}
 */
function toolCallText(record) {
  const data = record.data && typeof record.data === 'object' ? record.data : {};
  const args = data.arguments ?? data.args ?? {};
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/**
 * Parse one events log into a session row (plus its transcript walker shared with readMessages).
 * @param {string} eventsPath
 * @param {{workspace: Record<string, string>, statSize: number, fallbackId: string}} meta
 * @returns {Promise<any[]>}
 */
async function parseEvents(eventsPath, meta) {
  const workspace = meta.workspace;
  let sessionId = workspace.id || meta.fallbackId || '';
  let cwd = workspace.cwd || workspace.git_root || '';
  let startedAt = 0;
  let updatedAt = 0;
  let messages = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  let renameTitle = '';
  let model = '';

  await readJsonl(eventsPath, (line) => {
    if (!line.includes('"type"')) return;
    const record = safeJsonParse(line);
    if (!record || typeof record !== 'object') return;
    const type = typeof record.type === 'string' ? record.type : '';
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const ts = toEpochMs(record.timestamp) || toEpochMs(data.timestamp);
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    if (type === 'session.start') {
      if (typeof data.sessionId === 'string' && data.sessionId !== '') sessionId = data.sessionId;
      const context = data.context && typeof data.context === 'object' ? data.context : {};
      const startCwd = context.cwd || data.cwd;
      if (typeof startCwd === 'string' && startCwd !== '' && cwd === '') cwd = startCwd;
      return;
    }
    if (type === 'tool.execution_start') {
      if (data.toolName === 'rename_session') {
        const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
        if (typeof args.title === 'string' && args.title.trim() !== '') renameTitle = args.title.trim();
      }
      return;
    }
    if (type === 'assistant.message') {
      if (typeof data.model === 'string' && data.model !== '') model = data.model;
      const text = eventText(data);
      if (text.trim() === '') return;
      messages += 1;
      lastPreview = text;
      return;
    }
    if (type === 'user.message') {
      const text = eventText(data);
      if (text.trim() === '') return;
      userMessages += 1;
      messages += 1;
      if (firstPrompt === '') firstPrompt = text;
      lastPreview = text;
    }
  });

  if (messages === 0) return [];
  const createdAt = toEpochMs(workspace.created_at);
  const updated = toEpochMs(workspace.updated_at);
  const summary = workspace.summary || '';
  const title = summary !== '' ? summary : renameTitle !== '' ? renameTitle : titleFromPrompt(firstPrompt, 90);
  return [
    {
      nativeId: sessionId,
      title: title || '未命名会话',
      projectPath: cwd,
      startedAt: startedAt || createdAt,
      updatedAt: updatedAt || updated || startedAt || createdAt,
      messages,
      userMessages,
      sizeBytes: meta.statSize,
      preview: cleanPrompt(firstPrompt).slice(0, 220),
      lastPreview: cleanPrompt(lastPreview).slice(0, 220),
      sourcePath: eventsPath,
      extra: [workspace.repository, workspace.branch, model].filter(Boolean).join(' · ') || undefined,
      ref: { file: eventsPath, sessionId },
    },
  ];
}

/**
 * A session's native id is its directory name; a flat legacy event log is identified by its file
 * stem instead (there is no workspace.yaml next to it).
 * @param {string} sessionDir
 * @param {string} eventsPath
 * @returns {string}
 */
function deriveSessionId(sessionDir, eventsPath) {
  const dirName = sessionDir.replace(/\\/g, '/').split('/').pop() || '';
  if (dirName === '' || dirName === 'session-state') {
    return (eventsPath.replace(/\\/g, '/').split('/').pop() || '').replace(/\.jsonl$/i, '');
  }
  return dirName;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} eventsPath
 * @param {string} sessionDir
 * @param {number} statSize
 * @returns {Promise<any[]>}
 */
async function readSessionRow(ctx, eventsPath, sessionDir, statSize) {
  const { utils } = ctx;
  const workspacePath = join(sessionDir, 'workspace.yaml');
  const workspaceStat = await utils.statSafe(workspacePath);
  const workspaceFp = workspaceStat && workspaceStat.isFile ? `${workspaceStat.size}:${Math.round(workspaceStat.mtimeMs)}` : '-';
  const fingerprint = `${statSize}:${workspaceFp}`;
  const cached = cacheGet(ctx, eventsPath, fingerprint);
  if (cached) return cached;
  const workspaceRaw = workspaceStat && workspaceStat.isFile ? await readText(workspacePath) : null;
  const workspace = parseWorkspaceYaml(workspaceRaw);
  const rows = await parseEvents(eventsPath, { workspace, statSize, fallbackId: deriveSessionId(sessionDir, eventsPath) });
  cacheSet(ctx, eventsPath, fingerprint, rows);
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

  const root = copilotHome(env);
  const sessionStateDir = join(root, 'session-state');
  const storePath = join(root, 'session-store.db');
  const rootStat = await utils.statSafe(root);
  const stateStat = await utils.statSafe(sessionStateDir);

  if (stateStat && stateStat.isDirectory) {
    let eventsFiles = 0;
    let bytes = 0;
    const entries = await utils.readdirSafe(sessionStateDir);
    for (const entry of entries) {
      if (ctx.signal?.aborted) break;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sessionDir = join(sessionStateDir, entry.name);
      const eventsPath = join(sessionDir, 'events.jsonl');
      const eventsStat = await utils.statSafe(eventsPath);
      if (eventsStat === null || !eventsStat.isFile) continue;
      eventsFiles += 1;
      bytes += eventsStat.size;
      try {
        sessions.push(...(await readSessionRow(ctx, eventsPath, sessionDir, eventsStat.size)));
      } catch (error) {
        ctx.warn(`Copilot CLI: cannot read ${eventsPath}: ${error?.message || error}`);
      }
    }
    // Older builds wrote flat event logs directly in session-state/.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
      const eventsPath = join(sessionStateDir, entry.name);
      const eventsStat = await utils.statSafe(eventsPath);
      if (eventsStat === null || !eventsStat.isFile) continue;
      eventsFiles += 1;
      bytes += eventsStat.size;
      try {
        sessions.push(...(await readSessionRow(ctx, eventsPath, sessionStateDir, eventsStat.size)));
      } catch (error) {
        ctx.warn(`Copilot CLI: cannot read ${eventsPath}: ${error?.message || error}`);
      }
    }
    sources.push({
      label: 'Copilot CLI session state',
      path: sessionStateDir,
      exists: true,
      files: eventsFiles,
      bytes,
      note: 'session-state/<id>/events.jsonl event streams; workspace.yaml supplies cwd/title',
    });
    if (eventsFiles === 0) {
      ctx.warn(
        'Copilot CLI: session-state directories were found but none contains an events.jsonl conversation ' +
          '(only workspace metadata/checkpoints, which hold no messages)',
      );
    }
  } else {
    sources.push({
      label: 'Copilot CLI session state',
      path: sessionStateDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: rootStat && rootStat.isDirectory ? 'Copilot CLI home found but no session-state directory' : 'GitHub Copilot CLI is not installed on this machine',
    });
  }

  const storeStat = await utils.statSafe(storePath);
  sources.push({
    label: 'Copilot CLI session store',
    path: storePath,
    exists: Boolean(storeStat && storeStat.isFile),
    files: 0,
    bytes: storeStat?.size || 0,
    note: 'assistant_usage_events token accounting only; conversation text lives in events.jsonl',
  });

  return { sources, sessions };
}

/**
 * Read one session's ACP event stream as a transcript.
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
        const data = record.data && typeof record.data === 'object' ? record.data : {};
        const ts = toEpochMs(record.timestamp) || toEpochMs(data.timestamp);
        if (type === 'user.message') {
          const text = eventText(data);
          if (text.trim() === '') return;
          messages.push({ role: 'user', ts, text: text.slice(0, MAX_TEXT) });
          return;
        }
        if (type === 'assistant.message') {
          const text = eventText(data);
          if (text.trim() === '') return;
          messages.push({
            role: 'assistant',
            ts,
            text: text.slice(0, MAX_TEXT),
            name: typeof data.model === 'string' ? data.model : undefined,
          });
          return;
        }
        if (type === 'tool.execution_start' || type === 'tool.start') {
          const name = typeof data.toolName === 'string' ? data.toolName : typeof data.name === 'string' ? data.name : 'tool';
          if (name === 'rename_session') return;
          messages.push({ role: 'tool', ts, kind: 'tool-call', name, text: clip(toolCallText(record), 600) });
          return;
        }
        if (type === 'tool.execution_complete' || type === 'tool.result') {
          const body = toolResultText(data.result ?? data.output ?? data);
          if (body.trim() === '') return;
          const name = typeof data.toolName === 'string' ? data.toolName : typeof data.name === 'string' ? data.name : undefined;
          messages.push({ role: 'tool', ts, kind: 'tool-result', name, text: body.slice(0, MAX_TEXT) });
        }
      },
      { signal: ctx.signal },
    );
  } catch {
    return { messages: [] };
  }
  return { messages };
}
