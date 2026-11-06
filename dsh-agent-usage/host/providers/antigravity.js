/**
 * Google Antigravity usage provider.
 *
 * Antigravity (desktop / IDE / `agy` CLI) keeps one SQLite database per conversation at
 *   <root>/conversations/<conversation-id>.db
 * where <root> is `~/.gemini/antigravity`, `~/.gemini/antigravity-cli`,
 * `~/.gemini/antigravity-ide`, `~/.gemini/antigravity-backup`, `~/.gemini/antigravity-acp`,
 * or `~/.config/antigravity` on every platform. `ANTIGRAVITY_DATA_DIR` (comma-separated; a data
 * root or a conversations directory) overrides/adds roots. Token usage is NOT in a JSON column:
 * every row of the `gen_metadata`
 * table holds a custom Protobuf message (`data` BLOB). This module decodes the fields that
 * native-binary descriptors and independent implementations agree on:
 *
 *   gen_metadata.data          GenMetadata
 *     field 1  <- ChatModel
 *       field 4  <- ModelUsageStats (exa.codeium_common_pb.ModelUsageStats)
 *         field  1  model enum (not tokens)
 *         field  2  input_tokens            (uncached)
 *         field  3  output_tokens           (= field 9 + field 10)
 *         field  4  cache_write_tokens
 *         field  5  cache_read_tokens
 *         field  9  thinking_output_tokens
 *         field 10  response_output_tokens
 *         field 11  response id (dedup key)
 *       field 19  model config id (canonical; e.g. "gemini-3.8-flash-exp-a")
 *       field 21  display model name (compatibility fallback)
 *     field 2  packed varints: the step indices produced by this generation
 *     field 4  generation uuid
 *
 * Each `gen_metadata` row is one model call, so usage is summed across every row of every
 * conversation database (verified against this machine: 26,811 generations, 136 DBs).
 * Timestamps: the generation's first step row (`steps.metadata` field 1 -> Timestamp
 * {seconds, nanos}); when a generation has no step row the database file mtime is used so
 * the tokens still land on a day.
 *
 * The format is private and undocumented; all decoding degrades to "skip row" on a
 * malformed blob rather than fabricating numbers.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'antigravity',
  name: 'Antigravity',
  color: '#4285f4',
  homepage: 'https://antigravity.google',
  cacheVersion: 3, // 3: stable fingerprint (ignore -shm mtime, which our own read updates)
};

const APP_SUBDIRS = [
  'antigravity',
  'antigravity-cli',
  'antigravity-ide',
  'antigravity-backup',
  'antigravity-acp',
];

// ── Minimal protobuf wire reader ────────────────────────────────────────────────────────────

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @returns {[number, number]} value, next offset
 */
function readVarint(buffer, start) {
  let result = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) return [result, offset];
    shift += 7;
    if (shift > 56) return [result, offset];
  }
  return [result, offset];
}

/**
 * Decode one protobuf message into field number -> [{wire, value}] (value is a number for
 * varints and a Buffer slice for length-delimited/fixed fields).
 * @param {Buffer} buffer
 * @returns {Map<number, Array<{wire: number, value: number|Buffer}>>}
 */
function readFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    let tag;
    [tag, offset] = readVarint(buffer, offset);
    if (!tag) break;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    let value;
    if (wire === 0) {
      [value, offset] = readVarint(buffer, offset);
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) break;
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buffer, offset);
      if (length === null || offset + length > buffer.length) break;
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) break;
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      // Groups and reserved wire types are not used by these messages: stop cleanly.
      break;
    }
    const list = fields.get(field);
    if (list) list.push({ wire, value });
    else fields.set(field, [{ wire, value }]);
  }
  return fields;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {number} */
