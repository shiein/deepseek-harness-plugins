/** 同源 HTTP Mock 中间件（方案 §7.2、§7.3、§15.3）；真实本地请求、自有内存存储，无项目 import 或后端转发。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as rawRequest } from 'node:http'
import { createMockMiddleware } from '../../src/scenario/mock-middleware.ts'
import type { MockMiddlewareOptions } from '../../src/scenario/mock-middleware.ts'
import { ScenarioStore } from '../../src/scenario/store.ts'
import type { Diagnostic } from '../../src/shared/contracts.ts'

async function server(t: { after(callback: () => Promise<void>): void }, configure: Partial<MockMiddlewareOptions> = {}) {
  const unmatched: Array<{ method: string; url: string }> = []
  const diagnostics: Diagnostic[] = []
  const errors: unknown[] = []
  let forwarded = 0
  const store = new ScenarioStore('own-test')
  let middleware: ReturnType<typeof createMockMiddleware>
  const http = createServer((req, res) => middleware(req, res, error => {
    if (error) { errors.push(error); res.writeHead(500); res.end('Mock failed'); return }
    forwarded++; res.writeHead(418); res.end('resource-handler')
  }))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  middleware = createMockMiddleware({ previewOrigin: origin, businessPaths: ['/api/**'], store, onUnmatched: value => unmatched.push(value), onDiagnostic: value => diagnostics.push(value), ...configure })
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  const request = (path: string, options: RequestInit = {}) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(3000) })
  return { origin, request, unmatched, diagnostics, errors, store, forwarded: () => forwarded }
}

test('fixture responses preserve JSON/text/status/headers, consume exact body/query and leave resource requests untouched', async t => {
  const f = await server(t, { fixtures: [
    { method: 'POST', path: '/api/users/:id', query: { mode: 'preview' }, body: { enabled: true }, response: { status: 201, headers: { 'X-Fixture': 'yes' }, body: { saved: true } } },
    { method: 'GET', path: '/api/text', response: { status: 200, body: 'Fixture text' } },
    { method: 'HEAD', path: '/api/head', response: { status: 200, body: 'not sent' } },
    { method: 'DELETE', path: '/api/empty', response: { status: 204 } },
  ] })
  const response = await f.request('/api/users/42?mode=preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-fixture'), 'yes')
  assert.deepEqual(await response.json(), { saved: true })
  assert.equal(f.diagnostics[0]?.code, 'unsupported_capability')
  assert.equal(f.store.get('users'), undefined)
  assert.equal(await (await f.request('/api/text')).text(), 'Fixture text')
  assert.equal(await (await f.request('/api/head', { method: 'HEAD' })).text(), '')
  assert.equal((await f.request('/api/empty', { method: 'DELETE' })).status, 204)
  assert.equal((await f.request('/src/Target.vue')).status, 418)
  assert.equal(f.forwarded(), 1)
  assert.equal(f.errors.length, 0)
})

test('unmatched business requests and fixture ambiguity never reach the resource handler or real network', async t => {
  const network = t.mock.method(globalThis, 'fetch', globalThis.fetch)
  const f = await server(t, { fixtures: [
    { method: 'GET', path: '/api/users/:id', response: { status: 200, body: 1 } },
    { method: 'GET', path: '/api/users/admin', response: { status: 200, body: 2 } },
  ] })
  assert.equal((await f.request('/api/users/admin')).status, 409)
  assert.equal(f.diagnostics[0]?.code, 'config_invalid')
  const unknown = await f.request('/api/missing?token=DO_NOT_REPORT_QUERY')
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { code: 'unmatched_request' })
  // R3-1：query 键名（'token'）上抛供未命中汇总；值 'DO_NOT_REPORT_QUERY' 仍不得出现（deepEqual 会暴露它）。
  assert.deepEqual(f.unmatched, [{ method: 'GET', url: '/api/missing', queryKeys: ['token'] }])
  assert.equal(f.forwarded(), 0)
  assert.equal(network.mock.callCount(), 2, 'Only these explicit test client fetches may occur')
})

test('request body and duplicate-query failures remain explicit and do not invoke handlers', async t => {
  let calls = 0
  const f = await server(t, { maxBodyBytes: 32, handlers: [() => { calls++; return { status: 200 } }] })
  assert.equal((await f.request('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400)
  assert.equal((await f.request('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify('x'.repeat(40)) })).status, 413)
  assert.equal((await f.request('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status, 415)
  assert.equal((await f.request('/api/data?a=1&a=2')).status, 400)
  assert.equal((await f.request('/api/%E0%A4')).status, 400)
  assert.equal(calls, 0)
  assert.equal(f.forwarded(), 0)
  assert.equal(f.errors.length, 0)
  const streamed = await new Promise<number>((resolve, reject) => {
    const req = rawRequest(f.origin + '/api/data', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)) })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('Streaming body test timeout')))
    req.write('x'.repeat(64))
    setTimeout(() => req.end('tail'), 20)
  })
  assert.equal(streamed, 413)
})

test('explicit handlers own store semantics, fixture matches precede them, and errors propagate without response details', async t => {
  const f = await server(t, { fixtures: [{ method: 'GET', path: '/api/fixed', response: { status: 200, body: { fixed: true } } }], handlers: [
    () => undefined,
    (request, store) => {
      if (request.path === '/api/fail') throw new Error('PRIVATE_HANDLER_FAILURE')
      if (request.path === '/api/value' && request.method === 'POST') { store.set('value', request.body); return { status: 202, body: 'stored' } }
      if (request.path === '/api/value') return { status: 200, body: store.get('value') ?? null }
      return undefined
    },
  ] })
  assert.deepEqual(await (await f.request('/api/fixed')).json(), { fixed: true })
  assert.equal((await f.request('/api/value', { method: 'POST', headers: { 'Content-Type': 'application/problem+json' }, body: '{"value":42}' })).status, 202)
  assert.deepEqual(await (await f.request('/api/value')).json(), { value: 42 })
  f.store.reset()
  assert.equal(await (await f.request('/api/value')).json(), null)
  const failed = await f.request('/api/fail')
  assert.equal(failed.status, 500)
  assert.equal(await failed.text(), 'Mock failed')
  assert.equal(f.errors.length, 1)
  assert.equal(f.forwarded(), 0)
})

test('scoped response files and explicit whole-segment globs do not turn all same-origin requests into business data', async t => {
  const files: string[] = []
  const f = await server(t, { businessPaths: ['/api/*', '/数据/**'], fixtures: [{ method: 'GET', path: '/api/file', response: { status: 200, bodyFile: 'fixtures/bytes.bin' } }], readBodyFile: async file => { files.push(file); return Uint8Array.from([1, 2, 3]) } })
  assert.deepEqual([...new Uint8Array(await (await f.request('/api/file')).arrayBuffer())], [1, 2, 3])
  assert.deepEqual(files, ['fixtures/bytes.bin'])
  assert.equal((await f.request('/api/nested/asset.js')).status, 418)
  assert.equal((await f.request('/api/')).status, 418)
  assert.equal((await f.request('/数据/missing')).status, 404)
  assert.equal(f.forwarded(), 2)
})

test('invalid patterns, response shapes and missing scoped file readers fail before any service is created', () => {
  const options = { previewOrigin: 'http://127.0.0.1:1234', businessPaths: ['/api/**'], store: new ScenarioStore('test'), onUnmatched() {}, onDiagnostic() {} }
  for (const pattern of ['/api/**/other', '/api/pre*', 'api', '//other/api']) assert.throws(() => createMockMiddleware({ ...options, businessPaths: [pattern] }))
  for (const response of [{ status: 100 }, { status: 204, body: {} }, { status: 200, body: {}, bodyFile: 'file.json' }, { status: 200, headers: { 'Content-Length': '0' } }, { status: 200, headers: { 'Content-Security-Policy': 'default-src *' } }, { status: 200, bodyFile: 'file.json' }]) assert.throws(() => createMockMiddleware({ ...options, fixtures: [{ method: 'GET', path: '/api/test', response }] }))
})

