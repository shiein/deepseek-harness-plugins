/**
 * Cline / Roo Code / Kilo Code usage provider (the "Cline family").
 *
 * These VS Code-derived extensions persist one directory per task in the hosting VS Code
 * fork's globalStorage. Every supported app root is scanned:
 *   macOS:   ~/Library/Application Support/<IDE>/User/globalStorage/<extension>/tasks
 *   Windows: %APPDATA%\<IDE>\User\globalStorage\<extension>\tasks
 *   Linux:   ~/.config/<IDE>/User/globalStorage/<extension>/tasks
 * with <IDE> in Code, Code - Insiders, Cursor, CodeBuddy, CodeBuddy CN, Windsurf, VSCodium,
 * Trae, Trae CN, Devin, Qoder, ... and <extension> in:
 *   saoudrizwan.claude-dev         (Cline)
 *   rooveterinaryinc.roo-cline     (Roo Code)
 *   kilocode.kilo-code             (Kilo Code)
 *
 * Each `<taskId>/ui_messages.json` is a JSON ARRAY. Token usage records are messages with
 *   say = "api_req_started" | "api_req_deleted"
 * whose `text` is a JSON string:
 *   { tokensIn, tokensOut, cacheWrites, cacheReads, apiProtocol, cost?, modelId?, ... }
 * `tokensIn` already excludes cache; cacheReads/cacheWrites are separate buckets.
 *
 * Model attribution:
 *   - explicit payload modelId/model fields when present (newer versions),
 *   - Roo/Cline `api_conversation_history.json` -> the last `<model>...</model>` tag inside
 *     `<environment_details>` blocks,
 *   - `task_metadata.json` model/modelId fields,
 *   - otherwise "unknown" (never guess a model).
 *
 * Cline's newer standalone CLI/desktop app keeps sessions outside the extension layout:
 *   ~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json
 * where each assistant message carries
 *   metrics = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *               reasoningTokenCount?, cost? }
 * and `inputTokens` INCLUSIVE of both cache buckets (uncached = input - read - write).
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'cline-family',
  name: 'Cline / Roo / Kilo',
  color: '#f97316',
  homepage: 'https://cline.bot',
  cacheVersion: 1,
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

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {number|null} */
function toCost(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

/** @param {unknown} value @returns {number|null} */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 100_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return coerceEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** @param {string} path @returns {Promise<string>} */
async function statFingerprint(utils, path) {
  const stat = await utils.statSafe(path);
  return stat && stat.isFile ? `${stat.size}:${Math.round(stat.mtimeMs)}` : '-';
}

/**
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {{ide: string, root: string, globalStorage: string}[]}
 */
function globalStorageRoots(env, utils) {
  const roots = [];
  for (const ide of IDE_NAMES) {
    const root = utils.joinPath(env.appData, ide);
    roots.push({ ide, root, globalStorage: utils.joinPath(root, 'User', 'globalStorage') });
  }
  return roots;
}

/**
 * Case-insensitive lookup of the three extension folders inside one globalStorage dir.
 * @param {any} utils
 * @param {string} globalStorage
 * @returns {Promise<Map<string, string>>} extension id -> absolute folder
 */
async function extensionFolders(utils, globalStorage) {
  const found = new Map();
  const entries = await utils.readdirSafe(globalStorage);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    for (const extension of EXTENSIONS) {
      if (lower === extension.id.toLowerCase()) {
        found.set(extension.id, utils.joinPath(globalStorage, entry.name));
      }
    }
  }
  return found;
}

/**
 * Read a Roo/Cline task's model from the most recent `<model>` tag. Bounded to the last 1 MiB
 * so pathological history files cannot stall a refresh.
 * @param {any} utils
 * @param {string} uiMessagesPath
 * @returns {Promise<string|null>}
 */
