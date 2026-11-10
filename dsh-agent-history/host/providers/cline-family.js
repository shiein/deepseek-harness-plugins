/**
 * Cline / Roo Code / Kilo Code history provider (the "Cline family").
 *
 * These VS Code-derived extensions persist one directory per task in the hosting editor's
 * globalStorage:
 *   macOS:   ~/Library/Application Support/<IDE>/User/globalStorage/<extension>/tasks/<taskId>
 *   Windows: %APPDATA%\<IDE>\User\globalStorage\<extension>\tasks\<taskId>
 *   Linux:   ~/.config/<IDE>/User/globalStorage/<extension>/tasks\<taskId>
 * with <extension> in saoudrizwan.claude-dev (Cline), rooveterinaryinc.roo-cline (Roo Code) and
 * kilocode.kilo-code (Kilo Code).
 *
 * Per task we read:
 *   ui_messages.json            the UI protocol: say 'task' / 'user_feedback' are user turns,
 *                               say 'text' / 'reasoning' / 'completion_result' and ask 'followup'
 *                               are assistant turns, say/ask 'tool'/'command' are tool calls and
 *                               'command_output' results.
 *   api_conversation_history.json  Anthropic-style fallback transcript (and, on older builds,
 *                               the only place a workspace path appears in `<environment_details>`).
 *   history_item.json / task_metadata.json / ../../state/taskHistory.json
 *                               title, timestamp and workspace/cwd mapping.
 * Project folder: task metadata / taskHistory cwd / env-details header; never guessed from a
 * mangled name. Legacy VS Code tasks have no CLI resume, so resume.kind is 'none'.
 */

import { dirname, join } from 'node:path';
import { cleanPrompt, clip, titleFromPrompt } from '../model.js';
import { fileUriToPath, readText, safeJsonParse } from '../scan-utils.js';

export const meta = {
  id: 'cline-family',
  name: 'Cline / Roo / Kilo',
  color: '#f97316',
  homepage: 'https://cline.bot',
  cacheVersion: 2,
  resume: { kind: 'none' },
};

const IDE_NAMES = [
  'Code',
  'Code - Insiders',
  'Cursor',
  'Cursor Nightly',
  'CodeBuddy',
  'CodeBuddy CN',
  'Windsurf',
  'VSCodium',
  'Trae',
  'Trae CN',
  'Devin',
  'Qoder',
];

const EXTENSIONS = [
  { id: 'saoudrizwan.claude-dev', family: 'Cline' },
  { id: 'rooveterinaryinc.roo-cline', family: 'Roo Code' },
  { id: 'kilocode.kilo-code', family: 'Kilo Code' },
];

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

/** @param {unknown} value @returns {number} epoch ms, 0 when unparseable */
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

/**
 * Strip the injected wrappers Cline/Roo put around task text and environment details.
 * @param {string} value
 * @returns {string}
 */
function cleanClineText(value) {
  let text = typeof value === 'string' ? value : '';
  if (text === '') return '';
  text = text.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, ' ');
  const taskEnvelope = /<task>([\s\S]*?)<\/task>/i.exec(text);
  if (taskEnvelope) text = taskEnvelope[1];
  return cleanPrompt(text);
}

/**
 * A workspace field may be a plain path or a `file://` URI; both become an absolute folder.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeWorkspacePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const text = value.trim();
  if (!text.startsWith('file://')) return text;
  return fileUriToPath(text) || text;
}

/**
 * Workspace folder from an `api_conversation_history.json` / ui text environment block.
 * @param {string} raw
 * @returns {string}
 */
function workspaceFromEnvironmentDetails(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  const patterns = [
    /#\s*Current Workspace Directory\s*\(([^)]+)\)/i,
    /#\s*Current Working Directory\s*\(([^)]+)\)/i,
    /#\s*Workspace (?:Directory|Root)\s*\(([^)]+)\)/i,
    /<cwd>\s*([^<]+?)\s*<\/cwd>/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match && match[1].trim() !== '') return normalizeWorkspacePath(match[1]);
  }
  return '';
}

/**
 * stat() several optional files into one cache fingerprint plus a byte total.
 * @param {typeof import('../scan-utils.js')} utils
 * @param {string[]} paths
 * @returns {Promise<{fingerprint: string, bytes: number}>}
 */
