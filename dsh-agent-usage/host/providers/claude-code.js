/**
 * Claude Code provider.
 *
 * Claude Code writes one append-only JSONL transcript per session under
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<project-slug>/<session-uuid>.jsonl`.
 * Every assistant turn carries an Anthropic `usage` block:
 *   message.usage = {
 *     input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens,
 *     cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens },
 *     service_tier, speed
 *   }
 * `input_tokens` excludes cache reads/writes (Anthropic semantics), so they are separate columns.
 * Subagent (sidechain) transcripts live in the same tree and count as real usage.
 */

import { join } from 'node:path';
import { addUsage, finalizeCells, mergeCells } from '../cells.js';

export const meta = {
  id: 'claude-code',
  name: 'Claude Code',
  color: '#d97757',
  homepage: 'https://www.anthropic.com/claude-code',
  // v2: dedupe by message.id + requestId (one API response is written as several JSONL lines).
  cacheVersion: 3, // 3: rows carry the session folder (`cwd`)
};

/** @param {string} envOverride @param {string} home */
function configRoots(envOverride, home) {
  const roots = [];
  if (envOverride) roots.push(envOverride);
  roots.push(join(home, '.claude'));
  return [...new Set(roots)];
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, cache, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  /** @type {import('../scanner-types.js').Cell[]} */
  const allCells = [];

  for (const root of configRoots(process.env.CLAUDE_CONFIG_DIR || '', env.home)) {
    const projects = join(root, 'projects');
    const probe = await utils.statSafe(projects);
    if (probe === null || !probe.isDirectory) {
      sources.push({ label: 'Claude Code transcripts', path: projects, exists: false, files: 0, bytes: 0 });
      continue;
    }
    const files = await utils.listFilesRecursive(projects, { exts: ['.jsonl'], signal: ctx.signal });
    let bytes = 0;
    let parsedFiles = 0;
    for (const file of files) {
      bytes += file.size;
      parsedFiles += 1;
      const fingerprint = `${file.size}:${Math.round(file.mtimeMs)}`;
      let fileCells = cache.get(file.path, fingerprint);
      if (!fileCells) {
        /** @type {Map<string, import('../scanner-types.js').Cell>} */
        const byKey = new Map();
        const seenUuids = new Set();
        try {
          await utils.readJsonl(
            file.path,
            (line) => {
              // Fast prefilter: only assistant messages carry usage.
              if (!line.includes('"usage"')) return;
              const record = utils.safeJsonParse(line);
              if (!record || record.type !== 'assistant') return;
              const message = record.message;
              if (!message || typeof message !== 'object') return;
              const usage = message.usage;
              if (!usage || typeof usage !== 'object') return;
              // Claude Code writes one JSONL line per content block (thinking / text / tool_use) of
              // the same API response; every line repeats the identical usage block with its own
              // uuid. The response identity is message.id + requestId, so count it once.
              const messageId = typeof message.id === 'string' ? message.id : '';
              const dedupeKey = messageId !== ''
                ? `${messageId}:${typeof record.requestId === 'string' ? record.requestId : ''}`
                : typeof record.uuid === 'string' ? `uuid:${record.uuid}` : '';
              if (dedupeKey !== '') {
                if (seenUuids.has(dedupeKey)) return;
                seenUuids.add(dedupeKey);
              }
              const model = typeof message.model === 'string' ? message.model : 'unknown';
              if (model === '<synthetic>') return;
              const input = num(usage.input_tokens);
              const output = num(usage.output_tokens);
              const cacheRead = num(usage.cache_read_input_tokens);
              const cacheWrite = num(usage.cache_creation_input_tokens);
              if (input + output + cacheRead + cacheWrite === 0) return;
              const ts = Date.parse(record.timestamp || '') || 0;
              addUsage(byKey, {
                model,
                project: typeof record.cwd === 'string' ? record.cwd : '',
                day: utils.localDay(ts),
                ts,
                input,
                output,
                cacheRead,
                cacheWrite,
                messages: 1,
              });
            },
            { signal: ctx.signal },
          );
        } catch (error) {
          ctx.warn(`Claude Code: cannot read ${file.path}: ${error?.message || error}`);
          continue;
        }
        fileCells = finalizeCells([...byKey.values()]);
        cache.set(file.path, fingerprint, fileCells);
      }
      if (fileCells.length > 0) allCells.push(...fileCells);
    }
    sources.push({
      label: 'Claude Code transcripts',
      path: projects,
      exists: true,
      files: parsedFiles,
      bytes,
    });
  }

  return { sources, cells: mergeCells(allCells) };
}

/** @param {unknown} value */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
