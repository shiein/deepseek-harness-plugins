/**
 * Builds the ScanContext handed to every history provider. Shared by the scanner and the
 * self-test so both see identical helpers.
 */

import * as utils from './scan-utils.js';

/**
 * @param {Record<string, unknown>} [config]
 * @returns {import('./types.js').EnvFace}
 */
export function makeEnv(config = {}) {
  const roots = utils.platformRoots();
  return { ...roots, config: config || {} };
}

/**
 * @param {{providerId: string, config?: Record<string, unknown>, cache: import('./types.js').CacheFace,
 *          signal?: AbortSignal, warnings?: string[]}} options
 * @returns {import('./types.js').ScanContext}
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
