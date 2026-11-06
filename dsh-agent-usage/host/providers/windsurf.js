/**
 * Windsurf usage provider.
 *
 * Windsurf (Codeium) stores its chat/agent state in several local places:
 *   macOS:   ~/Library/Application Support/Windsurf          (Electron app, VS Code fork)
 *            ~/.windsurf                                    (VS Code-style argv/extensions)
 *            ~/.codeium/windsurf                            (Cascade agent home)
 *   Windows: %APPDATA%\Windsurf, %USERPROFILE%\.windsurf, %USERPROFILE%\.codeium\windsurf
 *   Linux:   ~/.config/Windsurf, ~/.windsurf, ~/.codeium/windsurf
 *
 * ── Verified on this machine (2026-11-04) ────────────────────────────────────────────────
 * - `User/globalStorage/state.vscdb` has no token counters: keys are windsurfConfigurations,
 *   windsurfAuthStatus (auth/plan metadata), windsurfSpace.*, chat.* model pickers, etc.
 * - Cascade conversations are `~/.codeium/windsurf/cascade/<uuid>.pb`: encrypted protobuf
 *   files (no printable JSON, no model/token strings, `file(1)` misreads the header as a key
 *   blob). There is no plaintext token ledger.
 * - `~/.codeium/windsurf/brain`, `memories`, `context_state`, `database` contain memory and
 *   code-tracker material, not billable usage.
 *
 * Windsurf reports usage to its account service; the local files are not locally readable as
 * token counts. The provider reports the installation as detected-but-unavailable and never
 * fabricates numbers.
 */

/** @type {import('../scanner-types.js').ProviderMeta} */
export const meta = {
  id: 'windsurf',
  name: 'Windsurf',
  color: '#0ea5e9',
  homepage: 'https://windsurf.com',
  cacheVersion: 1,
};

/**
 * @param {import('../scanner-types.js').ScanContext['env']} env
 * @param {any} utils
 * @returns {string[]}
 */
function appRoots(env, utils) {
  const roots = [];
  if (env.platform === 'win32') {
    roots.push(utils.joinPath(env.appData, 'Windsurf'));
    roots.push(utils.joinPath(env.home, '.windsurf'));
  } else if (env.platform === 'darwin') {
    roots.push(utils.joinPath(env.home, 'Library', 'Application Support', 'Windsurf'));
    roots.push(utils.joinPath(env.home, '.windsurf'));
  } else {
    roots.push(utils.joinPath(env.home, '.config', 'Windsurf'));
    roots.push(utils.joinPath(env.home, '.windsurf'));
  }
  return roots;
}

/** @param {any} utils @param {string} path @param {string} extension @returns {Promise<number>} */
async function countFiles(utils, path, extension) {
  let count = 0;
  for (const entry of await utils.readdirSafe(path)) {
    if (entry.isFile() && entry.name.endsWith(extension)) count += 1;
  }
  return count;
}

/**
 * @param {import('../scanner-types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../scanner-types.js').Source[]} */
  const sources = [];
  let installed = false;

  for (const root of appRoots(env, utils)) {
    const rootStat = await utils.statSafe(root);
    if (!rootStat || !rootStat.isDirectory) {
      sources.push({ label: 'Windsurf local data', path: root, exists: false, files: 0, bytes: 0 });
      continue;
    }
    installed = true;
    const stateDbPath = utils.joinPath(root, 'User', 'globalStorage', 'state.vscdb');
    const stateDbStat = await utils.statSafe(stateDbPath);
    if (stateDbStat && stateDbStat.isFile) {
      sources.push({
        label: 'Windsurf VS Code state',
        path: stateDbPath,
        exists: true,
        files: 0,
        bytes: stateDbStat.size,
        note: 'app state/auth/plan metadata only; no token counters',
      });
    }
  }

  const codeiumHome = utils.joinPath(env.home, '.codeium', 'windsurf');
  const codeiumStat = await utils.statSafe(codeiumHome);
  if (codeiumStat && codeiumStat.isDirectory) {
    installed = true;
    const cascadeDir = utils.joinPath(codeiumHome, 'cascade');
    const cascadeStat = await utils.statSafe(cascadeDir);
    if (cascadeStat && cascadeStat.isDirectory) {
      const cascadeFiles = await countFiles(utils, cascadeDir, '.pb');
      sources.push({
        label: 'Windsurf Cascade sessions',
        path: cascadeDir,
        exists: true,
        files: cascadeFiles,
        bytes: 0,
        note: 'encrypted protobuf (.pb) session files; token usage is account-served, not locally readable',
      });
    }
    sources.push({
      label: 'Windsurf agent home',
      path: codeiumHome,
      exists: true,
      files: 0,
      bytes: 0,
      note: 'brain/memories/context_state media; no billable token ledger',
    });
  }

  if (installed) {
    ctx.warn(
      'Windsurf: Cascade sessions are encrypted and usage is served by the Windsurf account; no local token counters are readable',
    );
  }
  return { sources, cells: [] };
}
