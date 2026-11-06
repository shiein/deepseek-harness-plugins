/**
 * WorkBuddy (Tencent) usage provider.
 *
 * WorkBuddy is a Claude-Code-family CLI/desktop agent that writes workspace-scoped JSONL
 * transcripts under its own home directory:
 *   ~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl
 *   ~/.workbuddy/projects/<cwd-slug>/<sessionId>/subagents/agent-*.jsonl   (sub-agents)
 *
 * Every LLM round-trip (assistant message OR function_call record) carries
 *   providerData.rawUsage = {
 *     prompt_tokens, completion_tokens,            // OpenAI/DeepSeek shaped, prompt is FULL
 *     prompt_tokens_details: { cached_tokens, reasoning_tokens },
 *     cache_read_input_tokens, cache_creation_input_tokens,   // Anthropic-shaped mirrors
 *     prompt_cache_hit_tokens,
 *   }
 * Older/newer builds may instead expose camelCase `inputTokens`/`outputTokens` fields.
 * prompt_tokens includes cache reads and cache writes, so uncached input is
 * prompt - cacheRead - cacheWrite. completion_tokens includes reasoning.
 * `providerData.messageId` identifies one round-trip; dedup per record id.
 *
 * A completed trace summary at `~/.workbuddy/traces/<id>/trace_*.json` exposes
 * `trace.modelInfo.totalInputTokens/totalOutputTokens/totalCachedTokens` and is used only
 * when no JSONL transcript exists. The binary `workbuddy.db` is NOT read: it stores
 * context-window state and credit figures, not billable token columns.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  color: '#14b8a6',
  homepage: 'https://www.codebuddy.cn',
  cacheVersion: 1,
};

/** @param {unknown} value @returns {number} */
function toCount(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/** @param {unknown} value @returns {number|null} epoch ms */
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
    toCount(raw.cache_read_input_tokens),
    toCount(promptDetails.cached_tokens),
    toCount(raw.prompt_cache_hit_tokens),
    toCount(raw.cached_input_tokens),
    toCount(raw.cacheReadInputTokens),
  );
  const cacheWrite = Math.max(
    toCount(raw.cache_creation_input_tokens),
    toCount(raw.cacheCreationInputTokens),
    toCount(raw.cache_write_input_tokens),
  );
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  if (input + completion + cacheRead + cacheWrite <= 0) return null;
  return { input, output: completion, cacheRead, cacheWrite };
}

