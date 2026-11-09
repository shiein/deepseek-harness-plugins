/**
 * Scan orchestration: load every history provider, run it, normalize sessions, build the project
 * index, persist the snapshot and the fingerprint cache.
 *
 * A scan is expensive by design (it walks the local session stores of many agents), so it is only
 * invoked by the explicit Refresh action / the `scan` route. Nothing here runs on activation or on
 * a timer.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { loadProviders } from './providers/index.js';
import { HistoryCache, cachePathIn } from './cache.js';
import { makeScanContext } from './context.js';
import { mkdirSafe } from './fs-extra.js';
import { buildProjects, finalizeSession } from './model.js';

const SNAPSHOT_FORMAT = 1;
const SCAN_CONCURRENCY = 4;
const SNAPSHOT_FILE = 'last-scan.json';
const MAX_SESSIONS = 20000;

/**
 * @typedef {Object} Snapshot
 * @property {number} format
 * @property {number} scannedAt
 * @property {number} durationMs
 * @property {string} platform
 * @property {import('./types.js').AgentSnapshot[]} agents
 * @property {import('./types.js').SessionSummary[]} sessions
 * @property {Array<{key: string, path: string, name: string, sessions: number, messages: number,
 *                   agents: string[], startedAt: number, updatedAt: number, unknown: boolean}>} projects
 * @property {{sessions: number, messages: number, agents: number, projects: number}} totals
 * @property {number} cacheFiles
 */

/** @param {string} dataDir */
export function snapshotPathIn(dataDir) {
  return join(dataDir, SNAPSHOT_FILE);
}

/**
 * Load the last persisted snapshot. Never scans and never throws.
 * @param {string} dataDir
 * @returns {Promise<Snapshot|null>}
 */
