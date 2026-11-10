/**
 * DeepSeek Harness provider.
 *
 * DSH keeps append-only session logs at `<DSH_HOME|~/.dsh>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`.
 * The file is a concatenation of zstd frames (one appended record per frame, not one big frame),
 * so `utils.zstdDecompressAll` walks the frames. Each decompressed line is one session event:
 *   { "type": "assistant/message", "seq": 17, "time": 1792320570384,
 *     "data": { "turn": 1, "step": 1,
 *               "message": { "role": "assistant", "source": { "provider": "deepseek-account",
 *                            "model": "deepseek-flash" }, ... },
 *               "usage": { "inputTokens": 961, "outputTokens": 186,
 *                          "cacheReadTokens": 8320, "cacheWriteTokens": 0, "totalTokens": 9467 } } }
 * `inputTokens` is already uncached, and the usage also appears a second time inside
 * `data.stream` (a `{type:'usage'}` chunk) — only the top-level `data.usage` is counted.
 * Uncompressed `session.v4.jsonl` logs are read as plain JSONL too.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  color: '#4d6bfe',
  homepage: 'https://deepseek.com',
  cacheVersion: 2, // 2: rows carry the session folder (header `cwd`)
};

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];

  const roots = new Set();
  for (const configured of [process.env.DSH_HOME, join(env.home, '.dsh')]) {
    if (configured) roots.add(join(configured, 'sessions'));
  }

  for (const sessionsRoot of roots) {
    const stat = await utils.statSafe(sessionsRoot);
    if (stat === null || !stat.isDirectory) {
      sources.push({ label: 'DeepSeek Harness sessions', path: sessionsRoot, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const files = await utils.listFilesRecursive(sessionsRoot, {
      exts: ['.zstd', '.jsonl'],
      signal: ctx.signal,
      maxDepth: 6,
    });
    const sessionFiles = files.filter((file) => /session\.[a-z0-9]+\.jsonl(\.zstd)?$/i.test(file.path));
    let bytes = 0;
    for (const file of sessionFiles) {
      bytes += file.size;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        const seenSeq = new Set();
        try {
          const buffer = await utils.readBuffer(file.path);
          if (!buffer) continue;
          let text = '';
          if (utils.isZstd(buffer)) {
            text = utils.zstdDecompressAll(buffer).toString('utf8');
          } else {
            text = buffer.toString('utf8');
          }
          let cwd = '';
          for (const line of text.split('\n')) {
            if (cwd === '' && line.startsWith('{"type":"session"')) {
              const header = utils.safeJsonParse(line);
              if (header && typeof header.cwd === 'string') cwd = header.cwd;
              continue;
            }
            if (line === '' || !line.includes('"assistant/message"')) continue;
            const record = utils.safeJsonParse(line);
            if (!record || record.type !== 'assistant/message') continue;
            const data = record.data;
            const usage = data?.usage;
            if (!usage || typeof usage !== 'object') continue;
            const seq = typeof record.seq === 'number' ? record.seq : undefined;
            if (seq !== undefined) {
              if (seenSeq.has(seq)) continue;
              seenSeq.add(seq);
            }
            const model =
              typeof data?.message?.source?.model === 'string' && data.message.source.model !== ''
                ? data.message.source.model
                : 'unknown';
            const input = num(usage.inputTokens);
            const output = num(usage.outputTokens);
            const cacheRead = num(usage.cacheReadTokens);
            const cacheWrite = num(usage.cacheWriteTokens);
            if (input + output + cacheRead + cacheWrite === 0) continue;
            const ts = typeof record.time === 'number' ? record.time : Date.parse(record.time || '') || 0;
            addUsage(byKey, {
              model,
              project: cwd,
              day: utils.localDay(ts),
              ts,
              input,
              output,
              cacheRead,
              cacheWrite,
              messages: 1,
            });
          }
        } catch (error) {
          ctx.warn(`DeepSeek Harness: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        fileCells = finalizeCells([...byKey.values()]);
        cache.set(file.path, fingerprint, fileCells);
      }
      if (fileCells.length > 0) allCells.push(...fileCells);
    }
    sources.push({
      label: 'DeepSeek Harness sessions',
      path: sessionsRoot,
      exists: true,
      files: sessionFiles.length,
      bytes,
      note: 'zstd multi-frame session logs',
    });
  }

  return { sources, cells: mergeCells(allCells) };
}

/** @param {unknown} value */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