/** @param {string} path @returns {Promise<string>} */
async function fileFingerprint(utils, path) {
  const stat = await utils.statSafe(path);
  if (!stat || !stat.isFile) return '';
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/** @param {import('../scanner-types.js').ScanContext} ctx @param {string} label @param {string} path */
async function resolveHome(ctx, utils, env) {
  const config = env.config && typeof env.config === 'object' ? env.config : {};
  const configured = config.workbuddyHome || config.workbuddyDir;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return utils.expandPath(configured.trim());
  }
  if (typeof process.env.WORKBUDDY_HOME === 'string' && process.env.WORKBUDDY_HOME.trim() !== '') {
    return utils.expandPath(process.env.WORKBUDDY_HOME.trim());
  }
  return utils.joinPath(env.home, '.workbuddy');
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
  const fingerprint = await fileFingerprint(utils, filePath);
  if (fingerprint === '') return [];
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
      const provider = record.providerData && typeof record.providerData === 'object' ? record.providerData : null;
      const raw = provider?.rawUsage ?? provider?.usage ?? record.usage ?? null;
      const usage = normalizeUsage(raw);
      if (!usage) return;
      const timestamp =
        coerceEpochMs(record.timestamp) ?? coerceEpochMs(record.ts) ?? coerceEpochMs(record.createdAt);
      if (!timestamp) return;
      const sessionId =
        typeof record.sessionId === 'string' && record.sessionId
          ? record.sessionId
          : utils.basenameOf(filePath).replace(/\.jsonl$/i, '');
      const messageId =
        (typeof provider?.messageId === 'string' && provider.messageId) ||
        (typeof record.uuid === 'string' && record.uuid) ||
        (typeof record.id === 'string' && record.id) ||
        `${sessionId}:${timestamp}`;
      if (seen.has(messageId)) return;
      seen.add(messageId);
      const model =
        (typeof provider?.model === 'string' && provider.model.trim()) ||
        (typeof provider?.requestModelId === 'string' && provider.requestModelId.trim()) ||
        (typeof record.model === 'string' && record.model.trim()) ||
        fallbackModel;
      const day = ctx.utils.localDay(timestamp);
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

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @param {string} filePath
 * @param {string} fallbackModel
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanTrace(ctx, filePath, fallbackModel) {
  const { utils, cache } = ctx;
  const fingerprint = await fileFingerprint(utils, filePath);
  if (fingerprint === '') return [];
  const cached = cache.get(filePath, fingerprint);
  if (cached) return cached;
  const raw = await utils.readText(filePath);
  if (!raw) return [];
  const document = utils.safeJsonParse(raw);
  if (!document) return [];
  const trace = document.trace && typeof document.trace === 'object' ? document.trace : document;
  const metadata = trace.metadata && typeof trace.metadata === 'object' ? trace.metadata : {};
  const modelInfo =
    trace.modelInfo && typeof trace.modelInfo === 'object'
      ? trace.modelInfo
      : metadata.modelInfo && typeof metadata.modelInfo === 'object'
        ? metadata.modelInfo
        : null;
  if (!modelInfo) return [];
  const timestamp =
    coerceEpochMs(trace.startedAt) ?? coerceEpochMs(metadata.startedAt) ?? coerceEpochMs(trace.timestamp);
  if (!timestamp) return [];
  const input = toCount(modelInfo.totalInputTokens ?? modelInfo.inputTokens);
  const output = toCount(modelInfo.totalOutputTokens ?? modelInfo.outputTokens);
  const cacheRead = Math.min(input, toCount(modelInfo.totalCachedTokens ?? modelInfo.cachedTokens));
  if (input + output <= 0) return [];
  const model =
    (typeof modelInfo.model === 'string' && modelInfo.model.trim()) ||
    (typeof trace.model === 'string' && trace.model.trim()) ||
    fallbackModel;
  const day = utils.localDay(timestamp);
  const cells = [
    {
      model,
      day,
      input: Math.max(0, input - cacheRead),
      output,
      cacheRead,
      cacheWrite: 0,
      messages: 1,
      firstTs: timestamp,
      lastTs: timestamp,
    },
  ];
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

  const home = await resolveHome(ctx, utils, env);
  const homeStat = await utils.statSafe(home);
  const projectsDir = utils.joinPath(home, 'projects');
  const tracesDir = utils.joinPath(home, 'traces');

  if (!homeStat || !homeStat.isDirectory) {
    sources.push({ label: 'WorkBuddy transcripts', path: home, exists: false, files: 0, bytes: 0 });
    return { sources, cells: mergeProviderCells(cells) };
  }

  const fallbackModel = (await readDefaultModel(utils, home)) || 'auto';
  const projectsStat = await utils.statSafe(projectsDir);
  let files = [];
  if (projectsStat && projectsStat.isDirectory) {
    files = await utils.listFilesRecursive(projectsDir, { exts: ['.jsonl'], signal: ctx.signal });
  }

  let bytes = 0;
  for (const file of files) {
    if (ctx.signal.aborted) break;
    bytes += file.size;
    cells.push(...(await scanJsonl(ctx, file.path, fallbackModel)));
  }
  sources.push({
    label: 'WorkBuddy transcripts',
    path: projectsDir,
    exists: Boolean(projectsStat && projectsStat.isDirectory),
    files: files.length,
    bytes,
    note: 'projects/<cwd>/<session>.jsonl; providerData.rawUsage per model round-trip',
  });

  // Trace summaries are a lossy fallback for installations with no JSONL transcripts.
  if (files.length === 0) {
    const tracesStat = await utils.statSafe(tracesDir);
    if (tracesStat && tracesStat.isDirectory) {
      const traceFiles = await utils.listFilesRecursive(tracesDir, { exts: ['.json'], signal: ctx.signal });
      let traceBytes = 0;
      for (const file of traceFiles) {
        if (!/^trace_[^/\\]+\.json$/i.test(file.path)) continue;
        if (ctx.signal.aborted) break;
        traceBytes += file.size;
        cells.push(...(await scanTrace(ctx, file.path, fallbackModel)));
      }
      sources.push({
        label: 'WorkBuddy trace summaries',
        path: tracesDir,
        exists: true,
        files: traceFiles.length,
        bytes: traceBytes,
        note: 'aggregate modelInfo totals; JSONL transcripts take precedence',
      });
    }
  }

  const databasePath = utils.joinPath(home, 'workbuddy.db');
  if (await utils.exists(databasePath)) {
    sources.push({
      label: 'WorkBuddy session store',
      path: databasePath,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'workbuddy.db stores context-window state and credits, not billable token columns; ignored',
    });
  }

  if (cells.length === 0) {
    ctx.warn(
      'WorkBuddy: installation found but no per-round providerData usage (JSONL transcripts absent or empty)',
    );
  }
  return { sources, cells: mergeProviderCells(cells) };
}