export async function loadSnapshot(dataDir) {
  try {
    const raw = await fs.readFile(snapshotPathIn(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.format !== SNAPSHOT_FORMAT || !Array.isArray(parsed.sessions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The per-provider view of the shared cache handed to `provider.scan` as `ctx.cache`.
 * @param {HistoryCache} sharedCache
 * @param {string} providerId
 */
export function cacheFace(sharedCache, providerId) {
  return {
    /** @param {string} filePath @param {string} fingerprint */
    get: (filePath, fingerprint) => sharedCache.get(providerId, filePath, fingerprint),
    /**
     * The optional resume `state` is taken as a rest argument on purpose: several providers pick
     * their calling convention from `cache.set.length` (>= 4 means "pass providerId first"), so
     * the declared arity of this face must stay 3.
     * @param {string} filePath @param {string} fingerprint @param {any[]} rows @param {unknown[]} extra
     */
    set: (filePath, fingerprint, rows, ...extra) => sharedCache.set(providerId, filePath, fingerprint, rows, extra[0]),
    /** @param {string} filePath */
    peek: (filePath) => sharedCache.peek(providerId, filePath),
    /** @param {string} filePath */
    touch: (filePath) => sharedCache.touch(providerId, filePath),
  };
}

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
  const sharedCache = new HistoryCache({ filePath: cachePathIn(dataDir), providerVersions });
  await sharedCache.load();

  /** @param {string} providerId */
  const bindCache = (providerId) => cacheFace(sharedCache, providerId);

  /** @type {import('./types.js').SessionSummary[]} */
  const sessions = [];
  /** @type {import('./types.js').AgentSnapshot[]} */
  const agents = [];
  const seenSessions = new Set();
  const activeProviderIds = [];

  const results = await runWithConcurrency(providers, SCAN_CONCURRENCY, async (provider) => {
    const meta = provider.meta || {};
    const providerId = meta.id || 'unknown';
    activeProviderIds.push(providerId);
    const agentStarted = Date.now();
    /** @type {string[]} */
    const warnings = [];
    /** @type {import('./types.js').SourceInfo[]} */
    let sources = [];
    /** @type {import('./types.js').SessionSummary[]} */
    let providerSessions = [];
    let errorMessage;
    let status = 'ok';

    if (provider.error || typeof provider.scan !== 'function') {
      status = 'broken';
      errorMessage = String(provider.error?.message || provider.error || 'provider module failed to load');
    } else {
      try {
        const context = makeScanContext({ providerId, config, cache: bindCache(providerId), signal, warnings });
        const result = await provider.scan(context);
        sources = Array.isArray(result?.sources) ? result.sources : [];
        const rawSessions = Array.isArray(result?.sessions) ? result.sessions : [];
        for (const raw of rawSessions) {
          const session = finalizeSession(providerId, raw);
          if (session === null) continue;
          if (seenSessions.has(session.id)) continue;
          seenSessions.add(session.id);
          providerSessions.push(session);
          if (providerSessions.length >= MAX_SESSIONS) break;
        }
        if (providerSessions.length === 0) {
          const installed = sources.some((source) => source.exists);
          status = installed ? 'empty' : 'not-installed';
          if (context.queryFailures.length > 0) {
            status = 'error';
            errorMessage = context.queryFailures[0];
          }
        }
      } catch (error) {
        status = 'error';
        errorMessage = error instanceof Error ? error.message : String(error);
        warnings.push(`${meta.name || providerId}: ${errorMessage}`);
      }
    }

    const agent = {
      id: providerId,
      name: meta.name || providerId,
      color: meta.color || '#8a8f98',
      homepage: meta.homepage,
      status,
      sessions: providerSessions.length,
      messages: providerSessions.reduce((sum, session) => sum + session.messages, 0),
      durationMs: Date.now() - agentStarted,
      sources,
      warnings,
      error: errorMessage,
      resume: normalizeResume(meta),
      detail: typeof provider.readMessages === 'function' ? 'messages' : 'none',
    };
    return { agent, sessions: providerSessions };
  });

  sharedCache.prune(activeProviderIds);
  await sharedCache.save();

  for (const result of results) {
    if (!result) continue;
    agents.push(result.agent);
    sessions.push(...result.sessions);
  }
  agents.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  const snapshot = {
    format: SNAPSHOT_FORMAT,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    platform: process.platform,
    agents,
    sessions,
    projects: buildProjects(sessions),
    totals: {
      sessions: sessions.length,
      messages: sessions.reduce((sum, session) => sum + session.messages, 0),
      agents: agents.filter((agent) => agent.sessions > 0).length,
      projects: buildProjects(sessions).length,
    },
    cacheFiles: sharedCache.size(),
  };

  await persistSnapshot(dataDir, snapshot);
  return snapshot;
}

/**
 * @param {Record<string, unknown>} meta
 * @returns {{kind: 'cli'|'dsh'|'none', command?: string, args?: string[], target?: string}}
 */
function normalizeResume(meta) {
  const resume = meta.resume;
  if (!resume || typeof resume !== 'object') return { kind: 'none' };
  if (resume.kind === 'dsh') return { kind: 'dsh' };
  if (resume.kind === 'cli' && typeof resume.command === 'string' && Array.isArray(resume.args)) {
    return {
      kind: 'cli',
      command: resume.command,
      args: resume.args.map((arg) => String(arg)),
      target: typeof resume.target === 'string' ? resume.target : undefined,
    };
  }
  return { kind: 'none' };
}

/**
 * Read one session transcript through its provider.
 * @param {string} dataDir
 * @param {Record<string, unknown>} config
 * @param {import('./types.js').SessionSummary} session
 * @param {AbortSignal} signal
 */
export async function readSessionViaProvider(dataDir, config, session, signal) {
  const providers = await loadProviders();
  const provider = providers.find((entry) => entry.meta?.id === session.agentId);
  if (!provider || typeof provider.readMessages !== 'function') {
    return { supported: false, messages: [] };
  }
  const context = makeScanContext({ providerId: session.agentId, config, cache: nullCache(), signal, warnings: [] });
  const result = await provider.readMessages(context, session);
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  if (messages.length === 0 && context.queryFailures.length > 0) throw new Error(context.queryFailures[0]);
  return { supported: true, messages };
}

/** Cache face for read-only contexts (providers may check but never rely on it there). */
function nullCache() {
  return { get: () => undefined, set: () => {} };
}

/**
 * Persist the snapshot atomically.
 * @param {string} dataDir
 * @param {Snapshot} snapshot
 */
async function persistSnapshot(dataDir, snapshot) {
  try {
    const path = snapshotPathIn(dataDir);
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot), 'utf8');
    await fs.rename(temporary, path);
  } catch {
    // A read-only data directory must not fail a scan.
  }
}

/**
 * Run `worker` over `items` with a fixed concurrency, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runWithConcurrency(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
