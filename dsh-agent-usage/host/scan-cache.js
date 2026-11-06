/**
 * Per-file fingerprint cache for provider scans.
 *
 * Refresh is the only trigger for a scan; this cache keeps a manual refresh cheap by reusing the
 * cells parsed from files whose size+mtime did not change since the previous scan. The cache is
 * persisted as JSON so a restart does not force a full re-parse either.
 */

import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdirSafe } from './fs-extra.js';

const CACHE_FORMAT = 1;
const MAX_FILES_PER_PROVIDER = 50000;

export class ScanCache {
  /**
   * @param {{filePath: string, providerVersions: Record<string, number>}} options
   */
  constructor(options) {
    this.filePath = options.filePath;
    this.providerVersions = options.providerVersions || {};
    /** @type {Map<string, {cacheVersion: number, files: Map<string, {fp: string, cells: any[]}>}>} */
    this.providers = new Map();
    /** @type {Map<string, Set<string>>} */
    this.touched = new Map();
    this.loaded = false;
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
        if (value && typeof value.fp === 'string' && Array.isArray(value.cells)) {
          files.set(file, { fp: value.fp, cells: value.cells });
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
   * @returns {any[]|undefined} cached cells for the exact fingerprint
   */
  get(providerId, filePath, fingerprint) {
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;
    const entry = provider.files.get(filePath);
    if (!entry || entry.fp !== fingerprint) return undefined;
    this.touch(providerId, filePath);
    return entry.cells;
  }

  /**
   * @param {string} providerId
   * @param {string} filePath
   * @param {string} fingerprint
   * @param {any[]} cells
   */
  set(providerId, filePath, fingerprint, cells) {
    let provider = this.providers.get(providerId);
    const cacheVersion = this.providerVersions[providerId] ?? 1;
    if (!provider || provider.cacheVersion !== cacheVersion) {
      provider = { cacheVersion, files: new Map() };
      this.providers.set(providerId, provider);
    }
    if (provider.files.size >= MAX_FILES_PER_PROVIDER && !provider.files.has(filePath)) {
      // Keep the cache bounded: drop the oldest insertion.
      const oldest = provider.files.keys().next();
      if (!oldest.done) provider.files.delete(oldest.value);
    }
    provider.files.set(filePath, { fp: fingerprint, cells });
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
   * Drop cache entries for files the provider no longer reports (deleted sessions), and drop
   * providers that are not present in this scan.
   * @param {string[]} activeProviderIds
   */
  prune(activeProviderIds) {
    const active = new Set(activeProviderIds);
    for (const id of [...this.providers.keys()]) {
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
      for (const [file, entry] of provider.files) files[file] = { fp: entry.fp, cells: entry.cells };
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

  /** @param {string} providerId */
  clearProvider(providerId) {
    this.providers.delete(providerId);
    this.touched.delete(providerId);
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
