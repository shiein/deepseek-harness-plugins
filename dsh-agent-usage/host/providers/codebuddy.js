/**
 * CodeBuddy (Tencent) usage provider.
 *
 * Two storage generations exist:
 *
 * 1. CodeBuddy CLI (a Claude-Code fork) writes workspace-scoped JSONL transcripts:
 *      ~/.codebuddy/projects/<encoded-cwd>/<sessionId>.jsonl
 *    Record types: message, reasoning, topic, file-history-snapshot. Only
 *    `type == "message" && role == "assistant"` records carry usage:
 *      providerData.rawUsage = {
 *        prompt_tokens, completion_tokens,
 *        prompt_tokens_details: { cached_tokens, reasoning_tokens },
 *        cache_read_input_tokens, cache_creation_input_tokens,   // Anthropic mirrors (usually 0)
 *      }
 *    prompt_tokens includes cached tokens, so uncached input = prompt - cached.
 *    `~/.codebuddy/settings.json` may name a default model.
 *
 * 2. The CodeBuddy / CodeBuddy CN VS Code-derived IDE keeps only UI state and file-change
 *    snapshots under `<app>/User/globalStorage` (verified on this machine: `state.vscdb`
 *    holds model catalog / theme / auth-cache keys, no token counters). Its agent usage is
 *    reported to Tencent's service, so the IDE path is detected but not locally readable.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  color: '#06b6d4',
  homepage: 'https://www.codebuddy.cn',
  cacheVersion: 1,
};

const IDE_APPS = ['CodeBuddy', 'CodeBuddy CN', 'CodeBuddyExtension'];

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {number|null} */
function coerceEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 100_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return coerceEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** @param {Record<string, any>} raw @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|null} */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const promptDetails =
    raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details : {};
  const prompt = toCount(
    raw.prompt_tokens ?? raw.promptTokens ?? raw.input_tokens ?? raw.inputTokens ?? 0,
  );
  const completion = toCount(
    raw.completion_tokens ?? raw.completionTokens ?? raw.output_tokens ?? raw.outputTokens ?? 0,
  );
  const cacheRead = Math.max(
    toCount(promptDetails.cached_tokens),
    toCount(raw.cache_read_input_tokens),
    toCount(raw.prompt_cache_hit_tokens),
    toCount(raw.cached_input_tokens),
  );
  const cacheWrite = Math.max(
    toCount(raw.cache_creation_input_tokens),
    toCount(raw.cache_creation_tokens),
  );
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  if (input + completion + cacheRead + cacheWrite <= 0) return null;
  return { input, output: completion, cacheRead, cacheWrite };
}