async function readHistoryModel(utils, uiMessagesPath) {
  const historyPath = utils.joinPath(utils.dirnameOf(uiMessagesPath), 'api_conversation_history.json');
  const stat = await utils.statSafe(historyPath);
  if (!stat || !stat.isFile) return null;
  let raw = await utils.readText(historyPath);
  if (!raw) return null;
  if (raw.length > 1_048_576) {
    const tail = raw.slice(raw.length - 1_048_576);
    const start = tail.indexOf('<environment_details>');
    raw = start >= 0 ? tail.slice(start) : tail;
  }
  const matches = raw.match(/<model>\s*([^<\s][^<]*?)\s*<\/model>/g) || [];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1].replace(/<\/?model>/g, '').trim();
  return last === '' ? null : last;
}

/**
 * @param {any} utils
 * @param {string} taskDir
 * @returns {Promise<string|null>}
 */
async function readTaskMetadataModel(utils, taskDir) {
  const raw = await utils.readText(utils.joinPath(taskDir, 'task_metadata.json'));
  if (!raw) return null;
  const parsed = utils.safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of ['modelId', 'model', 'modelName']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** @param {any} payload @returns {string|null} */
function payloadModel(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.modelId,
    payload.model,
    payload.modelName,
    payload.modelInfo?.modelId,
    payload.modelInfo?.id,
    payload.modelInfo?.model,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {{path: string, taskId: string, taskDir: string}} taskFile
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanTaskFile(ctx, taskFile) {
  const { utils, cache } = ctx;
  const historyPath = utils.joinPath(taskFile.taskDir, 'api_conversation_history.json');
  const metadataPath = utils.joinPath(taskFile.taskDir, 'task_metadata.json');
  const fingerprint = [
    taskFile.path,
    await statFingerprint(utils, taskFile.path),
    await statFingerprint(utils, historyPath),
    await statFingerprint(utils, metadataPath),
  ].join('|');
  const cached = cache.get(taskFile.path, fingerprint);
  if (cached) return cached;

  const raw = await utils.readText(taskFile.path);
  if (!raw) return [];
  const messages = utils.safeJsonParse(raw);
  if (!Array.isArray(messages)) return [];

  const historyModel = await readHistoryModel(utils, taskFile.path);
  const metadataModel = await readTaskMetadataModel(utils, taskFile.taskDir);

  /** @type {Map<string, import('../scanner-types.js').Cell>} */
  const byKey = new Map();
  const seen = new Set();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.say !== 'api_req_started' && message.say !== 'api_req_deleted') continue;
    if (typeof message.text !== 'string' || !message.text.startsWith('{')) continue;
    const payload = utils.safeJsonParse(message.text);
    if (!payload) continue;
    const timestamp = coerceEpochMs(message.ts);
    if (!timestamp) continue;
    const tokensIn = toCount(payload.tokensIn);
    const tokensOut = toCount(payload.tokensOut);
    const cacheRead = toCount(payload.cacheReads);
    const cacheWrite = toCount(payload.cacheWrites);
    if (tokensIn + tokensOut + cacheRead + cacheWrite <= 0) continue;
    const dedupKey = `${taskFile.taskId}:${timestamp}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const model = payloadModel(payload) || historyModel || metadataModel || 'unknown';
    const day = utils.localDay(timestamp);
    const key = `${model}\u0000${day}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = {
        model,
        day,
        input: tokensIn,
        output: tokensOut,
        cacheRead,
        cacheWrite,
        messages: 0,
        firstTs: timestamp,
        lastTs: timestamp,
      };
      byKey.set(key, cell);
    } else {
      cell.input += tokensIn;
      cell.output += tokensOut;
      cell.cacheRead += cacheRead;
      cell.cacheWrite += cacheWrite;
    }
    cell.messages += 1;
    if (timestamp < cell.firstTs) cell.firstTs = timestamp;
    if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    const cost = toCost(payload.cost);
    if (cost !== null && cost > 0) cell.costUsd = (cell.costUsd || 0) + cost;
  }
  const cells = [...byKey.values()];
  cache.set(taskFile.path, fingerprint, cells);
  return cells;
}

