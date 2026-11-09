/**
 * The loopback fence and the price table's prefix fallback.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../index.js';
import { PRICES, priceFor } from '../host/pricing.js';

const root = mkdtempSync(join(tmpdir(), 'agent-usage-security-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the loopback fence accepts only this server as the request source', async () => {
  const routes = new Map();
  apply({
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
    effect: (fn) => { fn(); },
  }, { dataDir: root });
  const statusFor = async (headers, method = 'GET') => {
    const request = { method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', ...headers } };
    let status = 0;
    const response = new EventEmitter();
    response.writeHead = (code) => { status = code; };
    response.end = () => {};
    await routes.get('/api/dsh-agent-usage/health')(request, response);
    return status;
  };
  assert.equal(await statusFor({}), 200);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:3080' }), 200);
  assert.equal(await statusFor({ host: '127.0.0.1.evil.example' }), 403);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:5173' }), 403);
  assert.equal(await statusFor({ 'content-type': 'text/plain' }, 'POST'), 403);
  assert.equal(await statusFor({}, 'POST'), 405, 'a bodyless POST (the Client scan) passes the fence');
});

test('a named suffix keeps its family price', () => {
  assert.equal(priceFor('claude-opus-5-5-medium'), PRICES['claude-opus-5-5']);
  assert.equal(priceFor('claude-opus-4-6-thinking'), PRICES['claude-opus-4-6']);
  assert.equal(priceFor('gemini-3.8-flash-exp-a'), PRICES['gemini-3.8-flash']);
});

test('another version is unpriced instead of borrowing an older price', () => {
  for (const model of ['gpt-5.7', 'gpt-5.9-pro', 'claude-opus-4-9', 'claude-sonnet-5-6', 'grok-4.8', 'glm-5.9']) {
    assert.equal(priceFor(model), null, model);
  }
});
