/** Phase 0 HMR 请求边界（方案 §6.8、§15.3）：使用真实临时 HTTP 服务，不执行 Vite 或目标项目。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createHmrBoundary } from '../../tools/probes/phase0-hmr-boundary.ts'
import { createResponseLayer } from '../../src/runner/response-layer/server.ts'

test('HMR boundary admits only declared resources and retains the authenticated report channel', async (t) => {
  const layer = createResponseLayer({
    previewId: 'test-hmr', nonce: 'test-only-nonce', allowedHosts: ['127.0.0.1'], csp: {}, frameAncestors: [],
    bootstrapScript: '/*__DSH_PREVIEW_CONFIG__*/ null', onReport() {},
  })
  const passed: string[] = []
  const environmentPath = '/@fs/verified-vite/dist/client/env.mjs'
  const middleware = createHmrBoundary(layer, () => ({ sample: 'hmr' }), environmentPath)
  const server = createServer((req, res) => middleware(req, res, (error) => {
    if (error) { res.writeHead(500); res.end(); return }
    passed.push(req.url ?? '')
    res.end('declared resource')
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  for (const path of ['/', '/@vite/client', '/target.js?t=1', '/style.css', environmentPath]) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
  }
  for (const path of ['/api/unknown', '/@fs/private/file', '/not-a-page']) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { code: 'unmatched_request' })
  }
  assert.equal((await fetch(origin + '/target.js', { method: 'POST' })).status, 405)
  assert.equal((await fetch(origin + '/__dsh_preview/health')).status, 403)
  assert.deepEqual(await fetch(origin + '/phase0/status').then((response) => response.json()), { sample: 'hmr' })
  assert.deepEqual(passed, ['/', '/@vite/client', '/target.js?t=1', '/style.css', environmentPath])
})
