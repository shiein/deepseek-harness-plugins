/**
 * History provider registry: discovers every `host/providers/*.js` module (except `_template.js`,
 * `self-test.mjs` and this file) and validates its shape. Dropping a new provider file into this
 * directory is enough for the panel to pick it up.
 */

import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['index.js', '_template.js', 'self-test.mjs']);

/**
 * @returns {Promise<Array<{meta: any, module?: any, error?: Error,
 *   scan?: (ctx: import('../types.js').ScanContext) => Promise<{sources: any[], sessions: any[]}>,
 *   readMessages?: (ctx: import('../types.js').ScanContext, session: any) => Promise<{messages: any[]}>}>>}
 */
export async function loadProviders() {
  let entries = [];
  try {
    entries = await readdir(HERE, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_') && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  /** @type {any[]} */
  const providers = [];
  for (const file of files) {
    const fallbackId = file.replace(/\.js$/, '');
    try {
      // Cache-bust with the file mtime so a provider edited on disk is picked up by the next
      // scan instead of requiring a Host restart.
      const filePath = join(HERE, file);
      let revision = 0;
      try {
        revision = Math.round((await stat(filePath)).mtimeMs);
      } catch {
        revision = 0;
      }
      const module = await import(`${pathToFileURL(filePath).href}?m=${revision}`);
      if (!module || typeof module.scan !== 'function' || !module.meta || typeof module.meta.id !== 'string') {
        throw new Error('module must export `meta` (with id) and `scan(ctx)`');
      }
      providers.push({ ...module.meta, meta: module.meta, module, scan: module.scan, readMessages: module.readMessages });
    } catch (error) {
      providers.push({
        meta: { id: fallbackId, name: fallbackId, color: '#8a8a8a' },
        error,
      });
    }
  }
  return providers;
}