async function statParts(utils, paths) {
  let bytes = 0;
  const parts = [];
  for (const path of paths) {
    const stat = await utils.statSafe(path);
    if (stat && stat.isFile) {
      parts.push(`${stat.size}:${Math.round(stat.mtimeMs)}`);
      bytes += stat.size;
    } else {
      parts.push('-');
    }
  }
  return { fingerprint: parts.join('|'), bytes };
}

/**
 * @param {Record<string, any>} payload
 * @returns {{name: string, text: string}}
 */
function toolFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return { name: 'tool', text: '' };
  const name =
    typeof payload.tool === 'string' ? payload.tool : typeof payload.name === 'string' ? payload.name : 'tool';
  const summary = payload.path || payload.command || payload.file_path || payload.query || '';
  return { name, text: summary !== '' ? String(summary) : clip(JSON.stringify(payload), 600) };
}

/**
 * Parse `ui_messages.json` into conversation entries.
 * @param {unknown} value
 * @returns {{messages: any[], model: string}}
 */
function parseUiMessages(value) {
  /** @type {any[]} */
  const messages = [];
  let model = '';
  if (!Array.isArray(value)) return { messages, model };
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (item);
    const ts = toEpochMs(record.ts);
    const say = typeof record.say === 'string' ? record.say : '';
    const ask = typeof record.ask === 'string' ? record.ask : '';
    const text = typeof record.text === 'string' ? record.text : '';
    if (say === 'api_req_started' && text.startsWith('{')) {
      const payload = safeJsonParse(text);
      if (payload && typeof payload === 'object') {
        const candidates = [payload.modelId, payload.model, payload.modelInfo?.modelId];
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim() !== '') {
            model = candidate.trim();
            break;
          }
        }
      }
      continue;
    }
    if (say === 'task') {
      const body = cleanClineText(text);
      if (body !== '') messages.push({ role: 'user', ts, text: body });
      continue;
    }
    if (say === 'user_feedback') {
      const body = cleanClineText(text);
      if (body !== '') messages.push({ role: 'user', ts, text: body });
      continue;
    }
    if (say === 'text' || say === 'completion_result' || ask === 'followup' || ask === 'completion_result') {
      const body = cleanClineText(text);
      if (body !== '') messages.push({ role: 'assistant', ts, text: body });
      continue;
    }
    if (say === 'reasoning') {
      const body = cleanClineText(text);
      if (body !== '') messages.push({ role: 'assistant', ts, text: body, kind: 'thinking' });
      continue;
    }
    if (say === 'tool' || ask === 'tool' || say === 'command' || ask === 'command') {
      const payload = text.startsWith('{') ? safeJsonParse(text) : null;
      const tool = toolFromPayload(payload && typeof payload === 'object' ? /** @type {Record<string, any>} */ (payload) : null);
      messages.push({
        role: 'tool',
        ts,
        kind: 'tool-call',
        name: tool.name,
        text: tool.text !== '' ? tool.text : clip(text, 600),
      });
      continue;
    }
    if (say === 'command_output' || ask === 'command_output') {
      if (text.trim() !== '') messages.push({ role: 'tool', ts, kind: 'tool-result', text: text.slice(0, MAX_TEXT) });
    }
  }
  return { messages, model };
}

/**
 * Parse `api_conversation_history.json` (Anthropic-style array).
 * @param {unknown} value
 * @returns {any[]}
 */
function parseHistoryMessages(value) {
  /** @type {any[]} */
  const messages = [];
  if (!Array.isArray(value)) return messages;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (item);
    const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : '';
    if (role === '') continue;
    const content = Array.isArray(record.content) ? record.content : typeof record.content === 'string' ? [record.content] : [];
    const textParts = [];
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
      else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        messages.push({ role: 'assistant', ts: 0, text: block.thinking.slice(0, MAX_TEXT), kind: 'thinking' });
      } else if (block.type === 'tool_use') {
        messages.push({
          role: 'tool',
          ts: 0,
          kind: 'tool-call',
          name: typeof block.name === 'string' ? block.name : 'tool',
          text: clip(JSON.stringify(block.input ?? {}), 600),
        });
      } else if (block.type === 'tool_result') {
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (body.trim() !== '') messages.push({ role: 'tool', ts: 0, kind: 'tool-result', text: body.slice(0, MAX_TEXT) });
      }
    }
    const text = textParts.join('\n');
    if (text.trim() !== '') messages.push({ role, ts: 0, text });
  }
  return messages;
}

