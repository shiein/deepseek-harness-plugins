/**
 * Qoder history provider — detection only.
 *
 * Qoder (and Qoder CN) keep agent data in a shared client cache database:
 *   macOS:   ~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db
 *   Windows: %APPDATA%\Qoder\SharedClientCache\cache\db\local.db
 *   Linux:   ~/.config/Qoder/SharedClientCache/cache/db/local.db
 * (the same layout exists for "Qoder CN").
 *
 * The local database holds assistant token_info for usage accounting, but the conversation
 * history itself is served from Qoder's account/cloud service. Detection only: the database is
 * reported with its exact path and no session is invented from token counters.
 */

import { join } from 'node:path';

export const meta = {
  id: 'qoder',
  name: 'Qoder',
  color: '#6366f1',
  homepage: 'https://qoder.com',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

const APP_DIRS = ['Qoder', 'Qoder CN'];

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  let installed = false;
  let foundDatabase = false;

  for (const app of APP_DIRS) {
    const root = join(env.appData, app);
    const rootStat = await utils.statSafe(root);
    if (rootStat === null || !rootStat.isDirectory) continue;
    installed = true;
    const dbPath = join(root, 'SharedClientCache', 'cache', 'db', 'local.db');
    const dbStat = await utils.statSafe(dbPath);
    if (dbStat && dbStat.isFile) {
      foundDatabase = true;
      sources.push({
        label: 'Qoder agent cache',
        path: dbPath,
        exists: true,
        files: 1,
        bytes: dbStat.size,
        note: 'local.db holds token/account cache; conversation history is served from Qoder’s account service',
      });
    } else {
      sources.push({
        label: 'Qoder agent cache',
        path: dbPath,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Qoder installation found but no SharedClientCache/cache/db/local.db',
      });
    }
  }

  if (!installed) {
    sources.push({
      label: 'Qoder agent cache',
      path: join(env.appData, APP_DIRS[0], 'SharedClientCache', 'cache', 'db', 'local.db'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Qoder / Qoder CN is not installed on this machine',
    });
  } else if (foundDatabase) {
    ctx.warn(
      'Qoder: conversation history is served from Qoder’s cloud account; the local database only contains token/account cache, so no local sessions are reported',
    );
  }

  return { sources, sessions: [] };
}
