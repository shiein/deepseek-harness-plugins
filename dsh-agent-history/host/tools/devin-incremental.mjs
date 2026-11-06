/**
 * Devin history incremental-preview checks: every incremental scan must equal a from-scratch scan
 * of the same database, only sessions whose rows changed may re-read previews, and a failed
 * preview lookup must be retried on the next scan instead of being remembered.
 *
 *   node host/tools/devin-incremental.mjs
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeScanContext } from '../context.js';
import * as devin from '../providers/devin.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-agent-history-devin-'));
const dataDir = join(root, 'devin');
const dbPath = join(dataDir, 'cli', 'sessions.db');
await mkdir(join(dataDir, 'cli'), { recursive: true });
process.env.DEVIN_DATA_DIR = dataDir;

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER,
    last_activity_at INTEGER, model TEXT, agent_mode TEXT, main_chain_id INTEGER, hidden INTEGER DEFAULT 0);
  CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
  CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, timestamp INTEGER, session_id TEXT);
`);
const addSession = db.prepare('INSERT INTO sessions (id, working_directory, title, created_at, last_activity_at, model, agent_mode, main_chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const addNode = db.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)');
const msg = (role, content) => JSON.stringify({ message_id: `${role}-${Math.random()}`, role, content });
const T0 = 1780000000000;
let node = 0;
for (const id of ['a', 'b', 'c']) {
  addSession.run(id, `/work/${id}`, 'untitled', T0, T0 + 1000, 'swe-2', 'code', 0);
  addNode.run(id, ++node, null, msg('user', `please fix ${id}`), T0);
  addNode.run(id, ++node, node - 1, msg('assistant', `fixed ${id}`), T0 + 10);
}

function makeCache() {
  const store = new Map();
  return {
    store,
    get: (file, fp) => { const entry = store.get(file); return entry && entry.fp === fp ? entry.sessions : undefined; },
    set: (file, fp, sessions, state) => store.set(file, { fp, sessions, state }),
    peek: (file) => store.get(file),
    touch() {},
  };
}
async function scanWith(cache) {
  const warnings = [];
  const result = await devin.scan(makeScanContext({ providerId: 'devin', config: {}, cache, warnings }));
  const source = result.sources.find((item) => item.path === dbPath);
  const sessions = result.sessions.map((s) => ({ ...s })).sort((x, y) => (x.nativeId < y.nativeId ? -1 : 1));
  return { sessions, json: JSON.stringify(sessions), note: source?.note ?? '', warnings };
}
const fresh = () => scanWith(makeCache());
const stale = (cache) => { for (const entry of cache.store.values()) entry.fp = 'stale'; };
const byId = (result, id) => result.sessions.find((s) => s.nativeId === id);

const cache = makeCache();
const first = await scanWith(cache);
check('first scan reads every preview', first.note.includes('previews: 0 reused, 3 re-read'), first.note);
check('first scan derives title and previews', byId(first, 'a')?.title === 'please fix a' && byId(first, 'a')?.lastPreview === 'fixed a',
  JSON.stringify(byId(first, 'a')));

const hit = await scanWith(cache);
check('unchanged database is served from cache', hit.note.includes('unchanged since last scan'), hit.note);

// Append to one session: only that session re-reads, and its last preview moves.
addNode.run('a', ++node, node - 1, msg('assistant', 'and added a test'), T0 + 20);
stale(cache);
const appended = await scanWith(cache);
check('append re-reads only the changed session', appended.note.includes('previews: 2 reused, 1 re-read'), appended.note);
check('changed session picks up the new last preview', byId(appended, 'a')?.lastPreview === 'and added a test', byId(appended, 'a')?.lastPreview);
check('incremental result equals a full scan', appended.json === (await fresh()).json);

// Fingerprint change without row changes (WAL checkpoint): everything reused, same result.
stale(cache);
const touched = await scanWith(cache);
check('fingerprint change alone reuses every preview', touched.note.includes('previews: 3 reused, 0 re-read'), touched.note);
check('…and keeps the same result', touched.json === appended.json);

// Removing a session drops it and its stored preview.
db.exec("DELETE FROM message_nodes WHERE session_id = 'b'; DELETE FROM sessions WHERE id = 'b'");
stale(cache);
const removed = await scanWith(cache);
check('removed session disappears', byId(removed, 'b') === undefined && removed.json === (await fresh()).json, removed.json);
check('removed session leaves no stored preview', !Object.hasOwn(cache.store.get(dbPath).state.sessions, 'b'));

// A malformed row makes the preview lookup fail: shown empty, not remembered, retried next scan.
addNode.run('c', ++node, node - 1, 'not json', T0 + 30);
stale(cache);
const broken = await scanWith(cache);
check('failed lookup is not remembered', !Object.hasOwn(cache.store.get(dbPath).state.sessions, 'c'), JSON.stringify(cache.store.get(dbPath).state));
stale(cache);
const retried = await scanWith(cache);
check('failed lookup is retried on the next scan', retried.note.includes('1 re-read') && broken.note.includes('1 re-read'), `${broken.note} | ${retried.note}`);

// A foreign state format is ignored.
stale(cache);
cache.store.get(dbPath).state = { format: 99, sessions: { a: { sig: 'x' } } };
const foreign = await scanWith(cache);
check('foreign state format re-reads every preview', foreign.note.includes('0 reused'), foreign.note);

db.close();
await rm(root, { recursive: true, force: true });

// Regression: providers choose their calling convention from `cache.set.length` / `cache.get.length`
// (gemini-cli, opencode, codex, cursor, …). Adding the resume `state` must not change that arity,
// or every one of them silently writes under the wrong key and never hits its cache again.
{
  const { cacheFace } = await import('../scanner.js');
  const { HistoryCache } = await import('../cache.js');
  const face = cacheFace(new HistoryCache({ filePath: join(tmpdir(), 'unused.json'), providerVersions: { p: 1 } }), 'p');
  checks += 1;
  const ok = face.get.length === 2 && face.set.length === 3;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  cache face keeps get/set arity 2/3 (got ${face.get.length}/${face.set.length})`);
  face.set('/f', 'fp1', [{ id: 1 }], { s: 1 });
  checks += 1;
  const roundTrip = face.get('/f', 'fp1')?.[0]?.id === 1 && face.peek('/f')?.state?.s === 1;
  if (!roundTrip) failures += 1;
  console.log(`${roundTrip ? 'PASS' : 'FAIL'}  cache face stores rows and resume state under the file key`);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exitCode = failures === 0 ? 0 : 1;
}
