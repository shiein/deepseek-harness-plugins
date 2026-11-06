/** 非 Vite 样本的真实 HTTP 边界（方案 §14、§15.3），仅启动一次可丢弃 loopback 服务。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { get } from 'node:http'
import { startDemo } from '../fixtures/non-vite-existing-server/server.mjs'

test('non-Vite sample preserves its own routes and rejects undeclared requests', async (t) => {
  const { server, origin } = await startDemo()
  t.after(() => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())))
  const before = await fetch(origin + '/health').then((response) => response.json())
  assert.equal(before.sample, 'non-vite-orders')
  assert.equal(before.documentRequests, 0)
  const page = await fetch(origin + '/orders/DEMO-101')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-security-policy'), null)
  const html = await page.text()
  assert.match(html, /type="module" src="\/app.js"/)
  assert.doesNotMatch(html, /__DSH_PREVIEW|__dsh_preview/)
  assert.equal((await fetch(origin + '/app.js')).status, 200)
  const data = await fetch(origin + '/api/orders').then((response) => response.json())
  assert.equal(data.orders.length, 3)
  const unknown = await fetch(origin + '/api/unregistered')
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { code: 'unmatched_request' })
  assert.equal((await fetch(origin + '/api/orders', { method: 'POST' })).status, 405)
  const foreignStatus = await new Promise((accept, reject) => {
    get(origin + '/health', { headers: { Host: 'foreign.invalid' } }, (response) => {
      response.resume(); accept(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(foreignStatus, 403)
  const after = await fetch(origin + '/health').then((response) => response.json())
  assert.equal(after.documentRequests, 1)
  assert.equal(after.apiRequests, 1)
  assert.equal(after.startedAt, before.startedAt)
  assert.equal(after.pid, before.pid)
})
