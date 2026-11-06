/** 存储探针的过滤与 HTTP 失败路径（方案 §7.4、§15.3），不把手工 Cookie 请求当作浏览器 SameSite 证据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startStorageProbe } from '../../tools/probes/phase0-storage-server.mjs'

test('storage probe returns only synthetic cookie presence and uses exact CORS origins', async (t) => {
  const probe = await startStorageProbe()
  t.after(() => probe.close())
  const url = probe.origin + probe.base
  const seeded = await fetch(url + 'seed')
  const cookies = seeded.headers.getSetCookie()
  assert.equal(cookies.length, 4)
  assert.ok(cookies.every(cookie => cookie.includes('Path=' + probe.base) && cookie.includes('HttpOnly')))
  assert.ok(cookies.some(cookie => cookie.includes('SameSite=None; Secure')))
  const synthetic = 'dsh_probe_' + probe.runId + '_strict=fixture'
  const response = await fetch(url + 'read', { headers: { Cookie: 'unrelated_private_cookie=do-not-output; ' + synthetic, Origin: probe.otherOrigin } })
  const text = await response.text()
  assert.doesNotMatch(text, /unrelated_private_cookie|do-not-output|fixture/)
  assert.deepEqual(JSON.parse(text).present, { strict: true, lax: false, noneSecure: false, noneInsecure: false })
  assert.equal(response.headers.get('access-control-allow-origin'), probe.otherOrigin)
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
  assert.equal((await fetch(url + 'read', { headers: { Origin: 'https://foreign.invalid' } })).status, 403)
  assert.equal((await fetch(url + 'unknown')).status, 404)
  const cleared = await fetch(url + 'clear')
  assert.ok(cleared.headers.getSetCookie().every(cookie => cookie.startsWith('dsh_probe_' + probe.runId + '_') && cookie.includes('Max-Age=0')))
})

test('storage reports reject unexpected data, oversized bodies and unsupported methods', async (t) => {
  const probe = await startStorageProbe()
  t.after(() => probe.close())
  const url = probe.origin + probe.base + 'report'
  const valid = { case: 'initial', label: 'A', local: null, topLevel: true }
  for (const value of [{ ...valid, local: 'private-data' }, { ...valid, extra: true }, { ...valid, case: 'unknown' }, []]) {
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(value) })).status, 400)
  }
  assert.equal((await fetch(url, { method: 'POST', body: '{' })).status, 400)
  assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(4097) })).status, 413)
  assert.equal((await fetch(url)).status, 405)
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(valid) })).status, 204)
  assert.equal(probe.observations.length, 1)
  assert.equal(probe.observations[0].local, null)
})
