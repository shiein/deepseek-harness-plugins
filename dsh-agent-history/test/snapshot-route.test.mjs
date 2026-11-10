import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../index.js';

test('the snapshot route skips the body when the Client holds the same content', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ah-snap-'));
  try {
    const saved = { format: 1, scannedAt: 5, durationMs: 1, agents: [], sessions: [{ id: 'a:1', updatedAt: 2, messages: 3, title: 't' }], totals: {} };
    await writeFile(join(dataDir, 'last-scan.json'), JSON.stringify(saved));
    const routes = new Map();
    apply({ webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } }, effect: (fn) => { fn(); } }, { dataDir });
    const get = async (query) => {
      const request = { method: 'GET', url: `/api/dsh-agent-history/snapshot${query}`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } };
      let body = '';
      const response = new EventEmitter();
      response.writeHead = () => {};
      response.end = (text) => { body = text; };
      await routes.get('/api/dsh-agent-history/snapshot')(request, response);
      return JSON.parse(body);
    };
    const first = await get('');
    assert.equal(typeof first.snapshot.signature, 'string', 'an older snapshot gets a signature');
    const again = await get(`?since=${encodeURIComponent(first.snapshot.signature)}`);
    assert.deepEqual(again, { ok: true, scanning: false, dataDir, unchanged: true, signature: first.snapshot.signature, scannedAt: 5, durationMs: 1 });
    assert.ok((await get('?since=other')).snapshot, 'a different signature gets the full snapshot');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