test('cross-origin requests arrive only via the owned remote channel and match fixtures by origin', async t => {
  // 2026-11-03（§0.3 第 10 条）：bootstrap 把跨源 fetch/XHR 改写到 /__dsh_preview/remote/<origin>/…；
  // 响应层还原后只交给 Mock：按 fixture origin 匹配，未命中明确失败并带原 origin，永不当作资源或转发。
  const { createReportChannel } = await import('../../src/runner/response-layer/report-channel.ts')
  const unmatched: Array<{ method: string; url: string }> = []
  let forwarded = 0
  const channel = createReportChannel('remote-test', 'nonce-remote-test', () => {})
  let mock: ReturnType<typeof createMockMiddleware>
  const http = createServer((req, res) => channel(req, res, () => mock(req, res, error => {
    if (error) { res.writeHead(500); res.end(); return }
    forwarded++; res.writeHead(418); res.end('resource-handler')
  })))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  const address = http.address()
  assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  mock = createMockMiddleware({ previewOrigin: origin, businessPaths: ['/api/**'], store: new ScenarioStore('remote'),
    onUnmatched: value => unmatched.push(value), onDiagnostic: () => {},
    fixtures: [{ origin: 'http://backend.test:8080', method: 'GET', path: '/business/list',
      response: { status: 200, body: { rows: [1] } } }] })
  const remote = (backend: string, path: string) =>
    fetch(origin + '/__dsh_preview/remote/' + encodeURIComponent(backend) + path, { signal: AbortSignal.timeout(3000) })
  const hit = await remote('http://backend.test:8080', '/business/list?page=1')
  assert.equal(hit.status, 200)
  assert.deepEqual(await hit.json(), { rows: [1] })
  const miss = await remote('http://backend.test:8080', '/business/other')
  assert.equal(miss.status, 404)
  assert.deepEqual(unmatched.at(-1), { method: 'GET', url: 'http://backend.test:8080/business/other' })
  const elsewhere = await remote('http://elsewhere.test', '/business/list')
  assert.equal(elsewhere.status, 404, 'fixtures only match their origin')
  assert.equal((await remote('javascript:alert(1)', '/x')).status, 400)
  assert.equal(forwarded, 0, 'remote requests never reach the resource handler')
  // 绕过通道直接发绝对形式请求：不能借此匹配跨源 fixture（既有资源处理只按路径找本地文件，不联网）。
  const direct = await new Promise<number>((resolve, reject) => {
    const req = rawRequest({ host: '127.0.0.1', port: address.port, path: 'http://backend.test:8080/business/list' },
      res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
  assert.notEqual(direct, 200)
})
