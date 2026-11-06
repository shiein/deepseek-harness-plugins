/**
 * Cell construction and merging helpers shared by providers, the scanner and the self-test.
 */

/**
 * Add one usage observation to a model+day bucket map.
 * @param {Map<string, import('./scanner-types.js').Cell>} map
 * @param {{model?: string, day?: string, ts?: number, input?: number, output?: number,
 *          cacheRead?: number, cacheWrite?: number, reasoning?: number, costUsd?: number|null,
 *          messages?: number, tier?: string|null}} usage
 * @returns {import('./scanner-types.js').Cell}
 */
export function addUsage(map, usage) {
  const model = String(usage.model || 'unknown');
  const day = String(usage.day || '');
  const tier = usage.tier ? String(usage.tier) : '';
  const key = `${model}\u0000${day}\u0000${tier}`;
  let cell = map.get(key);
  if (!cell) {
    cell = {
      model,
      day,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      messages: 0,
    };
    if (tier) cell.tier = tier;
    map.set(key, cell);
  }
  cell.input += toCount(usage.input);
  cell.output += toCount(usage.output);
  cell.cacheRead += toCount(usage.cacheRead);
  cell.cacheWrite += toCount(usage.cacheWrite);
  if (usage.reasoning) cell.reasoning = (cell.reasoning || 0) + toCount(usage.reasoning);
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    cell.costUsd = (cell.costUsd || 0) + usage.costUsd;
  }
  cell.messages += usage.messages === undefined ? 1 : toCount(usage.messages);
  if (typeof usage.ts === 'number' && Number.isFinite(usage.ts) && usage.ts > 0) {
    if (cell.firstTs === undefined || usage.ts < cell.firstTs) cell.firstTs = usage.ts;
    if (cell.lastTs === undefined || usage.ts > cell.lastTs) cell.lastTs = usage.ts;
  }
  return cell;
}

/** @param {unknown} value @returns {number} */
export function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

/**
 * Merge a list of cells that may share (model, day, tier), summing every counter.
 * @param {import('./scanner-types.js').Cell[]} cells
 * @returns {import('./scanner-types.js').Cell[]}
 */
export function mergeCells(cells) {
  /** @type {Map<string, import('./scanner-types.js').Cell>} */
  const map = new Map();
  for (const cell of cells) {
    if (!cell) continue;
    const tier = cell.tier ? String(cell.tier) : '';
    const key = `${cell.model}\u0000${cell.day}\u0000${tier}`;
    let target = map.get(key);
    if (!target) {
      target = {
        model: cell.model || 'unknown',
        day: cell.day,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
      };
      if (tier) target.tier = tier;
      map.set(key, target);
    }
    target.input += toCount(cell.input);
    target.output += toCount(cell.output);
    target.cacheRead += toCount(cell.cacheRead);
    target.cacheWrite += toCount(cell.cacheWrite);
    if (cell.reasoning) target.reasoning = (target.reasoning || 0) + toCount(cell.reasoning);
    if (typeof cell.costUsd === 'number' && Number.isFinite(cell.costUsd)) {
      target.costUsd = (target.costUsd || 0) + cell.costUsd;
    }
    target.messages += toCount(cell.messages);
    if (typeof cell.firstTs === 'number') {
      if (target.firstTs === undefined || cell.firstTs < target.firstTs) target.firstTs = cell.firstTs;
    }
    if (typeof cell.lastTs === 'number') {
      if (target.lastTs === undefined || cell.lastTs > target.lastTs) target.lastTs = cell.lastTs;
    }
  }
  return [...map.values()];
}

/**
 * Drop buckets that carry no information (no tokens, no messages).
 * @param {import('./scanner-types.js').Cell[]} cells
 * @returns {import('./scanner-types.js').Cell[]}
 */
export function finalizeCells(cells) {
  return cells.filter((cell) => {
    if (!cell || !cell.day) return false;
    const tokens = toCount(cell.input) + toCount(cell.output) + toCount(cell.cacheRead) + toCount(cell.cacheWrite);
    return tokens > 0 || toCount(cell.messages) > 0;
  });
}

/**
 * Convenience: the total token count of a cell (input+output+cache).
 * @param {import('./scanner-types.js').Cell} cell
 */
export function cellTokens(cell) {
  return toCount(cell.input) + toCount(cell.output) + toCount(cell.cacheRead) + toCount(cell.cacheWrite);
}
