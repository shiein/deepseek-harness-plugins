import { FingerprintCache, cachePathIn } from './fingerprint-cache.js';

export { cachePathIn };

/** Scan cache whose rows are usage cells. */
export class ScanCache extends FingerprintCache {
  /** @param {{filePath: string, providerVersions: Record<string, number>}} options */
  constructor(options) {
    super({ ...options, rowsKey: 'cells' });
  }
}
