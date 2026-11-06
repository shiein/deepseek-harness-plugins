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
  return {
    providerId: options.providerId,
    signal: options.signal || new AbortController().signal,
    env: makeEnv(options.config),
    utils,
    cache: options.cache,
    warn(message) {
      if (typeof message === 'string' && message.trim() !== '') warnings.push(message.trim());
    },
  };
}