/**
 * First absolute path found under keys that name a workspace/cwd.
 * @param {unknown} value
 * @param {number} depth
 * @returns {string}
 */
function findWorkspaceField(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  const record = /** @type {Record<string, any>} */ (value);
  for (const key of ['workspace', 'workspacePath', 'cwd', 'workingDirectory', 'projectPath', 'rootPath']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return normalizeWorkspacePath(candidate);
    if (candidate && typeof candidate === 'object' && typeof candidate.path === 'string') return normalizeWorkspacePath(candidate.path);
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const found = findWorkspaceField(nested, depth + 1);
      if (found !== '') return found;
    }
  }
  return '';
}

/**
 * @param {any[]} taskHistory
 * @returns {Map<string, Record<string, any>>}
 */
function indexTaskHistory(taskHistory) {
  /** @type {Map<string, Record<string, any>>} */
  const map = new Map();
  if (!Array.isArray(taskHistory)) return map;
  for (const entry of taskHistory) {
    if (!entry || typeof entry !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (entry);
    const id = typeof record.id === 'string' ? record.id : typeof record.taskId === 'string' ? record.taskId : '';
    if (id !== '') map.set(id, record);
  }
  return map;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} taskDir
 * @param {string} taskId
 * @param {Map<string, Record<string, any>>} taskHistory
 * @param {string} historyFingerprint
 * @param {string} historyFile
 * @returns {Promise<any|null>}
 */
async function readTask(ctx, taskDir, taskId, taskHistory, historyFingerprint, historyFile) {
  const { utils } = ctx;
  const uiMessagesPath = join(taskDir, 'ui_messages.json');
  const conversationPath = join(taskDir, 'api_conversation_history.json');
  const itemPath = join(taskDir, 'history_item.json');
  const metadataPath = join(taskDir, 'task_metadata.json');
  const { fingerprint: partsFingerprint, bytes } = await statParts(utils, [uiMessagesPath, conversationPath, itemPath, metadataPath]);
  const fingerprint = `${partsFingerprint}|${historyFingerprint}`;
  const cacheKey = uiMessagesPath;
  const cached = cacheGet(ctx, cacheKey, fingerprint);
  if (cached) return cached[0] ?? null;

  const uiRaw = await readText(uiMessagesPath);
  const uiValue = uiRaw === null ? null : safeJsonParse(uiRaw);
  const uiParsed = parseUiMessages(uiValue);
  let messages = uiParsed.messages;
  const historyRaw = await readText(conversationPath);
  if (messages.filter((message) => message.role === 'user' || message.role === 'assistant').length === 0 && historyRaw !== null) {
    messages = parseHistoryMessages(safeJsonParse(historyRaw));
  }
  const textMessages = messages.filter(
    (message) => (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string' && message.text.trim() !== '',
  );
  if (textMessages.length === 0) {
    cacheSet(ctx, cacheKey, fingerprint, []);
    return null;
  }

  const historyItem = safeJsonParse((await readText(itemPath)) || '');
  const metadata = safeJsonParse((await readText(metadataPath)) || '');
  const historyEntry = taskHistory.get(taskId) || null;
  const projectPath =
    findWorkspaceField(historyItem) ||
    findWorkspaceField(metadata) ||
    findWorkspaceField(historyEntry) ||
    workspaceFromEnvironmentDetails(historyRaw || '') ||
    workspaceFromEnvironmentDetails(uiRaw || '');

  let startedAt = 0;
  let updatedAt = 0;
  let userMessages = 0;
  let firstPrompt = '';
  let lastPreview = '';
  for (const message of textMessages) {
    if (message.ts > 0) {
      if (startedAt === 0 || message.ts < startedAt) startedAt = message.ts;
      if (message.ts > updatedAt) updatedAt = message.ts;
    }
    if (message.role === 'user') {
      userMessages += 1;
      if (firstPrompt === '') firstPrompt = message.text;
    }
    lastPreview = message.text;
  }
  const fallbackTs = toEpochMs(historyItem?.ts) || toEpochMs(historyEntry?.ts) || 0;
  if (startedAt === 0) startedAt = fallbackTs;
  if (updatedAt === 0) updatedAt = startedAt;
  const titleCandidates = [
    typeof historyEntry?.task === 'string' ? historyEntry.task : '',
    typeof historyItem?.task === 'string' ? historyItem.task : '',
    typeof metadata?.task === 'string' ? metadata.task : '',
  ];
  let title = '';
  for (const candidate of titleCandidates) {
    const cleaned = cleanClineText(candidate);
    if (cleaned !== '') {
      title = titleFromPrompt(cleaned, 90);
      break;
    }
  }
  if (title === '') title = titleFromPrompt(firstPrompt, 90);

  const row = {
    nativeId: taskId,
    title: title || '未命名会话',
    projectPath,
    startedAt,
    updatedAt,
    messages: textMessages.length,
    userMessages,
    sizeBytes: bytes,
    preview: cleanPrompt(firstPrompt).slice(0, 220),
    lastPreview: cleanPrompt(lastPreview).slice(0, 220),
    sourcePath: uiRaw !== null ? uiMessagesPath : historyFile,
    extra: uiParsed.model !== '' ? uiParsed.model : undefined,
    ref: { taskDir, uiMessages: uiRaw !== null ? uiMessagesPath : '', history: conversationPath, nativeId: taskId },
  };
  cacheSet(ctx, cacheKey, fingerprint, [row]);
  return row;
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {string} extensionDir
 * @param {string} family
 * @returns {Promise<{sessions: any[], files: number, bytes: number, historyPath: string}>}
 */
async function scanExtension(ctx, extensionDir, family) {
  const { utils } = ctx;
  const tasksDir = join(extensionDir, 'tasks');
  /** @type {any[]} */
  const sessions = [];
  let files = 0;
  let bytes = 0;
  const tasksStat = await utils.statSafe(tasksDir);
  if (tasksStat === null || !tasksStat.isDirectory) return { sessions, files, bytes, historyPath: '' };
  let taskHistoryPath = '';
  let taskHistoryRaw = null;
  for (const candidate of [
    join(extensionDir, 'state', 'taskHistory.json'),
    join(extensionDir, 'taskHistory.json'),
    join(dirname(extensionDir), 'state', 'taskHistory.json'),
  ]) {
    const raw = await readText(candidate);
    if (raw !== null) {
      taskHistoryPath = candidate;
      taskHistoryRaw = raw;
      break;
    }
  }
  const taskHistoryStat = taskHistoryPath !== '' ? await utils.statSafe(taskHistoryPath) : null;
  const historyFingerprint = taskHistoryStat ? `${taskHistoryStat.size}:${Math.round(taskHistoryStat.mtimeMs)}` : '-';
  const taskHistory = indexTaskHistory(safeJsonParse(taskHistoryRaw || ''));
  const entries = (await utils.readdirSafe(tasksDir)).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    if (ctx.signal?.aborted) break;
    const taskDir = join(tasksDir, entry.name);
    const uiMessagesPath = join(taskDir, 'ui_messages.json');
    const uiStat = await utils.statSafe(uiMessagesPath);
    if (uiStat && uiStat.isFile) {
      files += 1;
      bytes += uiStat.size;
    } else {
      const conversationStat = await utils.statSafe(join(taskDir, 'api_conversation_history.json'));
      if (conversationStat === null || !conversationStat.isFile) continue;
      files += 1;
      bytes += conversationStat.size;
    }
    try {
      const row = await readTask(ctx, taskDir, entry.name, taskHistory, historyFingerprint, uiMessagesPath);
      if (row !== null) {
        row.extra = row.extra || (family !== '' ? family : undefined);
        sessions.push(row);
      }
    } catch (error) {
      ctx.warn(`Cline family: cannot read ${taskDir}: ${error?.message || error}`);
    }
  }
  return { sessions, files, bytes, historyPath: taskHistoryRaw !== null ? taskHistoryPath : '' };
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
  let foundAnyExtension = false;

  const storageRoots = IDE_NAMES.map((ide) => ({ ide, globalStorage: join(env.appData, ide, 'User', 'globalStorage') }));
  for (const root of storageRoots) {
    const entries = await utils.readdirSafe(root.globalStorage);
    if (entries.length === 0) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const extension = EXTENSIONS.find((candidate) => candidate.id.toLowerCase() === entry.name.toLowerCase());
      if (!extension) continue;
      const extensionDir = join(root.globalStorage, entry.name);
      const tasksStat = await utils.statSafe(join(extensionDir, 'tasks'));
      if (tasksStat === null || !tasksStat.isDirectory) continue;
      foundAnyExtension = true;
      const result = await scanExtension(ctx, extensionDir, extension.family);
      sessions.push(...result.sessions);
      sources.push({
        label: `${extension.family} tasks`,
        path: join(extensionDir, 'tasks'),
        exists: true,
        files: result.files,
        bytes: result.bytes,
        note: 'ui_messages.json + api_conversation_history.json; title/workspace from history_item.json / taskHistory.json',
      });
      sources.push({
        label: `${extension.family} task history`,
        path: join(extensionDir, 'state', 'taskHistory.json'),
        exists: result.historyPath !== '',
        files: result.historyPath !== '' ? 1 : 0,
        bytes: 0,
        note: 'legacy Cline taskHistory.json (task prompt + timestamp) when present',
      });
    }
  }

  // Cline's standalone CLI/desktop app keeps sessions outside the extension layout. Detect it so
  // the panel shows the installation, but its store is not parsed by this provider.
  const sessionsOverride = (process.env.CLINE_SESSION_DATA_DIR || '').trim();
  const dataOverride = (process.env.CLINE_DATA_DIR || '').trim();
  const clineDir = (process.env.CLINE_DIR || '').trim();
  const clineSessions =
    sessionsOverride !== ''
      ? sessionsOverride.replace(/^~(?=$|[\\/])/, env.home)
      : join(
          dataOverride !== '' ? dataOverride.replace(/^~(?=$|[\\/])/, env.home) : join(clineDir !== '' ? clineDir.replace(/^~(?=$|[\\/])/, env.home) : join(env.home, '.cline'), 'data'),
          'sessions',
        );
  const clineStat = await utils.statSafe(clineSessions);
  if (clineStat && clineStat.isDirectory) {
    sources.push({
      label: 'Cline CLI sessions',
      path: clineSessions,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'modern Cline CLI session store detected but not parsed by this extension-format provider',
    });
  }

  if (!foundAnyExtension) {
    const looksLikeModernCli = clineStat !== null && clineStat.isDirectory;
    sources.push({
      label: 'Cline family extension storage',
      path: join(env.appData, 'Code', 'User', 'globalStorage'),
      exists: false,
      files: 0,
      bytes: 0,
      note: looksLikeModernCli
        ? 'no Cline / Roo Code / Kilo Code extension tasks found (only the modern Cline CLI store exists)'
        : 'no Cline / Roo Code / Kilo Code globalStorage found',
    });
    if (looksLikeModernCli) {
      ctx.warn('Cline family: only the modern Cline CLI session store exists; this provider parses the VS Code extension tasks layout, not the CLI store');
    }
  } else if (sessions.length === 0) {
    ctx.warn('Cline family: extension task directories were found but none contains a readable conversation');
  }

  return { sources, sessions };
}

/**
 * @param {import('../types.js').ScanContext} ctx
 * @param {any} session
 * @returns {Promise<{messages: any[]}>}
 */
export async function readMessages(ctx, session) {
  const ref = session?.ref || {};
  const taskDir = typeof ref.taskDir === 'string' ? ref.taskDir : '';
  if (taskDir === '') return { messages: [] };
  const { utils } = ctx;
  /** @type {any[]} */
  const messages = [];
  const uiRaw = await readText(join(taskDir, 'ui_messages.json'));
  if (uiRaw !== null) {
    for (const message of parseUiMessages(safeJsonParse(uiRaw)).messages) {
      if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
      messages.push({
        role: message.role,
        ts: message.ts || 0,
        text: message.text.slice(0, MAX_TEXT),
        kind: message.kind,
        name: message.kind === 'tool-call' ? message.name : undefined,
      });
    }
  }
  if (messages.filter((message) => message.role === 'user' || message.role === 'assistant').length === 0) {
    const historyRaw = await readText(join(taskDir, 'api_conversation_history.json'));
    if (historyRaw !== null) {
      for (const message of parseHistoryMessages(safeJsonParse(historyRaw))) {
        if (messages.length >= MAX_TRANSCRIPT_MESSAGES) break;
        messages.push({ role: message.role, ts: message.ts || 0, text: message.text.slice(0, MAX_TEXT), kind: message.kind, name: message.name });
      }
    }
  }
  return { messages };
}
