/**
 * Trae / Trae CN history provider — detection only.
 *
 * Trae (ByteDance) and Trae CN are VS Code-derived IDEs whose agent history lives outside
 * state.vscdb, in a per-app SQLite database:
 *   macOS:   ~/Library/Application Support/{Trae,Trae CN,TRAE SOLO}/ModularData/ai-agent/database.db
 *   Windows: %APPDATA%\{Trae,Trae CN,TRAE SOLO}\ModularData\ai-agent\database.db
 *   Linux:   ~/.config/{Trae,Trae CN,TRAE SOLO}/ModularData/ai-agent/database.db
 * (older builds used ModularData/ai-chat/database.db).
 *
 * Verified on this machine (Trae CN): the agent database is NOT plaintext SQLite — the header is
 * opaque and node:sqlite rejects it. Trae encrypts it with SQLCipher, so the conversation history
 * cannot be read without the vendor key. We report the exact database path and skip sessions
 * instead of guessing; a user-supplied plaintext/exported database at the same path is detected
 * too but its chat_turn rows are not converted to sessions by this bundle (detection-only).
 */

import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';

export const meta = {
  id: 'trae',
  name: 'Trae',
  color: '#10b981',
  homepage: 'https://www.trae.ai',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

const APP_DIRS = ['Trae', 'Trae CN', 'TRAE SOLO'];

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function appRoots(env) {
  return APP_DIRS.map((app) => join(env.appData, app));
}

/**
 * Read only the first 16 bytes so a multi-hundred-MB encrypted database is never loaded.
 * @param {string} path
 * @returns {Promise<Buffer|null>}
 */
async function readHeader(path) {
  let handle = null;
  try {
    handle = await openFile(path, 'r');
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}

/** @param {Buffer|null} header @returns {boolean} */
function isPlainSqlite(header) {
  return header !== null && header.toString('latin1').startsWith('SQLite format 3');
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  let installed = false;
  let encrypted = false;
  let plaintext = false;
  let missingDatabase = false;

  for (const root of appRoots(env)) {
    const rootStat = await utils.statSafe(root);
    if (rootStat === null || !rootStat.isDirectory) continue;
    installed = true;

    /** @type {{path: string, size: number}|null} */
    let chosen = null;
    for (const candidate of [join(root, 'ModularData', 'ai-agent', 'database.db'), join(root, 'ModularData', 'ai-chat', 'database.db')]) {
      const stat = await utils.statSafe(candidate);
      if (stat && stat.isFile) {
        chosen = { path: candidate, size: stat.size };
        break;
      }
    }

    if (chosen === null) {
      missingDatabase = true;
      sources.push({
        label: 'Trae agent database',
        path: join(root, 'ModularData', 'ai-agent', 'database.db'),
        exists: false,
        files: 0,
        bytes: 0,
        note: 'Trae installation found but no ModularData/ai-agent/database.db',
      });
      continue;
    }

    const header = await readHeader(chosen.path);
    if (!isPlainSqlite(header)) {
      encrypted = true;
      sources.push({
        label: 'Trae agent database',
        path: chosen.path,
        exists: true,
        files: 0,
        bytes: chosen.size,
        note: 'SQLCipher-encrypted agent database; conversation history is not locally readable without the vendor key',
      });
      continue;
    }

    plaintext = true;
    sources.push({
      label: 'Trae agent database',
      path: chosen.path,
      exists: true,
      files: 0,
      bytes: chosen.size,
      note: 'plaintext SQLite database detected; chat_turn conversations are not parsed (detection-only)',
    });
  }

  if (!installed) {
    sources.push({
      label: 'Trae agent database',
      path: join(appRoots(env)[0], 'ModularData', 'ai-agent', 'database.db'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'Trae / Trae CN is not installed on this machine',
    });
  } else if (encrypted) {
    ctx.warn(
      'Trae: the agent database is SQLCipher-encrypted on this installation, so conversation history is not locally readable (no sessions reported)',
    );
  } else if (plaintext) {
    ctx.warn('Trae: a plaintext agent database was found but this provider is detection-only and reports no sessions');
  } else if (missingDatabase) {
    ctx.warn('Trae: installation found but no agent database (only state.vscdb IDE state is present)');
  }

  return { sources, sessions: [] };
}