function varintField(fields, number) {
  const list = fields.get(number);
  if (!list) return 0;
  for (const item of list) if (item.wire === 0) return Number(item.value) || 0;
  return 0;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {Buffer|null} */
function bytesField(fields, number) {
  const list = fields.get(number);
  if (!list) return null;
  for (const item of list) if (item.wire === 2) return /** @type {Buffer} */ (item.value);
  return null;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {string|null} */
function stringField(fields, number) {
  const value = bytesField(fields, number);
  if (!value) return null;
  const text = value.toString('utf8').replace(/\u0000+$/g, '').trim();
  return text === '' ? null : text;
}

/** @param {ReturnType<typeof readFields>} fields @param {number} number @returns {number[]} */
function packedVarints(fields, number) {
  const value = bytesField(fields, number);
  if (!value) return [];
  const out = [];
  let offset = 0;
  while (offset < value.length) {
    let item;
    [item, offset] = readVarint(value, offset);
    if (!item) break;
    out.push(item);
  }
  return out;
}

// ── Antigravity message decoding ───────────────────────────────────────────────────────────

/**
 * Parse one `gen_metadata.data` blob.
 * @param {Buffer} data
 * @returns {{canonicalModel: string|null, displayModel: string|null, input: number,
 *            output: number, cacheRead: number, cacheWrite: number,
 *            responseId: string|null, stepIndices: number[]}|null}
 */
function parseGeneration(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) return null;
  const top = readFields(data);
  const chatModelBytes = bytesField(top, 1);
  if (!chatModelBytes) return null;
  const chatModel = readFields(chatModelBytes);
  const statsBytes = bytesField(chatModel, 4);
  if (!statsBytes) return null;
  const stats = readFields(statsBytes);

  const input = varintField(stats, 2);
  const outputTotal = varintField(stats, 3);
  const cacheWrite = varintField(stats, 4);
  const cacheRead = varintField(stats, 5);
  const thinking = varintField(stats, 9);
  const response = varintField(stats, 10);
  // Field 3 is the total output (thinking + response); reconstruct it only when the total is
  // omitted, which is what the native descriptor does (proto3 drops zero values).
  const output = Math.max(outputTotal, thinking + response);

  // Field 19 is the canonical model config id; field 21 is a display name that some builds
  // write instead (standalone app). Both are resolved together against the DB's canonical ids.
  const canonicalModel = stringField(chatModel, 19);
  const displayModel = stringField(chatModel, 21);
  const responseId = stringField(stats, 11);
  return {
    canonicalModel,
    displayModel,
    input,
    output,
    cacheRead,
    cacheWrite,
    responseId,
    stepIndices: packedVarints(top, 2),
  };
}

/**
 * Parse the Timestamp message nested in `steps.metadata` (field 1 -> {seconds, nanos}).
 * @param {Buffer} metadata
 * @returns {number|null} epoch ms
 */
function parseStepTimestamp(metadata) {
  if (!Buffer.isBuffer(metadata) || metadata.length === 0) return null;
  const outer = readFields(metadata);
  const timestampBytes = bytesField(outer, 1);
  if (!timestampBytes) return null;
  const timestamp = readFields(timestampBytes);
  const seconds = varintField(timestamp, 1);
  if (seconds <= 0) return null;
  const nanos = varintField(timestamp, 2);
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

/**
 * Identity key used to match a display name against the canonical ids in the same database:
 * lower-case alphanumerics only ("Claude Opus 4.6 (Thinking)" == "claude-opus-4-6-thinking").
 * @param {string|null|undefined} value
 * @returns {string}
 */
function modelIdentityKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Remove an effort/thinking qualifier so "Gemini 3.7 Flash (High)" can match the canonical
 * base id "gemini-3.7-flash" when the database contains that id.
 * @param {string} value
 * @returns {string}
 */
function withoutEffort(value) {
  return String(value || '')
    .replace(/\b(high|low|medium|thinking|none|minimal|max|xhigh|fast)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort display name -> model id when no canonical id was ever recorded:
 * "Gemini 3.1 Pro (Low)" -> "gemini-3.1-pro-low", "Claude Opus 4.6 (Thinking)" ->
 * "claude-opus-4-6-thinking" (Claude ids use dashed version numbers in the price table).
 * @param {string} value
 * @returns {string}
 */
function displayNameToModelId(value) {
  let text = String(value || '').trim().toLowerCase();
  if (text === '') return 'unknown';
  text = text.replace(/\(([^)]*)\)/g, ' $1 '); // "(low)" -> " low "
  text = text.replace(/[^a-z0-9.]+/g, '-');
  text = text.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (text.startsWith('claude')) text = text.replace(/\./g, '-');
  return text === '' ? 'unknown' : text;
}

/**
 * Resolve one generation's model id. A canonical field always wins. A display-only record is
 * matched (case/punctuation-insensitively, then with the effort suffix removed) against the
 * canonical ids observed in the same conversation database so both forms collapse to one model.
 * @param {{canonicalModel: string|null, displayModel: string|null}} generation
 * @param {Map<string, string>} canonicalIds
 * @returns {string}
 */
function resolveModelId(generation, canonicalIds) {
  if (generation.canonicalModel) return generation.canonicalModel;
  const display = generation.displayModel;
  if (!display) return 'unknown';
  const direct = canonicalIds.get(modelIdentityKey(display));
  if (direct) return direct;
  const stripped = canonicalIds.get(modelIdentityKey(withoutEffort(display)));
  if (stripped) return stripped;
  return displayNameToModelId(display);
}

/**
 * Fingerprint one SQLite database including its WAL sidecars: a live WAL changes the file's
 * logical content while the main file mtime stays put.
 *
 * The `-shm` shared-memory file is deliberately reduced to its size: opening the database
 * read-only updates its mtime on this platform, so including the mtime would miss the cache on
 * every scan and reparse all conversation databases. `-wal` keeps size+mtime because that is
 * where uncheckpointed writes land.
 * @param {import('../scanner-types.js').ScanContext['utils']} utils
 * @param {string} path
 * @returns {Promise<string>}
 */
async function sqliteFingerprint(utils, path) {
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = await utils.statSafe(`${path}${suffix}`);
    if (stat && stat.isFile) {
      parts.push(suffix === '-shm' ? `${stat.size}:-` : `${stat.size}:${Math.round(stat.mtimeMs)}`);
    } else if (suffix === '') {
      return '';
    } else {
      parts.push('-');
    }
  }
  return parts.join('|');
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 * @returns {Promise<import('../scanner-types.js').Cell[]>}
 */
async function scanDatabase(ctx, path) {
  const { utils, cache } = ctx;
  const fingerprint = await sqliteFingerprint(utils, path);
  if (fingerprint === '') return [];
  const cached = cache.get(path, fingerprint);
  if (cached) return cached;

  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];
  const stat = await utils.statSafe(path);
  if (!stat || !stat.isFile) return cells;

  let db = null;
  try {
    db = await utils.openSqliteDatabase(path, { readOnly: true });
    /** @type {Map<number, number>} */
    const stepTimestamps = new Map();
    for (const row of utils.querySqlite(db, 'SELECT idx, metadata FROM steps')) {
      const timestamp = parseStepTimestamp(row?.metadata ? Buffer.from(row.metadata) : null);
      if (timestamp) stepTimestamps.set(Number(row.idx), timestamp);
    }

    // First pass: decode every generation and collect the canonical model ids of this
    // conversation so display-only rows can be folded onto them (same model, one identity).
    /** @type {Map<string, string>} */
    const canonicalIds = new Map();
    /** @type {ReturnType<typeof parseGeneration>[]} */
    const generations = [];
    for (const row of utils.querySqlite(db, 'SELECT idx, data FROM gen_metadata ORDER BY idx')) {
      if (ctx.signal.aborted) break;
      const generation = parseGeneration(row?.data ? Buffer.from(row.data) : null);
      if (!generation) continue;
      generations.push(generation);
      if (generation.canonicalModel) {
        const identity = modelIdentityKey(generation.canonicalModel);
        if (identity && !canonicalIds.has(identity)) canonicalIds.set(identity, generation.canonicalModel);
      }
    }

    /** @type {Map<string, import('../scanner-types.js').Cell>} */
    const byKey = new Map();
    const seenResponses = new Set();
    for (const generation of generations) {
      if (ctx.signal.aborted) break;
      if (generation.responseId) {
        if (seenResponses.has(generation.responseId)) continue;
        seenResponses.add(generation.responseId);
      }
      // Prune metadata-only generations: some rows record a model call but no token counters.
      // They would otherwise produce empty cells (model 'unknown' / display names) with
      // messages > 0 and no usage.
      if (generation.input + generation.output + generation.cacheRead + generation.cacheWrite <= 0) {
        continue;
      }
      const model = resolveModelId(generation, canonicalIds);
      let timestamp = 0;
      for (const index of generation.stepIndices) {
        const candidate = stepTimestamps.get(Number(index));
        if (candidate) {
          timestamp = candidate;
          break;
        }
      }
      if (!timestamp) timestamp = stat.mtimeMs;
      const day = utils.localDay(timestamp);
      if (!day) continue;
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
      cell.input += generation.input;
      cell.output += generation.output;
      cell.cacheRead += generation.cacheRead;
      cell.cacheWrite += generation.cacheWrite;
      cell.messages += 1;
      if (timestamp < cell.firstTs) cell.firstTs = timestamp;
      if (timestamp > cell.lastTs) cell.lastTs = timestamp;
    }
    // Defensive: never hand the framework a bucket that carries no token counters.
    cells.push(
      ...[...byKey.values()].filter(
        (cell) => cell.input + cell.output + cell.cacheRead + cell.cacheWrite > 0,
      ),
    );
  } catch {
    // A malformed/locked conversation database must not fail the whole scan.
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  // Only cache a successful read; a transient lock should be retried next refresh.
  cache.set(path, fingerprint, cells);
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

  /** @type {string[]} */
  const roots = [];
  const configured = [
    typeof process.env.ANTIGRAVITY_DATA_DIR === 'string' ? process.env.ANTIGRAVITY_DATA_DIR : '',
    typeof env.config?.antigravityDataDir === 'string' ? env.config.antigravityDataDir : '',
  ]
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of configured) {
    const expanded = utils.expandPath(value);
    roots.push(/[\\/]conversations$/.test(expanded) ? expanded : utils.joinPath(expanded, 'conversations'));
  }
  for (const app of APP_SUBDIRS) roots.push(utils.joinPath(env.home, '.gemini', app, 'conversations'));
  roots.push(utils.joinPath(env.home, '.config', 'antigravity', 'conversations'));
  const uniqueRoots = [...new Set(roots)];
  /** @type {Map<string, {path: string, size: number}>} */
  const databases = new Map();
  let anyRoot = false;

  for (const root of uniqueRoots) {
    const stat = await utils.statSafe(root);
    if (!stat || !stat.isDirectory) {
      sources.push({ label: 'Antigravity conversations', path: root, exists: false, files: 0, bytes: 0 });
      continue;
    }
    anyRoot = true;
    let files = 0;
    let bytes = 0;
    for (const entry of await utils.readdirSafe(root)) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      // The same conversation UUID can be mirrored across antigravity / antigravity-ide /
      // antigravity-cli roots: read each conversation once.
      if (databases.has(entry.name)) continue;
      const fileStat = await utils.statSafe(utils.joinPath(root, entry.name));
      if (!fileStat || !fileStat.isFile) continue;
      databases.set(entry.name, { path: utils.joinPath(root, entry.name), size: fileStat.size });
      files += 1;
      bytes += fileStat.size;
    }
    sources.push({
      label: 'Antigravity conversations',
      path: root,
      exists: true,
      files,
      bytes,
      note: 'SQLite conversation DBs; Protobuf gen_metadata token usage',
    });
  }

  if (!anyRoot) {
    return { sources, cells: mergeProviderCells(cells) };
  }

  for (const database of databases.values()) {
    if (ctx.signal.aborted) break;
    cells.push(...(await scanDatabase(ctx, database.path)));
  }
  if (cells.length === 0) {
    ctx.warn('Antigravity: conversation databases were found but no readable gen_metadata usage was present');
  }
  return { sources, cells: mergeProviderCells(cells) };
}
