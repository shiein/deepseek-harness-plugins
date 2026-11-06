/**
 * TEMPLATE for a provider module. Copy to `host/providers/<id>.js`, then fill in.
 * Read ../../CONTRACT.md before writing a real provider.
 */

import { join } from 'node:path';

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'example',
  name: 'Example Agent',
  color: '#888888',
  homepage: 'https://example.com',
  cacheVersion: 1,
};

/**
 * Scan local files for token usage. Must never throw for "not installed".
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const cells = [];

  const root = join(env.home, '.example-agent', 'sessions');
  const stat = await utils.statSafe(root);
  if (stat === null || !stat.isDirectory) {
    sources.push({ label: '~/.example-agent/sessions', path: root, exists: false, files: 0, bytes: 0 });
    return { sources, cells };
  }

  const files = await utils.listFilesRecursive(root, { exts: ['.jsonl'], signal: ctx.signal });
  let bytes = 0;

  for (const file of files) {
    bytes += file.size;
    const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
    let fileCells = cache.get(file.path, fingerprint);
    if (!fileCells) {
      /** @type {Map<string, import('../scanner-types.js').Cell>} */
      const byDayModel = new Map();
      // Parse one file into cells; merge by model+day.
      await utils.readJsonl(file.path, (line) => {
        const record = utils.safeJsonParse(line);
        if (!record || !record.usage) return;
        const ts = Date.parse(record.timestamp ?? '') || 0;
        const day = utils.localDay(ts);
        const model = String(record.model ?? 'unknown');
        const key = `${model}\u0000${day}`;
        const cell = byDayModel.get(key) ?? { model, day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
        cell.input += Number(record.usage.input_tokens) || 0;
        cell.output += Number(record.usage.output_tokens) || 0;
        cell.messages += 1;
        byDayModel.set(key, cell);
      });
      fileCells = [...byDayModel.values()];
      cache.set(file.path, fingerprint, fileCells);
    }
    cells.push(...fileCells);
  }

  sources.push({
    label: '~/.example-agent/sessions',
    path: root,
    exists: true,
    files: files.length,
    bytes,
  });
  return { sources, cells };
}