/**
 * Cline standalone CLI/desktop session (`<session>.messages.json`).
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} filePath
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanClineSessionFile(ctx, filePath) {
  const { utils, cache } = ctx;
  const fingerprint = await statFingerprint(utils, filePath);
  if (fingerprint === '-') return [];
  const cached = cache.get(filePath, fingerprint);
  if (cached) return cached;
  const raw = await utils.readText(filePath);
  if (!raw) return [];
  const document = utils.safeJsonParse(raw);
  const messages = Array.isArray(document) ? document : document?.messages;
  if (!Array.isArray(messages)) return [];

  /** @type {Map<string, import('../scanner-types.js').Cell>} */
  const byKey = new Map();
  const seen = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const metrics = message.metrics && typeof message.metrics === 'object' ? message.metrics : null;
    if (!metrics) continue;
    const timestamp = coerceEpochMs(message.ts);
    if (!timestamp) continue;
    const cacheRead = toCount(metrics.cacheReadTokens);
    const cacheWrite = toCount(metrics.cacheWriteTokens);
    const inclusiveInput = toCount(metrics.inputTokens);
    const input = Math.max(0, inclusiveInput - cacheRead - cacheWrite);
    const output = toCount(metrics.outputTokens);
    if (input + output + cacheRead + cacheWrite <= 0) continue;
    const id =
      (typeof message.id === 'string' && message.id) ||
      `${utils.basenameOf(filePath)}:${timestamp}:${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const modelInfo = message.modelInfo && typeof message.modelInfo === 'object' ? message.modelInfo : null;
    const model =
      (typeof modelInfo?.id === 'string' && modelInfo.id.trim()) ||
      (typeof modelInfo?.model === 'string' && modelInfo.model.trim()) ||
      (typeof document?.model === 'string' && document.model.trim()) ||
      'unknown';
    const day = utils.localDay(timestamp);
    const key = `${model}\u0000${day}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = {
        model,
        day,
        input,
        output,
        cacheRead,
        cacheWrite,
        messages: 0,
        firstTs: timestamp,
        lastTs: timestamp,
      };
      byKey.set(key, cell);
    } else {
      cell.input += input;
      cell.output += output;
      cell.cacheRead += cacheRead;
      cell.cacheWrite += cacheWrite;
    }
    cell.messages += 1;
    if (timestamp < cell.firstTs) cell.firstTs = timestamp;
    if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    const cost = toCost(metrics.cost);
    if (cost !== null && cost > 0) cell.costUsd = (cell.costUsd || 0) + cost;
  }
  const cells = [...byKey.values()];
  cache.set(filePath, fingerprint, cells);
  return cells;
}

/**
 * Merge cells so one bucket per (model, local day) is returned to the framework.
 * @param {import('../scanner-types.js').Cell[]} cells
 * @returns {import('../scanner-types.js').Cell[]}
 */
