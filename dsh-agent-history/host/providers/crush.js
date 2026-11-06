/**
 * Crush history provider — detection only.
 *
 * Charmbracelet's Crush TUI registers every project it touched in
 *   $CRUSH_GLOBAL_DATA/projects.json
 *   ~/.local/share/crush/projects.json            (XDG_DATA_HOME honored)
 *   %LOCALAPPDATA%\crush\projects.json            (Windows)
 * and keeps one SQLite database per project at `<project>/<data_dir>/crush.db` (data_dir
 * defaults to .crush). Some builds keep a single global `<root>/crush.db` instead.
 *
 * Detection only: the registry and project databases are reported, but their sessions table is
 * not converted into history entries by this bundle (the task split assigns Crush to detection
 * only), so no sessions are reported.
 */

import { join } from 'node:path';

export const meta = {
  id: 'crush',
  name: 'Crush',
  color: '#ec4899',
  homepage: 'https://github.com/charmbracelet/crush',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function globalRoots(env) {
  const override = (process.env.CRUSH_GLOBAL_DATA || '').trim();
  if (override !== '') return [override.replace(/^~(?=$|[\\/])/, env.home)];
  const roots = [];
  if (env.platform === 'win32' && env.localAppData) roots.push(join(env.localAppData, 'crush'));
  roots.push(join(env.xdgData, 'crush'));
  return [...new Set(roots)];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  let found = false;

  for (const root of globalRoots(env)) {
    const registryPath = join(root, 'projects.json');
    const registryStat = await utils.statSafe(registryPath);
    if (registryStat && registryStat.isFile) {
      found = true;
      let projects = 0;
      const raw = await utils.readText(registryPath);
      const parsed = raw === null ? null : utils.safeJsonParse(raw);
      if (Array.isArray(parsed)) projects = parsed.length;
      else if (parsed && typeof parsed === 'object') {
        const list = Array.isArray(parsed.projects) ? parsed.projects : Object.values(parsed);
        projects = list.filter((entry) => entry && typeof entry === 'object').length;
      }
      sources.push({
        label: 'Crush project registry',
        path: registryPath,
        exists: true,
        files: 1,
        bytes: registryStat.size,
        note: `${projects} registered project(s); per-project crush.db conversations are not parsed (detection-only)`,
      });
    }

    const globalDb = join(root, 'crush.db');
    const dbStat = await utils.statSafe(globalDb);
    if (dbStat && dbStat.isFile) {
      found = true;
      sources.push({
        label: 'Crush sessions database',
        path: globalDb,
        exists: true,
        files: 1,
        bytes: dbStat.size,
        note: 'global crush.db; conversation parsing is not enabled (detection-only)',
      });
    }
  }

  if (!found) {
    sources.push({
      label: 'Crush project registry',
      path: join(globalRoots(env)[0] || join(env.xdgData, 'crush'), 'projects.json'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Crush is not installed here (or CRUSH_GLOBAL_DATA points elsewhere)',
    });
  } else {
    ctx.warn('Crush: a local registry/database was found but this provider is detection-only and reports no sessions');
  }

  return { sources, sessions: [] };
}
