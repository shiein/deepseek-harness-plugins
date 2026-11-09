/**
 * A store whose queries fail is reported as an error, not as an empty store.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

import { makeScanContext } from '../host/context.js';
import { runScan } from '../host/scanner.js';

const root = mkdtempSync(join(tmpdir(), 'agent-history-status-'));
const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
after(() => {
  process.env.HOME = saved.HOME;
  if (saved.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('a failed query warns once and still reads as no rows', () => {
  const warnings = [];
  const context = makeScanContext({ providerId: 'x', cache: {}, warnings });
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(context.utils.querySqlite(db, 'SELECT * FROM missing'), []);
  assert.deepEqual(context.utils.querySqlite(db, 'SELECT * FROM missing'), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SQLite query failed: no such table/);
  assert.deepEqual(context.queryFailures, warnings);
  assert.equal(context.utils.querySqlite(db, 'SELECT 1 AS one')[0].one, 1);
  db.close();
});

test('a database with an unexpected schema is an error, not "empty"', { skip: process.platform === 'win32' }, async () => {
  const home = join(root, 'home');
  const data = join(home, '.local', 'share');
  mkdirSync(join(data, 'opencode'), { recursive: true });
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = data;
  const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
  db.exec('CREATE TABLE session (unexpected TEXT); CREATE TABLE message (unexpected TEXT); CREATE TABLE part (unexpected TEXT);');
  db.close();
  const snapshot = await runScan({ dataDir: join(root, 'data') });
  const agent = snapshot.agents.find((entry) => entry.id === 'opencode');
  assert.equal(agent.status, 'error', JSON.stringify(agent));
  assert.match(agent.error, /SQLite query failed/);
});