/** @param {any} utils @param {string} home @returns {Promise<string|null>} */
async function readDefaultModel(utils, home) {
  const raw = await utils.readText(utils.joinPath(home, 'settings.json'));
  if (!raw) return null;
  const parsed = utils.safeJsonParse(raw);
  const model = parsed && typeof parsed === 'object' ? parsed.model : null;
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : null;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fallbackModel
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanJsonl(ctx, filePath, fallbackModel) {
  const { utils, cache } = ctx;
  const stat = await utils.statSafe(filePath);
  if (!stat || !stat.isFile) return [];
  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const cached = cache.get(filePath, fingerprint);
  if (cached) return cached;

  /** @type {Map<string, import('../scanner-types.js').Cell>} */
  const byKey = new Map();
  const seen = new Set();
  await utils.readJsonl(
    filePath,
    (line) => {
      const record = utils.safeJsonParse(line);
      if (!record || typeof record !== 'object') return;
      const provider =
        record.providerData && typeof record.providerData === 'object' ? record.providerData : null;
      const raw = provider?.rawUsage ?? provider?.usage ?? record.usage ?? null;
      const usage = normalizeUsage(raw);
      if (!usage) return;
      const timestamp = coerceEpochMs(record.timestamp) ?? coerceEpochMs(record.ts);
      if (!timestamp) return;
      const id =
        (typeof provider?.messageId === 'string' && provider.messageId) ||
        (typeof record.uuid === 'string' && record.uuid) ||
        (typeof record.id === 'string' && record.id) ||
        `${utils.basenameOf(filePath)}:${timestamp}`;
      if (seen.has(id)) return;
      seen.add(id);
      const model =
        (typeof provider?.model === 'string' && provider.model.trim()) ||
        (typeof provider?.requestModelId === 'string' && provider.requestModelId.trim()) ||
        (typeof record.model === 'string' && record.model.trim()) ||
        fallbackModel;
      const day = utils.localDay(timestamp);
      const key = `${model}\u0000${day}`;
      let cell = byKey.get(key);
      if (!cell) {
        cell = {
          model,
          day,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          messages: 0,
          firstTs: timestamp,
          lastTs: timestamp,
        };
        byKey.set(key, cell);
      }
      cell.input += usage.input;
      cell.output += usage.output;
      cell.cacheRead += usage.cacheRead;
      cell.cacheWrite += usage.cacheWrite;
      cell.messages += 1;
      if (timestamp < cell.firstTs) cell.firstTs = timestamp;
      if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    },
    { signal: ctx.signal },
  );
  const cells = [...byKey.values()];
  cache.set(filePath, fingerprint, cells);
  return cells;
}

/** @param {import('../scanner-types.js').ScanContext['env']} env @param {any} utils @returns {string[]} */
function ideRoots(env, utils) {
  /** @type {string[]} */
  const roots = [];
  for (const app of IDE_APPS) {
    if (env.platform === 'win32') roots.push(utils.joinPath(env.appData, app));
    else if (env.platform === 'darwin') roots.push(utils.joinPath(env.home, 'Library', 'Application Support', app));
    else roots.push(utils.joinPath(env.home, '.config', app));
  }
  return roots;
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

  const home = utils.joinPath(env.home, '.codebuddy');
  const homeStat = await utils.statSafe(home);
  const projectsDir = utils.joinPath(home, 'projects');
  const fallbackModel = (homeStat ? await readDefaultModel(utils, home) : null) || 'codebuddy-unknown';

  if (homeStat && homeStat.isDirectory) {
    const projectsStat = await utils.statSafe(projectsDir);
    const files =
      projectsStat && projectsStat.isDirectory
        ? await utils.listFilesRecursive(projectsDir, { exts: ['.jsonl'], signal: ctx.signal })
        : [];
    let bytes = 0;
    for (const file of files) {
      if (ctx.signal.aborted) break;
      bytes += file.size;
      cells.push(...(await scanJsonl(ctx, file.path, fallbackModel)));
    }
    sources.push({
      label: 'CodeBuddy transcripts',
      path: projectsDir,
      exists: Boolean(projectsStat && projectsStat.isDirectory),
      files: files.length,
      bytes,
      note: 'projects/<cwd>/<session>.jsonl; providerData.rawUsage per assistant message',
    });
  } else {
    sources.push({ label: 'CodeBuddy transcripts', path: projectsDir, exists: false, files: 0, bytes: 0 });
  }

  let ideFound = false;
  for (const root of ideRoots(env, utils)) {
    const stat = await utils.statSafe(root);
    if (!stat || !stat.isDirectory) continue;
    ideFound = true;
    const databasePath = utils.joinPath(root, 'User', 'globalStorage', 'state.vscdb');
    const databaseStat = await utils.statSafe(databasePath);
    sources.push({
      label: 'CodeBuddy IDE storage',
      path: root,
      exists: true,
      files: databaseStat ? 1 : 0,
      bytes: databaseStat ? databaseStat.size : 0,
      note: 'state.vscdb holds UI/model-cache keys only; IDE agent usage is reported remotely, not stored locally',
    });
  }

  if (cells.length === 0 && (ideFound || (homeStat && homeStat.isDirectory))) {
    ctx.warn(
      'CodeBuddy: installation found but no locally readable token usage (CLI transcripts absent; IDE usage is remote-only)',
    );
  }
  return { sources, cells: mergeProviderCells(cells) };
}
