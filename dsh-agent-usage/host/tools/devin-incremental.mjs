/**
 * Devin incremental-scan checks: every incremental result must equal a from-scratch full scan of
 * the same database, and removed rows must force (and report) a full rebuild.
 *
 *   node host/tools/devin-incremental.mjs
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as utils from '../scan-utils.js';
import * as devin from '../providers/devin.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-agent-usage-devin-'));
const dataDir = join(root, 'devin');
const dbPath = join(dataDir, 'cli', 'sessions.db');
await mkdir(join(dataDir, 'cli'), { recursive: true });
process.env.DEVIN_DATA_DIR = dataDir;

const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, chat_message TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO message_nodes (session_id, chat_message) VALUES (?, ?)');
const message = (id, model, ts, metrics, extra = {}) => JSON.stringify({
  message_id: id, metadata: { generation_model: model, started_generation_at: ts, metrics, ...extra },
});
const DAY1 = '2026-06-01T10:00:00.000Z';
const DAY2 = '2026-06-02T10:00:00.000Z';
insert.run('s1', message('m1', 'swe-2', DAY1, { input_tokens: 3, output_tokens: 7, cache_read_tokens: null, cache_creation_tokens: 100 }));
insert.run('s1', JSON.stringify({ message_id: 'u1', metadata: {} })); // user turn: no metrics
insert.run('s2', message('m2', 'sonnet', DAY2, { input_tokens: 1, output_tokens: 2, cache_read_tokens: 5, cache_creation_tokens: 0 }));

/** Persistent cache that mimics ScanCache's provider face. */
function makeCache() {
  const store = new Map();
  return {
    store,
    get: (file, fp) => { const entry = store.get(file); return entry && entry.fp === fp ? entry.cells : undefined; },
    set: (file, fp, cells, state) => store.set(file, { fp, cells, state }),
    peek: (file) => store.get(file),
  };
}

async function scanWith(cache) {
  const warnings = [];
  const env = { ...utils.platformRoots(), config: {} };
  const result = await devin.scan({ providerId: 'devin', signal: new AbortController().signal, env, utils, cache, warn: (m) => warnings.push(m) });
  const source = result.sources.find((item) => item.path === dbPath);
  return { cells: normalise(result.cells), note: source?.note ?? '' };
}

/** Order-independent view of cells (ts bounds excluded: they are not part of the totals). */
function normalise(cells) {
  return cells.map((c) => JSON.stringify([c.model, c.day, c.input, c.output, c.cacheRead, c.cacheWrite, c.messages])).sort();
}
const fresh = () => scanWith(makeCache());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const cache = makeCache();
const first = await scanWith(cache);
check('first scan is a full rebuild', first.note.includes('full rebuild (no previous state)'), first.note);
check('first scan totals are deduplicated', same(first.cells, (await fresh()).cells), JSON.stringify(first.cells));

// Unchanged database: cache hit, no SQLite work.
const unchanged = await scanWith(cache);
check('unchanged database is served from cache', unchanged.note.includes('unchanged since last scan'), unchanged.note);

// Append: a new message, a re-stored copy of m1 with a larger counter, a row without metrics.
insert.run('s1', message('m1', 'swe-2', DAY1, { input_tokens: 3, output_tokens: 9, cache_read_tokens: 2, cache_creation_tokens: 100 }, { extensions: { x: 1 } }));
insert.run('s3', message('m3', 'sonnet', DAY2, { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 }));
insert.run('s3', JSON.stringify({ message_id: 'u2', metadata: {} }));
const appended = await scanWith(cache);
check('append is read incrementally', appended.note.includes('incremental: 2 new message(s)'), appended.note);
check('incremental append equals a full scan', same(appended.cells, (await fresh()).cells),
  `${JSON.stringify(appended.cells)}\n      vs ${JSON.stringify((await fresh()).cells)}`);

// Fingerprint changes without new rows (e.g. a WAL checkpoint): incremental with nothing to fold.
cache.store.get(dbPath).fp = 'stale';
const touched = await scanWith(cache);
check('fingerprint change without new rows folds nothing', touched.note.includes('incremental: 0 new message(s)'), touched.note);
check('…and keeps the same totals', same(touched.cells, appended.cells));

// Removing an old row (deleted session) must force a full rebuild with the row gone.
db.exec("DELETE FROM message_nodes WHERE session_id = 's2'");
insert.run('s4', message('m4', 'swe-2', DAY2, { input_tokens: 4, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 }));
const removed = await scanWith(cache);
check('removed rows force a full rebuild', removed.note.includes('full rebuild (rows below the watermark were removed)'), removed.note);
check('full rebuild drops the removed session', same(removed.cells, (await fresh()).cells) && !removed.cells.some((c) => c.includes('"sonnet","2026-06-02",1,')),
  JSON.stringify(removed.cells));

// A state from an incompatible format is ignored, not trusted.
cache.store.get(dbPath).fp = 'stale';
cache.store.get(dbPath).state = { format: 99 };
const foreign = await scanWith(cache);
check('foreign state format triggers a full rebuild', foreign.note.includes('full rebuild (no previous state)'), foreign.note);

// A query failure propagates (provider error) instead of caching an empty result.
db.exec('ALTER TABLE message_nodes RENAME TO renamed_nodes');
cache.store.get(dbPath).fp = 'stale';
const before = cache.store.get(dbPath);
let threw = false;
try {
  await scanWith(cache);
} catch {
  threw = true;
}
check('query failure throws and leaves the cache untouched', threw && cache.store.get(dbPath) === before);

db.close();
await rm(root, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
