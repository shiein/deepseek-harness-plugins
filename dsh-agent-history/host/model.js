/**
 * Normalization helpers shared by the scanner, the providers and the transcript reader.
 *
 * Everything that reaches the snapshot goes through here, so a sloppy provider can never inject a
 * NaN timestamp, a `null` title or a path with a trailing slash into the UI.
 */

import { basename, normalize, sep } from 'node:path';

/** @param {unknown} value @returns {string} */
export function text(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Collapse whitespace and clip to `max` characters (ellipsis included). @param {string} value @param {number} max */
export function clip(value, max) {
  const collapsed = text(value).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Turn a raw prompt into readable preview text: drop injected system reminders, front-matter and
 * pasted-content wrappers that would otherwise hide the real first sentence.
 * @param {string} value
 * @returns {string}
 */
export function cleanPrompt(value) {
  let out = text(value);
  if (out === '') return '';
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  out = out.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ');
  out = out.replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ');
  out = out.replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ');
  out = out.replace(/<command-args>[\s\S]*?<\/command-args>/gi, ' ');
  out = out.replace(/<pasted_content[^>]*>/gi, ' ').replace(/<\/pasted_content>/gi, ' ');
  out = out.replace(/<[^>]{0,80}>/g, (match) => (match.includes(' ') ? ' ' : ''));
  out = out.replace(/```[\s\S]*?```/g, ' [代码] ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** First meaningful line of a prompt, used as a fallback title. @param {string} value @param {number} max */
export function titleFromPrompt(value, max = 72) {
  const cleaned = cleanPrompt(value);
  if (cleaned === '') return '';
  return clip(cleaned, max);
}

/** Normalize a project path so two agents that report the same folder group together. @param {unknown} value */
export function normalizeProjectPath(value) {
  const raw = text(value).trim();
  if (raw === '') return '';
  let out = normalize(raw);
  if (out.length > 1 && (out.endsWith(sep) || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

/** Display name of a project folder. @param {string} projectPath */
export function projectName(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (normalized === '') return '未记录项目';
  if (normalized === sep || normalized === '/') return normalized;
  return basename(normalized) || normalized;
}

/**
 * Key used to group sessions under one project row. Windows paths are case-insensitive and agents
 * disagree on drive-letter case (`c:\\x` vs `C:\\x`) and separators, so they compare folded.
 * @param {string} projectPath
 */
export function projectKey(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (normalized === '') return '::unknown';
  return `p:${comparablePath(normalized)}`;
}

/** Comparable form of a path: forward slashes; lower-cased when it is a Windows path. @param {string} value */
export function comparablePath(value) {
  const raw = text(value).trim();
  const windows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.includes('\\');
  let out = raw.replace(/\\/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(out)) out = `${out}/`;
  return windows ? out.toLowerCase() : out;
}

/**
 * Build the project index shown by the UI.
 * @param {Array<import('./types.js').SessionSummary>} sessions
 * @returns {Array<{key: string, path: string, name: string, sessions: number, messages: number,
 *                  agents: string[], startedAt: number, updatedAt: number, unknown: boolean}>}
 */
export function buildProjects(sessions) {
  const map = new Map();
  for (const session of sessions) {
    const key = projectKey(session.projectPath);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        path: normalizeProjectPath(session.projectPath),
        name: projectName(session.projectPath),
        sessions: 0,
        messages: 0,
        agents: [],
        startedAt: session.startedAt || session.updatedAt,
        updatedAt: session.updatedAt,
        unknown: session.projectPath === '',
      };
      map.set(key, entry);
    }
    entry.sessions += 1;
    entry.messages += session.messages;
    if (!entry.agents.includes(session.agentId)) entry.agents.push(session.agentId);
    if (session.startedAt && session.startedAt < entry.startedAt) entry.startedAt = session.startedAt;
    if (session.updatedAt > entry.updatedAt) entry.updatedAt = session.updatedAt;
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Normalize one provider session into the snapshot shape. Throws away records without an id.
 * @param {string} agentId
 * @param {Partial<import('./types.js').SessionSummary>} raw
 * @returns {import('./types.js').SessionSummary|null}
 */
export function finalizeSession(agentId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nativeId = text(raw.nativeId).trim();
  if (nativeId === '') return null;
  const startedAt = numberOr(raw.startedAt, 0);
  const updatedAt = numberOr(raw.updatedAt, startedAt || 0);
  const messages = Math.max(0, Math.round(numberOr(raw.messages, 0)));
  const userMessages = Math.max(0, Math.round(numberOr(raw.userMessages, 0)));
  const projectPath = normalizeProjectPath(raw.projectPath);
  return {
    id: `${agentId}:${nativeId}`,
    agentId,
    nativeId,
    title: clip(raw.title, 120) || '未命名会话',
    projectPath,
    startedAt,
    updatedAt,
    messages,
    userMessages,
    sizeBytes: Math.max(0, Math.round(numberOr(raw.sizeBytes, 0))),
    preview: clip(raw.preview, 220),
    lastPreview: clip(raw.lastPreview, 220),
    sourcePath: text(raw.sourcePath),
    extra: clip(raw.extra, 80) || undefined,
    ref: raw.ref && typeof raw.ref === 'object' ? raw.ref : {},
  };
}

/** @param {unknown} value @param {number} fallback */
function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Normalize a message list: coerce shapes, drop empties, keep order stable by timestamp.
 * @param {Array<Partial<import('./types.js').TranscriptMessage>>} messages
 * @returns {Array<import('./types.js').TranscriptMessage>}
 */
export function finalizeMessages(messages) {
  const out = [];
  for (const raw of messages || []) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role === 'assistant' || raw.role === 'user' || raw.role === 'tool' || raw.role === 'system' ? raw.role : 'system';
    const body = text(raw.text).replace(/\u0000/g, '');
    if (body.trim() === '') continue;
    const ts = Number(raw.ts);
    out.push({
      role,
      ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
      text: body.length > 20000 ? `${body.slice(0, 20000)}\n…（已截断）` : body,
      kind: raw.kind === 'tool-call' || raw.kind === 'tool-result' ? raw.kind : undefined,
      name: clip(raw.name, 60) || undefined,
    });
  }
  return out;
}

/** Compact message preview used by the merged timeline (keeps payloads small). @param {string} body @param {number} max */
export function previewText(body, max = 320) {
  return clip(body, max);
}
