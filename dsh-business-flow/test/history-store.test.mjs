/**
 * Saving history never destroys records it cannot read, and reports why a write failed.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'business-flow-store-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, '.dsh');
const dir = join(home, '.dsh', 'business-flow');
const file = join(dir, 'history.json');
const entry = (id) => ({ id, projectPath: '/p', at: 1, graph: { nodes: [{ id: 'n' }], edges: [] } });
const future = { id: 'future', format: 2, graphV2: { nodes: [] } };

const { apply } = await import('../index.js');
const routes = new Map();
apply({
  get: () => undefined,
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  effect: (fn) => fn(),
  logger: { warn() {} },
});

async function post(path, body) {
  const request = new EventEmitter();
  request.method = 'POST';
  request.socket = { remoteAddress: '127.0.0.1' };
  request.headers = { host: '127.0.0.1:3080' };
  request[Symbol.asyncIterator] = async function* chunks() { yield Buffer.from(JSON.stringify(body)); };
  let status = 0;
  let text = '';
  const response = new EventEmitter();
  response.writeHead = (code) => { status = code; return response; };
  response.end = (chunk) => { text = String(chunk ?? ''); };
  await routes.get(`/api/dsh-business-flow${path}`)(request, response);
  return { status, body: JSON.parse(text) };
}

const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));

test('a record the current code cannot read survives saves but not clear-all', async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify([entry('a'), future]));
  const saved = await post('/history/upsert', { entry: entry('b') });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.entries.map((item) => item.id).sort(), ['a', 'b'], 'hidden from the page');
  assert.deepEqual(onDisk().find((item) => item.id === 'future'), future, 'kept on disk');
  await post('/history/delete', { ids: ['a'] });
  assert.ok(onDisk().some((item) => item.id === 'future'));
  await post('/history/clear', {});
  assert.deepEqual(onDisk(), []);
});

test('a failed write reports its cause', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  writeFileSync(file, '[]');
  chmodSync(dir, 0o555);
  try {
    const result = await post('/history/upsert', { entry: entry('c') });
    assert.equal(result.status, 500);
    assert.match(result.body.error.message, /cannot write the history file: .*EACCES/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('concurrent saves keep every record', async () => {
  writeFileSync(file, '[]');
  const results = await Promise.all(['x1', 'x2', 'x3', 'x4'].map((id) => post('/history/upsert', { entry: entry(id) })));
  assert.ok(results.every((result) => result.status === 200));
  assert.deepEqual(onDisk().map((item) => item.id).sort(), ['x1', 'x2', 'x3', 'x4']);
});
