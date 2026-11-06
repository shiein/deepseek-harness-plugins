/**
 * Continue history provider — detection only.
 *
 * Continue (VS Code / JetBrains / `cn` CLI) stores one JSON document per chat under
 *   ${CONTINUE_GLOBAL_DIR:-~/.continue}/sessions/<sessionId>.json
 * with sessions.json next to them holding dateCreated/workspaceDirectory metadata.
 *
 * Detection only: session documents are counted and reported, but their history is not
 * converted into history entries by this bundle (the task split assigns Continue to detection
 * only), so no sessions are reported.
 */

import { join } from 'node:path';

export const meta = {
  id: 'continue',
  name: 'Continue',
  color: '#ef4444',
  homepage: 'https://continue.dev',
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
  const override = (process.env.CONTINUE_GLOBAL_DIR || '').trim();
  const root = override !== '' ? override.replace(/^~(?=$|[\\/])/, env.home) : join(env.home, '.continue');
  const sessionsDir = join(root, 'sessions');
  const stat = await utils.statSafe(sessionsDir);

  if (stat && stat.isDirectory) {
    const entries = await utils.readdirSafe(sessionsDir);
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'sessions.json') continue;
      const fileStat = await utils.statSafe(join(sessionsDir, entry.name));
      if (fileStat === null || !fileStat.isFile) continue;
      files += 1;
      bytes += fileStat.size;
    }
    sources.push({
      label: 'Continue sessions',
      path: sessionsDir,
      exists: true,
      files,
      bytes,
      note: 'sessions/<id>.json chat documents; conversation parsing is not enabled (detection-only)',
    });
    ctx.warn('Continue: local session documents were found but this provider is detection-only and reports no sessions');
  } else {
    sources.push({
      label: 'Continue sessions',
      path: sessionsDir,
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Continue is not installed here (or CONTINUE_GLOBAL_DIR points elsewhere)',
    });
  }

  return { sources, sessions: [] };
}
