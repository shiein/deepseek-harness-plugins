/**
 * A provider whose read fails this scan must not erase the numbers its last successful scan showed:
 * the scanner falls back to the cached cells and reports the agent as `stale`.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, test } from 'node:test';

import { ScanCache } from '../host/scan-cache.js';
import { loadProviders } from '../host/providers/index.js';
import { runScan } from '../host/scanner.js';

/** Provider roots are read from the environment, so every test gets its own fake user profile. */
const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'DSH_HOME',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'GEMINI_DIR', 'WORKBUDDY_HOME', 'GROK_HOME', 'OPENCODE_DATA_DIR', 'DEVIN_DATA_DIR',
];
const root = mkdtempSync(join(tmpdir(), 'agent-usage-stale-'));
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Isolate the process from this machine's real agent data and return the fake roots. */
function isolatedProfile(name) {
  const base = join(root, name);
  const home = join(base, 'home');
  const appData = join(base, 'appdata');
  const localAppData = join(base, 'localappdata');
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = localAppData;
  process.env.XDG_DATA_HOME = join(home, '.local', 'share');
  process.env.DSH_HOME = join(home, '.dsh');
  for (const key of ENV_KEYS) {
    if (key !== 'HOME' && key !== 'USERPROFILE' && key !== 'APPDATA' && key !== 'LOCALAPPDATA' && key !== 'XDG_DATA_HOME' && key !== 'DSH_HOME') delete process.env[key];
  }
  return { base, home, appData, localAppData };
}

/** Where the Devin provider looks for the CLI database on this platform. */
function devinDatabasePath(roots) {
  if (process.platform === 'win32') return join(roots.appData, 'devin', 'cli', 'sessions.db');
  if (process.platform === 'darwin') return join(roots.home, '.local', 'share', 'devin', 'cli', 'sessions.db');
  return join(roots.home, '.local', 'share', 'devin', 'cli', 'sessions.db');
}

/** A store that cannot be opened: an existing file whose bytes are not a SQLite database. */
function writeUnreadableDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'this is not a SQLite database, just bytes the reader cannot parse\n');
}

async function seedCache(dataDir, providerId, filePath, cells) {
  const providers = await loadProviders();
  const providerVersions = Object.fromEntries(providers.map((provider) => [provider.meta.id, provider.meta.cacheVersion ?? 1]));
  const file = join(dataDir, 'scan-cache.json');
  const cache = new ScanCache({ filePath: file, providerVersions });
  cache.set(providerId, filePath, 'fingerprint-of-an-older-scan', cells);
  await cache.save();
  return file;
}

test('a provider whose store cannot be read is served from the cache, marked stale', async () => {
  const roots = isolatedProfile('stale');
  const dataDir = join(roots.base, 'data');
  const dbPath = devinDatabasePath(roots);
  writeUnreadableDatabase(dbPath);
  const cacheFile = await seedCache(dataDir, 'devin', dbPath, [
    { model: 'swe-2', day: '2026-06-01', input: 100, output: 50, cacheRead: 0, cacheWrite: 10, messages: 1 },
  ]);

  const snapshot = await runScan({ dataDir });
  const agent = snapshot.agents.find((entry) => entry.id === 'devin');
  assert.equal(agent.status, 'stale', JSON.stringify(agent));
  assert.equal(agent.tokens, 160, JSON.stringify(agent));
  assert.equal(agent.cells, 1);
  assert.match(agent.error, /sessions\.db/, 'the error names the failing store');
  assert.ok(agent.sources.some((source) => source.exists && source.path === dbPath), JSON.stringify(agent.sources));
  assert.ok(snapshot.cells.some((tuple) => tuple[0] === 'devin' && tuple[3] === 100 && tuple[4] === 50), JSON.stringify(snapshot.cells));

  // The fallback cells themselves must survive the scan: the next transient failure reuses them.
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.ok(saved.providers.devin.files[dbPath], 'cache entry for the failed provider is kept');
});

test('a provider that never succeeded still reports an error, not stale data', async () => {
  const roots = isolatedProfile('error');
  const dataDir = join(roots.base, 'data');
  writeUnreadableDatabase(devinDatabasePath(roots));

  const snapshot = await runScan({ dataDir });
  const agent = snapshot.agents.find((entry) => entry.id === 'devin');
  assert.equal(agent.status, 'error', JSON.stringify(agent));
  assert.equal(agent.cells, 0);
  assert.equal(agent.tokens, 0);
  assert.ok(agent.error);
  assert.ok(!snapshot.cells.some((tuple) => tuple[0] === 'devin'), 'no invented rows');
});
