/**
 * Scan orchestration: load every provider, run it, merge cells, estimate cost, persist the
 * snapshot and the fingerprint cache.
 *
 * A scan is expensive by design (it walks local session data), so it is only invoked by the
 * explicit Refresh action / the `scan` route. Nothing here runs on activation or on a timer.
 */

import { dirname, join } from 'node:path';
import { mergeCells, finalizeCells, cellTokens } from './cells.js';
import { estimateCellCost, hasPrice, PRICING_VERSION } from './pricing.js';
import { ScanCache } from './scan-cache.js';
import { loadProviders } from './providers/index.js';
import { makeScanContext } from './context.js';
import { mkdirSafe } from './fs-extra.js';
import fs from 'node:fs/promises';

const SNAPSHOT_FORMAT = 1;
const SCAN_CONCURRENCY = 3;

/**
 * @typedef {Object} Snapshot
 * @property {number} format
 * @property {number} scannedAt        Epoch ms of the scan.
 * @property {number} durationMs
 * @property {number} pricingVersion
 * @property {string} platform
 * @property {AgentSnapshot[]} agents
 * @property {CellTuple[]} cells       Compact [agent, model, day, input, output, cacheRead, cacheWrite, costUsd, messages, tier]
 * @property {number} totalTokens
 * @property {number} totalCostUsd
 * @property {number} totalMessages
 * @property {string[]} unpricedModels
 */

/**
 * @typedef {Object} AgentSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} [homepage]
 * @property {'ok'|'empty'|'not-installed'|'error'|'broken'} status
 * @property {number} cells
 * @property {number} tokens
 * @property {number} costUsd
 * @property {number} durationMs
 * @property {number} files
 * @property {number} bytes
 * @property {SourceInfo[]} sources
 * @property {string[]} warnings
 * @property {string} [error]
 */

/**
 * @typedef {Object} SourceInfo
 * @property {string} label
 * @property {string} path
 * @property {boolean} exists
 * @property {number} files
 * @property {number} bytes
 * @property {string} [note]
 */

/**
 * @typedef {[string, string, string, number, number, number, number, number, number, string]} CellTuple
 *   [agentId, model, day, input, output, cacheRead, cacheWrite, costUsd, messages, tier]
 */

/**
 * Run one full scan.
 * @param {{dataDir: string, config?: Record<string, unknown>, signal?: AbortSignal,
 *          onProgress?: (message: string) => void}} options
 * @returns {Promise<Snapshot>}
 */
