/**
 * Windsurf history provider — detection only.
 *
 * Windsurf (Codeium) keeps its agent/chat state in several local places:
 *   macOS:   ~/Library/Application Support/Windsurf, ~/.windsurf, ~/.codeium/windsurf
 *   Windows: %APPDATA%\Windsurf, %USERPROFILE%\.windsurf, %USERPROFILE%\.codeium\windsurf
 *   Linux:   ~/.config/Windsurf, ~/.windsurf, ~/.codeium/windsurf
 *
 * Verified on this machine: `User/globalStorage/state.vscdb` holds only auth/plan/model-picker
 * state, and Cascade conversations are encrypted protobuf files under
 * `~/.codeium/windsurf/cascade/<uuid>.pb` with no plaintext model/token/text strings. Windsurf
 * serves usage/history from its account service, so no session can be read locally. We report
 * the exact paths and skip sessions instead of fabricating them.
 */

import { join } from 'node:path';

export const meta = {
  id: 'windsurf',
  name: 'Windsurf',
  color: '#0ea5e9',
  homepage: 'https://windsurf.com',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function appRoots(env) {
  return [join(env.appData, 'Windsurf'), join(env.home, '.windsurf')];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  let installed = false;

  for (const root of appRoots(env)) {
    const rootStat = await utils.statSafe(root);
    if (rootStat === null || !rootStat.isDirectory) {
      sources.push({ label: 'Windsurf local data', path: root, exists: false, files: 0, bytes: 0 });
      continue;
    }
    installed = true;
    const stateDbPath = join(root, 'User', 'globalStorage', 'state.vscdb');
    const stateDbStat = await utils.statSafe(stateDbPath);
    if (stateDbStat && stateDbStat.isFile) {
      sources.push({
        label: 'Windsurf VS Code state',
        path: stateDbPath,
        exists: true,
        files: 0,
        bytes: stateDbStat.size,
        note: 'app state/auth/plan metadata only; no conversation text or token counters',
      });
    }
  }

  const codeiumHome = join(env.home, '.codeium', 'windsurf');
  const codeiumStat = await utils.statSafe(codeiumHome);
  let cascadeFiles = 0;
  let cascadeBytes = 0;
  if (codeiumStat && codeiumStat.isDirectory) {
    installed = true;
    const cascadeDir = join(codeiumHome, 'cascade');
    const cascadeStat = await utils.statSafe(cascadeDir);
    if (cascadeStat && cascadeStat.isDirectory) {
      for (const entry of await utils.readdirSafe(cascadeDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.pb')) continue;
        const stat = await utils.statSafe(join(cascadeDir, entry.name));
        if (stat === null || !stat.isFile) continue;
        cascadeFiles += 1;
        cascadeBytes += stat.size;
      }
      sources.push({
        label: 'Windsurf Cascade sessions',
        path: cascadeDir,
        exists: true,
        files: cascadeFiles,
        bytes: cascadeBytes,
        note: 'encrypted protobuf (.pb) Cascade conversations; history is account-served, not locally readable',
      });
    }
    sources.push({
      label: 'Windsurf agent home',
      path: codeiumHome,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'brain/memories/context_state artifacts; no plaintext conversation store',
    });
  }

  if (!installed && sources.length === 0) {
    sources.push({
      label: 'Windsurf local data',
      path: join(env.appData, 'Windsurf'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Windsurf is not installed on this machine',
    });
  } else if (installed) {
    ctx.warn(
      'Windsurf: Cascade conversations are encrypted protobuf files and history is served by the Windsurf account, so no local sessions are readable',
    );
  }

  return { sources, sessions: [] };
}
