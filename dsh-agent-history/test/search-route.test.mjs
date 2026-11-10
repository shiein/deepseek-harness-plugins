import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../index.js';

test('search matches titles, previews and folders of every session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ah-search-'));
  const disposers = [];
  try {
    const session = (id, extra) => ({ id, agentId: 'nobody', nativeId: id, title: 't', preview: '', lastPreview: '', projectPath: '/p', startedAt: 1, updatedAt: 2, messages: 0, ...extra });
    const saved = { format: 1, scannedAt: 5, durationMs: 1, agents: [], totals: {}, sessions: [
      session('a:1', { title: 'Fix the Login page' }),
      session('a:2', { preview: 'please refactor login flow' }),
      session('a:3', { projectPath: '/work/login-service' }),
      session('a:4', { title: 'unrelated' }),
    ] };
    await writeFile(join(dataDir, 'last-scan.json'), JSON.stringify(saved));
    const routes = new Map();
    apply({ webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } }, effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); } }, { dataDir });
    const get = async (q) => {
      const request = { method: 'GET', url: `/api/dsh-agent-history/search?q=${encodeURIComponent(q)}`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } };
      let body = '';
      const response = new EventEmitter();
      response.writeHead = () => {};
      response.end = (text) => { body = text; };
      await routes.get('/api/dsh-agent-history/search')(request, response);
      return JSON.parse(body);
    };
    const found = await get('LOGIN');
    assert.deepEqual(found.hits.map((hit) => `${hit.sessionId}:${hit.where}`).sort(), ['a:1:title', 'a:2:preview', 'a:3:folder']);
    assert.match(found.hits.find((hit) => hit.sessionId === 'a:2').snippet, /refactor login flow/);
    assert.deepEqual((await get('x')).hits, [], 'one character is not searched');
  } finally {
    for (const dispose of disposers) dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
