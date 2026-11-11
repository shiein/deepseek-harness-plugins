/**
 * Scan orchestration: load every provider, run it, merge cells, estimate cost, persist the
 * snapshot and the fingerprint cache.
 *
 * A scan is expensive by design (it walks local session data), so it is only invoked by the
 * explicit Refresh action / the `scan` route. Nothing here runs on activation or on a timer.
 */

import { dirname, join } from 'node:path';
import { mergeCells, finalizeCells, cellTokens } from './cells.js';
import { estimateCellCost, hasPrice, PRICES_FETCHED, PRICING_VERSION, pricingTable } from './pricing.js';
import { ScanCache } from './scan-cache.js';
import { loadProviders } from './providers/index.js';
import { makeScanContext } from './context.js';
import { runWithConcurrency } from './concurrency.js';
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
 * @property {CellTuple[]} cells       Compact [agent, model, day, input, output, cacheRead, cacheWrite, costUsd, messages, tier,
 *                                     project] — project is the session's folder, '' when the agent does not record it
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
 * @property {'ok'|'empty'|'not-installed'|'error'|'broken'|'stale'} status
 *   `stale`: the provider failed this scan, so the cells cached by its last successful scan are
 *   shown instead of dropping the agent; `error` in that case explains why.
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
  // Profile `prices` overrides apply to this scan's estimates (not to provider-reported costs).
  const pricing = pricingTable(config.prices);
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
    let queryFailures = [];
    /** Warnings the provider collected before it returned or threw. */
    const warned = [];

    if (provider.error || typeof provider.scan !== 'function') {
      status = 'broken';
      errorMessage = String(provider.error?.message || provider.error || 'provider module failed to load');
    } else {
      try {
        const context = makeScanContext({
          providerId,
          config,
          signal,
          warnings: warned,
          cache: {
            get: (filePath, fingerprint) => cache.get(providerId, filePath, fingerprint),
            set: (filePath, fingerprint, cells, state) => cache.set(providerId, filePath, fingerprint, cells, state),
            peek: (filePath) => cache.peek(providerId, filePath),
          },
        });
        queryFailures = context.queryFailures;
        const result = await provider.scan(context);
        providerCells = Array.isArray(result?.cells) ? result.cells : [];
        sources = Array.isArray(result?.sources) ? result.sources.filter(Boolean) : [];
        warnings.push(...warned);
        if (result?.warnings) warnings.push(...result.warnings);
      } catch (error) {
        status = 'error';
        errorMessage = error?.stack ? String(error.stack).split('\n')[0] : String(error);
        warnings.push(...warned);
        warnings.push(errorMessage);
        // A transient read failure — another app holding a lock, or briefly filling the disk while
        // it rewrites its own store — must not erase numbers the user already saw. Reuse the cells
        // cached by this provider's last successful scan and report them as stale; the error stays
        // visible in the source list.
        const cachedCells = cachedCellsOf(cache, providerId);
        if (cachedCells.length > 0) {
          providerCells = cachedCells;
          status = 'stale';
          const cachedFiles = cachedFilesOf(cache, providerId);
          sources = [{
            label: `${provider.meta?.name || providerId} (last successful scan)`,
            path: cachedFiles[0] || providerId,
            exists: true,
            files: cachedFiles.length,
            bytes: 0,
            note: 'the store could not be read this scan; these numbers are from the scan cache',
          }];
          warnings.push(`stale: showing the last successful scan (${errorMessage})`);
        }
      }
    }

    const merged = finalizeCells(mergeCells(providerCells));
    let tokens = 0;
    let cost = 0;
    for (const cell of merged) {
      const cellCost = estimateCellCost(cell, pricing.table);
      if (cellCost === null && !hasPrice(cell.model, pricing.table)) unpriced.add(cell.model);
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
        cell.project || '',
      ]);
    }

    const exists = sources.some((source) => source.exists);
    if (status === 'ok' && merged.length === 0 && queryFailures.length > 0) {
      status = 'error';
      errorMessage = queryFailures[0];
    }
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
  const installedIds = agents.filter((agent) => agent.status !== 'not-installed').map((agent) => agent.id);
  // A provider whose read failed — even one still served from stale cells — reported only part of
  // its files, so its cache entries must survive: one transient error must not force a full re-parse.
  const degradedIds = agents
    .filter((agent) => agent.status === 'error' || agent.status === 'broken' || agent.status === 'stale')
    .map((agent) => agent.id);
  cache.prune(installedIds, degradedIds);
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
    pricing: { version: PRICING_VERSION, fetched: PRICES_FETCHED, overrides: pricing.applied, invalid: pricing.invalid },
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

/** @param {number} value */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Cells this provider's last successful scans left in the cache, or [] when it never succeeded.
 * @param {ScanCache} cache
 * @param {string} providerId
 * @returns {import('./scanner-types.js').Cell[]}
 */
function cachedCellsOf(cache, providerId) {
  try {
    return typeof cache.allRows === 'function' ? cache.allRows(providerId) : [];
  } catch {
    return [];
  }
}

/**
 * File paths the provider's cache knows about ([] when it never succeeded).
 * @param {ScanCache} cache
 * @param {string} providerId
 * @returns {string[]}
 */
function cachedFilesOf(cache, providerId) {
  try {
    return typeof cache.filesOf === 'function' ? cache.filesOf(providerId) : [];
  } catch {
    return [];
  }
}