export async function runScan(options) {
  const startedAt = Date.now();
  const dataDir = options.dataDir;
  const config = options.config || {};
  const signal = options.signal || new AbortController().signal;
  await mkdirSafe(dataDir);

  const providers = await loadProviders();
  /** @type {Record<string, number>} */
  const providerVersions = {};
  for (const provider of providers) {
    if (provider.meta?.id) providerVersions[provider.meta.id] = provider.meta.cacheVersion ?? 1;
  }
  const cache = new ScanCache({ filePath: join(dataDir, 'scan-cache.json'), providerVersions });
  await cache.load();

  /** @type {CellTuple[]} */
  const tuples = [];
  /** @type {AgentSnapshot[]} */
  const agents = [];
  /** @type {Set<string>} */
  const unpriced = new Set();
  const activeProviderIds = [];

  const results = await runWithConcurrency(providers, SCAN_CONCURRENCY, async (provider) => {
    const providerId = provider.meta?.id || 'unknown';
    activeProviderIds.push(providerId);
    const agentStarted = Date.now();
    /** @type {string[]} */
    const warnings = [];
    /** @type {import('./scanner-types.js').Cell[]} */
    let providerCells = [];
    /** @type {SourceInfo[]} */
    let sources = [];
    let errorMessage;
    let status = 'ok';

    if (provider.error || typeof provider.scan !== 'function') {
      status = 'broken';
      errorMessage = String(provider.error?.message || provider.error || 'provider module failed to load');
    } else {
      try {
        const warned = [];
        const context = makeScanContext({
          providerId,
          config,
          signal,
          warnings: warned,
          cache: {
            get: (filePath, fingerprint) => cache.get(providerId, filePath, fingerprint),
            set: (filePath, fingerprint, cells) => cache.set(providerId, filePath, fingerprint, cells),
          },
        });
        const result = await provider.scan(context);
        providerCells = Array.isArray(result?.cells) ? result.cells : [];
        sources = Array.isArray(result?.sources) ? result.sources.filter(Boolean) : [];
        warnings.push(...warned);
        if (result?.warnings) warnings.push(...result.warnings);
      } catch (error) {
        status = 'error';
        errorMessage = error?.stack ? String(error.stack).split('\n')[0] : String(error);
        warnings.push(errorMessage);
      }
    }

    const merged = finalizeCells(mergeCells(providerCells));
    let tokens = 0;
    let cost = 0;
    for (const cell of merged) {
      const cellCost = estimateCellCost(cell);
      if (cellCost === null && !hasPrice(cell.model)) unpriced.add(cell.model);
      const normalizedCost = cellCost ?? 0;
      tokens += cellTokens(cell);
      cost += normalizedCost;
      tuples.push([
        providerId,
        cell.model || 'unknown',
        cell.day,
        cell.input || 0,
        cell.output || 0,
        cell.cacheRead || 0,
        cell.cacheWrite || 0,
        round4(normalizedCost),
        cell.messages || 0,
        cell.tier || '',
      ]);
    }

    const exists = sources.some((source) => source.exists);
    if (status === 'ok') {
      if (merged.length > 0) status = 'ok';
      else if (exists) status = 'empty';
      else status = errorMessage ? 'error' : 'not-installed';
    }
    const files = sources.reduce((sum, source) => sum + (Number(source.files) || 0), 0);
    const bytes = sources.reduce((sum, source) => sum + (Number(source.bytes) || 0), 0);

    agents.push({
      id: providerId,
      name: provider.meta?.name || providerId,
      color: provider.meta?.color || '#8a8a8a',
      homepage: provider.meta?.homepage,
      status,
      cells: merged.length,
      tokens,
      costUsd: round4(cost),
      durationMs: Date.now() - agentStarted,
      files,
      bytes,
      sources,
      warnings: [...new Set(warnings)].slice(0, 20),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  });

  // Keep the cache bounded to providers that are actually installed.
  const installedIds = agents
    .filter((agent) => agent.status !== 'not-installed' && agent.status !== 'broken')
    .map((agent) => agent.id);
  cache.prune(installedIds);
  await cache.save();

  const totalTokens = tuples.reduce((sum, tuple) => sum + tuple[3] + tuple[4] + tuple[5] + tuple[6], 0);
  const totalCostUsd = round4(tuples.reduce((sum, tuple) => sum + tuple[7], 0));
  const totalMessages = tuples.reduce((sum, tuple) => sum + tuple[8], 0);

  agents.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  /** @type {Snapshot} */
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    pricingVersion: PRICING_VERSION,
    platform: process.platform,
    agents,
    cells: tuples,
    totalTokens,
    totalCostUsd,
    totalMessages,
    unpricedModels: [...unpriced].sort().slice(0, 40),
  };
  await writeSnapshot(dataDir, snapshot);
  return snapshot;
}

/**
 * Read the last persisted snapshot (no scanning).
 * @param {string} dataDir
 * @returns {Promise<Snapshot|null>}
 */
export async function loadSnapshot(dataDir) {
  try {
    const raw = await fs.readFile(join(dataDir, 'last-scan.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.format !== SNAPSHOT_FORMAT || !Array.isArray(parsed.cells) || !Array.isArray(parsed.agents)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} dataDir
 * @param {Snapshot} snapshot
 */
async function writeSnapshot(dataDir, snapshot) {
  try {
    await mkdirSafe(dirname(join(dataDir, 'last-scan.json')));
    const target = join(dataDir, 'last-scan.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot), 'utf8');
    await fs.rename(temporary, target);
  } catch {
    // Persisting is best effort; an in-memory snapshot still serves the UI.
  }
}

/**
 * Run `task` over `items` with a fixed concurrency.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
async function runWithConcurrency(items, limit, task) {
  /** @type {R[]} */
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await task(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** @param {number} value */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}