function mergeProviderCells(cells) {
  /** @type {Map<string, import('../scanner-types.js').Cell>} */
  const map = new Map();
  for (const cell of cells) {
    const key = `${cell.model}\u0000${cell.day}`;
    const target = map.get(key);
    if (!target) {
      map.set(key, { ...cell });
      continue;
    }
    target.input += cell.input;
    target.output += cell.output;
    target.cacheRead += cell.cacheRead;
    target.cacheWrite += cell.cacheWrite;
    target.messages += cell.messages;
    if (cell.reasoning) target.reasoning = (target.reasoning || 0) + cell.reasoning;
    if (typeof cell.costUsd === 'number') target.costUsd = (target.costUsd || 0) + cell.costUsd;
    if (typeof cell.firstTs === 'number' && (target.firstTs === undefined || cell.firstTs < target.firstTs)) {
      target.firstTs = cell.firstTs;
    }
    if (typeof cell.lastTs === 'number' && (target.lastTs === undefined || cell.lastTs > target.lastTs)) {
      target.lastTs = cell.lastTs;
    }
  }
  return [...map.values()];
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];

  /** @type {Map<string, {family: string, tasksDir: string, files: number, bytes: number}>} */
  const tasksSeen = new Map();
  let foundAnyExtension = false;

  for (const root of globalStorageRoots(env, utils)) {
    const storageStat = await utils.statSafe(root.globalStorage);
    if (!storageStat || !storageStat.isDirectory) continue;
    const folders = await extensionFolders(utils, root.globalStorage);
    for (const [extensionId, extensionDir] of folders) {
      foundAnyExtension = true;
      const extension = EXTENSIONS.find((entry) => entry.id === extensionId);
      const tasksDir = utils.joinPath(extensionDir, 'tasks');
      const tasksStat = await utils.statSafe(tasksDir);
      if (!tasksStat || !tasksStat.isDirectory) continue;
      let files = 0;
      let bytes = 0;
      for (const taskEntry of await utils.readdirSafe(tasksDir)) {
        if (!taskEntry.isDirectory()) continue;
        const taskDir = utils.joinPath(tasksDir, taskEntry.name);
        const filePath = utils.joinPath(taskDir, 'ui_messages.json');
        const fileStat = await utils.statSafe(filePath);
        if (!fileStat || !fileStat.isFile) continue;
        files += 1;
        bytes += fileStat.size;
        cells.push(...(await scanTaskFile(ctx, { path: filePath, taskId: taskEntry.name, taskDir })));
      }
      const key = `${extension.family}\u0000${tasksDir}`;
      tasksSeen.set(key, { family: extension?.family || extensionId, tasksDir, files, bytes });
    }
  }

  for (const entry of tasksSeen.values()) {
    sources.push({
      label: `${entry.family} tasks`,
      path: entry.tasksDir,
      exists: true,
      files: entry.files,
      bytes: entry.bytes,
      note: 'ui_messages.json api_req_started token usage',
    });
  }

  // Cline's standalone CLI/desktop app keeps sessions in its own data directory.
  const clineSessions = utils.joinPath(env.home, '.cline', 'data', 'sessions');
  const clineStat = await utils.statSafe(clineSessions);
  if (clineStat && clineStat.isDirectory) {
    let files = 0;
    let bytes = 0;
    for (const sessionEntry of await utils.readdirSafe(clineSessions)) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = utils.joinPath(clineSessions, sessionEntry.name);
      for (const fileEntry of await utils.readdirSafe(sessionDir)) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.messages.json')) continue;
        const filePath = utils.joinPath(sessionDir, fileEntry.name);
        const fileStat = await utils.statSafe(filePath);
        if (!fileStat || !fileStat.isFile) continue;
        files += 1;
        bytes += fileStat.size;
        cells.push(...(await scanClineSessionFile(ctx, filePath)));
      }
    }
    sources.push({
      label: 'Cline CLI sessions',
      path: clineSessions,
      exists: true,
      files,
      bytes,
      note: '<session>.messages.json assistant metrics inputTokens/outputTokens/cache tokens',
    });
  } else {
    sources.push({ label: 'Cline CLI sessions', path: clineSessions, exists: false, files: 0, bytes: 0 });
  }

  if (sources.every((source) => !source.exists)) {
    // Neither the extensions nor the standalone CLI are installed.
    sources.push({
      label: 'Cline family extension storage',
      path: utils.joinPath(env.appData, 'Code', 'User', 'globalStorage'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'no saoudrizwan.claude-dev / rooveterinaryinc.roo-cline / kilocode.kilo-code globalStorage found',
    });
    return { sources, cells: mergeProviderCells(cells) };
  }
  if (cells.length === 0) {
    ctx.warn('Cline family: extension storage found but no readable task token usage');
  } else if (!foundAnyExtension) {
    // Only the standalone Cline CLI contributed; nothing to warn about.
  }
  return { sources, cells: mergeProviderCells(cells) };
}
