// GENERATED from shared/host/context.js. Edit that file, then run: node scripts/sync-shared.mjs
/**
 * Builds the ScanContext handed to every scan provider. Shared by the scanner and the
 * self-test so both see identical helpers.
 */

import * as utils from './scan-utils.js';

/**
 * @param {Record<string, unknown>} [config]
 * @returns {Record<string, unknown>}
 */
export function makeEnv(config = {}) {
  const roots = utils.platformRoots();
  return { ...roots, config: config || {} };
}

/**
 * @param {{providerId: string, config?: Record<string, unknown>, cache: Record<string, Function>,
 *          signal?: AbortSignal, warnings?: string[]}} options
 * @returns {Record<string, any>} the ScanContext described in CONTRACT.md
 */
export function makeScanContext(options) {
  const warnings = options.warnings || [];
  /** Distinct failed queries: a store whose format changed must not look like an empty one. */
  const queryFailures = [];
  const querySqlite = (db, sql, params) => utils.querySqlite(db, sql, params, (error) => {
    const message = `SQLite query failed: ${error instanceof Error ? error.message : String(error)}`;
    if (queryFailures.includes(message)) return;
    queryFailures.push(message);
    warnings.push(message);
  });
  return {
    providerId: options.providerId,
    signal: options.signal || new AbortController().signal,
    env: makeEnv(options.config),
    utils: { ...utils, querySqlite },
    queryFailures,
    cache: options.cache,
    warn(message) {
      if (typeof message === 'string' && message.trim() !== '') warnings.push(message.trim());
    },
  };
}
