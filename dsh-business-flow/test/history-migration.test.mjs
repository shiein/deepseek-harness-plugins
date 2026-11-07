/**
 * The pre-rename history (`~/.dsh/bizflow/history.json`) moves to `$DSH_HOME/business-flow/` on first
 * read, and never overwrites an existing new-location file.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'business-flow-home-'));
after(() => rmSync(home, { recursive: true, force: true }));
// HISTORY_FILE is resolved at import time: point HOME / DSH_HOME at the sandbox first.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, '.dsh');
const legacy = join(home, '.dsh', 'bizflow', 'history.json');
const current = join(home, '.dsh', 'business-flow', 'history.json');
const entry = (id) => ({ id, projectPath: '/p', at: 1, graph: { nodes: [{ id: 'n' }], edges: [] } });

const { apply } = await import('../index.js');
const routes = new Map();
apply({
  get: () => undefined,
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  effect: (fn) => fn(),
  logger: { warn() {} },
});

async function getHistory() {
  const request = new EventEmitter();
  request.method = 'GET';
  request.socket = { remoteAddress: '127.0.0.1' };
  request.headers = { host: '127.0.0.1:3080' };
  let status = 0;
  let text = '';
  const response = new EventEmitter();
  response.writeHead = (code) => { status = code; return response; };
  response.end = (chunk) => { text = String(chunk ?? ''); response.writableFinished = true; };
  await routes.get('/api/dsh-business-flow/history')(request, response);
  return { status, body: JSON.parse(text) };
}

test('legacy history moves to the new location once', async () => {
  mkdirSync(join(home, '.dsh', 'bizflow'), { recursive: true });
  writeFileSync(legacy, JSON.stringify([entry('old-1')]));
  const first = await getHistory();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.entries.map((item) => item.id), ['old-1']);
  assert.ok(existsSync(current) && !existsSync(legacy));

  // A legacy file that reappears later never overwrites the new history.
  writeFileSync(legacy, JSON.stringify([entry('stale')]));
  const second = await getHistory();
  assert.deepEqual(second.body.entries.map((item) => item.id), ['old-1']);
  assert.deepEqual(JSON.parse(readFileSync(current, 'utf8')).map((item) => item.id), ['old-1']);
});
