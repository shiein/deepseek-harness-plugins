/**
 * Factory Droid history provider — detection only.
 *
 * Factory's Droid CLI writes `$FACTORY_DIR` (default ~/.factory) with:
 *   sessions/<subdir>/*.jsonl            one transcript per session (session_start + messages)
 *   sessions/<name>.settings.json        model/tokenUsage companion file
 *
 * Detection only: session transcripts are counted and reported, but they are not converted into
 * history entries by this bundle (the task split assigns Factory Droid to detection only), so
 * no sessions are reported. A ~/.factory that only holds settings.json is still detected.
 */

import { join } from 'node:path';

export const meta = {
  id: 'factory-droid',
  name: 'Factory Droid',
  color: '#22c55e',
  homepage: 'https://factory.ai',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  const configured = (process.env.FACTORY_DIR || '').trim();
  const base = configured !== '' ? configured.replace(/^~(?=$|[\\/])/, env.home) : join(env.home, '.factory');
  const sessionsDir = join(base, 'sessions');
  const sessionsStat = await utils.statSafe(sessionsDir);

  if (sessionsStat && sessionsStat.isDirectory) {
    const files = await utils.listFilesRecursive(sessionsDir, {
      exts: ['.jsonl'],
      maxDepth: 4,
      maxFiles: 5000,
      signal: ctx.signal,
    });
    let bytes = 0;
    for (const file of files) bytes += file.size;
    sources.push({
      label: 'Droid sessions',
      path: sessionsDir,
      exists: true,
      files: files.length,
      bytes,
      note: 'session JSONL transcripts; conversation parsing is not enabled (detection-only)',
    });
    ctx.warn('Factory Droid: local session transcripts were found but this provider is detection-only and reports no sessions');
  } else {
    const baseStat = await utils.statSafe(base);
    sources.push({
      label: 'Droid sessions',
      path: sessionsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note:
        baseStat && baseStat.isDirectory
          ? '~/.factory exists (settings only); no sessions/ transcripts to read'
          : 'Factory Droid is not installed on this machine',
    });
  }

  return { sources, sessions: [] };
}
