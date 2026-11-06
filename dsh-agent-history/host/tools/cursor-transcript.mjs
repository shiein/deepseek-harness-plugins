/**
 * Cursor transcript-read checks. Opening a session runs on the Host thread, so the bubble lookup
 * must be an index SEARCH (not a full scan of a multi-GB state.vscdb), must return exactly the
 * rows the old `LIKE 'bubbleId:<id>:%'` query returned, and must keep their insertion order —
 * bubbles without timestamps are ordered by it.
 *
 *   node host/tools/cursor-transcript.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeScanContext } from '../context.js';
import * as cursor from '../providers/cursor.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-agent-history-cursor-'));
const dbPath = join(root, 'state.vscdb');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
const id = 'c0ffee00-1111-2222-3333-444455556666';
// Inserted out of key order; bubble UUIDs sort opposite to insertion. No timestamps, so the
// transcript order must come from insertion (rowid) order: first, second, third.
put.run(`bubbleId:${id}:zzzz`, JSON.stringify({ type: 1, text: 'first question' }));
put.run(`bubbleId:${id}:mmmm`, JSON.stringify({ type: 2, text: 'second answer' }));
put.run(`bubbleId:${id}:aaaa`, JSON.stringify({ type: 1, text: 'third question' }));
// Neighbours that must not leak in: a prefix-sharing id, another composer, a non-bubble key.
put.run(`bubbleId:${id.slice(0, -1)}:x`, JSON.stringify({ type: 1, text: 'prefix-sharing composer' }));
put.run('bubbleId:d0000000-0000-0000-0000-000000000000:x', JSON.stringify({ type: 1, text: 'other composer' }));
put.run(`composerData:${id}`, JSON.stringify({ name: 'not a bubble' }));

const sql = cursor.__test.BUBBLE_RANGE_SQL;
const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b').map((row) => row.detail).join(' | ');
check('bubble lookup is an index SEARCH', /SEARCH cursorDiskKV USING INDEX/.test(plan), plan);
const legacy = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ? LIMIT 100000').all(`bubbleId:${id}:%`).map((r) => r.key);
const ranged = db.prepare(sql).all(`bubbleId:${id}:`, `bubbleId:${id};`).map((r) => r.key);
check('range returns the same rows in the same order as the old LIKE scan', JSON.stringify(legacy) === JSON.stringify(ranged),
  `${JSON.stringify(legacy)} vs ${JSON.stringify(ranged)}`);
db.close();

const result = await cursor.readMessages(
  makeScanContext({ providerId: 'cursor', config: {}, cache: { get() {}, set() {}, touch() {} }, warnings: [] }),
  { nativeId: id, ref: { files: [dbPath], composerId: id } },
);
const texts = result.messages.map((message) => message.text);
check('transcript keeps insertion order and excludes neighbours',
  JSON.stringify(texts) === JSON.stringify(['first question', 'second answer', 'third question']), JSON.stringify(texts));

await rm(root, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
