/**
 * Amp history provider — detection only.
 *
 * Sourcegraph's Amp CLI keeps one JSON thread per conversation under `<data-dir>/threads/**`,
 * where the data dir is $AMP_DATA_DIR (a comma-separated list, like Amp itself) or
 * ~/.local/share/amp (%LOCALAPPDATA%\amp on Windows; some builds also use ~/.amp). ~/.config/amp
 * only holds configuration/plugins, not conversations.
 *
 * Detection only: thread files are counted and reported, but their messages/usageLedger are not
 * converted into history entries by this bundle (the task split assigns Amp to detection only),
 * so no sessions are reported.
 */

import { join } from 'node:path';

export const meta = {
  id: 'amp',
  name: 'Amp',
  color: '#f34f29',
  homepage: 'https://ampcode.com',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function dataDirs(env) {
  const raw = process.env.AMP_DATA_DIR || '';
  if (raw.trim() !== '') {
    const dirs = raw
      .split(',')
      .map((part) => part.trim().replace(/^~(?=$|[\\/])/, env.home))
      .filter(Boolean);
    if (dirs.length > 0) return [...new Set(dirs)];
  }
  const dirs = [];
  if (env.platform === 'win32' && env.localAppData) dirs.push(join(env.localAppData, 'amp'));
  dirs.push(join(env.xdgData, 'amp'));
  dirs.push(join(env.home, '.amp'));
  return [...new Set(dirs)];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  let found = false;

  for (const dataDir of dataDirs(env)) {
    const threadsDir = join(dataDir, 'threads');
    const stat = await utils.statSafe(threadsDir);
    if (stat === null || !stat.isDirectory) continue;
    found = true;
    const files = await utils.listFilesRecursive(threadsDir, {
      exts: ['.json'],
      maxDepth: 8,
      maxFiles: 5000,
      signal: ctx.signal,
    });
    let bytes = 0;
    for (const file of files) bytes += file.size;
    sources.push({
      label: 'Amp threads',
      path: threadsDir,
      exists: true,
      files: files.length,
      bytes,
      note: 'thread JSON files; conversation parsing is not enabled (detection-only)',
    });
  }

  if (!found) {
    const configDir = join(env.home, '.config', 'amp');
    const configStat = await utils.statSafe(configDir);
    sources.push({
      label: 'Amp threads',
      path: join(dataDirs(env)[0] || join(env.xdgData, 'amp'), 'threads'),
      exists: false,
      files: 0,
      bytes: 0,
      note:
        configStat && configStat.isDirectory
          ? '~/.config/amp exists (configuration/plugins only); no Amp threads store was found'
          : 'Amp is not installed here (or AMP_DATA_DIR points elsewhere)',
    });
  } else {
    ctx.warn('Amp: local thread files were found but this provider is detection-only and reports no sessions');
  }

  return { sources, sessions: [] };
}
