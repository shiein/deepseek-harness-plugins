/**
 * Per-file fingerprint cache for history provider scans.
 *
 * A scan is the only trigger for reading session files. This cache keeps a manual refresh cheap:
 * a file whose size+mtime did not change reuses the sessions parsed last time. The cache is
 * persisted as JSON so a restart does not force a full re-parse.
 */

import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdirSafe } from './fs-extra.js';

const CACHE_FORMAT = 1;
const MAX_FILES_PER_PROVIDER = 50000;

/** @typedef {{fp: string, sessions: any[], state?: unknown}} CacheEntry */

export class HistoryCache {
  /**
   * @param {{filePath: string, providerVersions: Record<string, number>, onChange?: () => void}} options
   */
  constructor(options) {
    this.filePath = options.filePath;
    this.providerVersions = options.providerVersions || {};
    /** @type {Map<string, {cacheVersion: number, files: Map<string, CacheEntry>}>} */
    this.providers = new Map();
    /** @type {Map<string, Set<string>>} */
    this.touched = new Map();
    this.loaded = false;
    this.onChange = options.onChange || null;
  }

  /** Read the cache file from disk (best effort). */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let raw = null;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || parsed.format !== CACHE_FORMAT || typeof parsed.providers !== 'object') return;
    for (const [id, entry] of Object.entries(parsed.providers)) {
      const wanted = this.providerVersions[id];
      if (typeof wanted !== 'number' || entry?.cacheVersion !== wanted) continue;
      const files = new Map();
      for (const [file, value] of Object.entries(entry.files || {})) {
        if (value && typeof value.fp === 'string' && Array.isArray(value.sessions)) {
          files.set(file, value.state === undefined
            ? { fp: value.fp, sessions: value.sessions }
            : { fp: value.fp, sessions: value.sessions, state: value.state });
        }
        if (files.size >= MAX_FILES_PER_PROVIDER) break;
      }
      this.providers.set(id, { cacheVersion: wanted, files });
    }
  }

  /**
   * @param {string} providerId
   * @param {string} filePath
   * @param {string} fingerprint
   * @returns {any[]|undefined} cached sessions for the exact fingerprint
   */
  get(providerId, filePath, fingerprint) {
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;
    const entry = provider.files.get(filePath);
    if (!entry || entry.fp !== fingerprint) return undefined;
    this.touch(providerId, filePath);
    return entry.sessions;
  }

  /**
   * Previous entry for a file regardless of its fingerprint, so a provider can reuse per-item work
   * from its stored resume state (e.g. unchanged sessions inside one large database).
   * @param {string} providerId
   * @param {string} filePath
   * @returns {CacheEntry|undefined}
   */
  peek(providerId, filePath) {
    const entry = this.providers.get(providerId)?.files.get(filePath);
    if (entry) this.touch(providerId, filePath);
    return entry;
  }

  /**
   * @param {string} providerId
   * @param {string} filePath
   * @param {string} fingerprint
   * @param {any[]} sessions
   * @param {unknown} [state] provider-defined JSON-serialisable resume state
   */
  set(providerId, filePath, fingerprint, sessions, state) {
    let provider = this.providers.get(providerId);
    const cacheVersion = this.providerVersions[providerId] ?? 1;
    if (!provider || provider.cacheVersion !== cacheVersion) {
      provider = { cacheVersion, files: new Map() };
      this.providers.set(providerId, provider);
    }
    if (provider.files.size >= MAX_FILES_PER_PROVIDER && !provider.files.has(filePath)) {
      const oldest = provider.files.keys().next();
      if (!oldest.done) provider.files.delete(oldest.value);
    }
    provider.files.set(filePath, state === undefined ? { fp: fingerprint, sessions } : { fp: fingerprint, sessions, state });
    this.touch(providerId, filePath);
  }

  /**
   * Mark a file as still present so pruning keeps it.
   * @param {string} providerId
   * @param {string} filePath
   */
  touch(providerId, filePath) {
    let set = this.touched.get(providerId);
    if (!set) {
      set = new Set();
      this.touched.set(providerId, set);
    }
    set.add(filePath);
  }

  /**
   * Drop entries for files the provider no longer reports. A failed provider reported only part of
   * its files, so its entries stay: one transient error must not force a full re-parse.
   * @param {string[]} activeProviderIds
   * @param {string[]} [failedProviderIds]
   */
  prune(activeProviderIds, failedProviderIds = []) {
    const active = new Set(activeProviderIds);
    const failed = new Set(failedProviderIds);
    for (const id of [...this.providers.keys()]) {
      if (failed.has(id)) continue;
      if (!active.has(id)) {
        this.providers.delete(id);
        continue;
      }
      const touched = this.touched.get(id) || new Set();
      const provider = this.providers.get(id);
      for (const file of [...provider.files.keys()]) {
        if (!touched.has(file)) provider.files.delete(file);
      }
    }
    this.touched.clear();
  }

  /** Persist the cache as JSON (atomic replace, best effort). */
  async save() {
    const payload = { format: CACHE_FORMAT, savedAt: Date.now(), providers: {} };
    for (const [id, provider] of this.providers) {
      const files = {};
      for (const [file, entry] of provider.files) {
        files[file] = entry.state === undefined
          ? { fp: entry.fp, sessions: entry.sessions }
          : { fp: entry.fp, sessions: entry.sessions, state: entry.state };
      }
      payload.providers[id] = { cacheVersion: provider.cacheVersion, files };
    }
    try {
      await mkdirSafe(dirname(this.filePath));
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
      await fs.rename(temporary, this.filePath);
    } catch {
      // A read-only data directory must not fail a scan.
    }
  }

  /** Number of files currently cached (diagnostics). */
  size() {
    let total = 0;
    for (const provider of this.providers.values()) total += provider.files.size;
    return total;
  }
}

/** @param {string} dataDir @returns {string} */
export function cachePathIn(dataDir) {
  return join(dataDir, 'scan-cache.json');
}
