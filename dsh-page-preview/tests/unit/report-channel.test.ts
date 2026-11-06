/** 受控响应层的真实 HTTP 回归：方案 §6.8、§15.2。使用随机 loopback 端口与可丢弃数据。 */
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createResponseLayer } from '../../src/runner/response-layer/server.ts'
import { createReportChannel } from '../../src/runner/response-layer/report-channel.ts'
import type { BrowserReport, BuildStamp } from '../../src/runner/response-layer/report-channel.ts'

async function fixture(t: TestContext, onReport?: (report: BrowserReport) => void, secrets: readonly string[] = []) {
  const reports: BrowserReport[] = []
  const errors: unknown[] = []
  const nonce = 'test-secret-only-in-http'
  const layer = createResponseLayer({
    previewId: 'test-preview', nonce, allowedHosts: ['127.0.0.1'], csp: {},
    frameAncestors: ['http://127.0.0.1:3080'],
    bootstrapScript: await readFile(new URL('../../src/browser/bootstrap.js', import.meta.url), 'utf8'),
    secrets,
    onReport(report) { onReport?.(report); reports.push(report) },
  })
  const server = createServer((req, res) => layer.middleware(req, res, (err) => {
    if (err) { errors.push(err); res.statusCode = 500; res.end(); return }
    res.writeHead(200, layer.documentHeaders())
    res.end(layer.transformDocument('<html><head><script>throw Error("business")</script></head></html>'))
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown, path = '/__dsh_preview/report', headers = {}) => fetch(origin + path, {
    method: 'POST', body: JSON.stringify(body), headers,
  })
  return { origin, reports, errors, nonce, post }
}

test('ownership probe requires nonce and never returns it', async (t) => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/__dsh_preview/health')).status, 403)
  const response = await fetch(f.origin + '/__dsh_preview/health?nonce=' + f.nonce)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { previewId: 'test-preview' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('reports validate preview, nonce, message shape and same origin', async (t) => {
  const f = await fixture(t)
  const body = { previewId: 'test-preview', nonce: f.nonce, report: { kind: 'document-loaded', url: f.origin } }
  assert.equal((await f.post({ ...body, nonce: 'wrong' })).status, 403)
  assert.equal((await f.post({ ...body, previewId: 'other' })).status, 403)
  assert.equal((await f.post({ ...body, report: { kind: 'assertion', index: -1, passed: true } })).status, 400)
  assert.equal((await f.post(body, undefined, { Origin: 'http://foreign.invalid' })).status, 403)
  assert.equal((await f.post(body, undefined, { Origin: f.origin })).status, 204)
  // 内部匹配用 url 保留原文（含尾斜杠规范化）；转发字段才去 query。
  assert.deepEqual(f.reports, [{ ...body.report, url: f.origin + '/' }])
  assert.equal((await fetch(f.origin + '/__dsh_preview/unknown')).status, 404)
  assert.equal((await fetch(f.origin + '/__dsh_preview/report')).status, 405)
})

test('malformed, oversized and excessive reports fail explicitly', async (t) => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/__dsh_preview/report', { method: 'POST', body: '{' })).status, 400)
  assert.equal((await f.post({ text: 'x'.repeat(65536) })).status, 413)
  for (let i = 0; i < 98; i++) await f.post({})
  assert.equal((await f.post({})).status, 429)
  assert.deepEqual(f.reports, [])
})

test('CSP and error reports redact nonce and discard unvalidated fields', async (t) => {
  const f = await fixture(t)
  const response = await f.post({ 'csp-report': {
    'blocked-uri': `http://blocked.invalid/${f.nonce}`,
    'effective-directive': 'connect-src', 'original-policy': f.nonce,
  } }, '/__dsh_preview/csp?nonce=' + f.nonce)
  assert.equal(response.status, 204)
  await f.post({ previewId: 'test-preview', nonce: f.nonce, report: {
    kind: 'runtime-error', message: `failed ${f.nonce}`, extra: f.nonce,
  } })
  assert.deepEqual(f.reports, [
    { kind: 'csp-violation', blockedURI: 'http://blocked.invalid/[redacted]', directive: 'connect-src' },
    { kind: 'runtime-error', message: 'failed [redacted]' },
  ])
})

test('page-text reports validate shape and env/nonce secrets never reach the callback', async (t) => {
  const f = await fixture(t, undefined, ['env-secret-44'])
  const post = (report: unknown) => f.post({ previewId: 'test-preview', nonce: f.nonce, report })
  // 有效报告：内部匹配用 url 保留 query，转发文本做值替换。
  assert.equal((await post({ kind: 'page-text', url: f.origin + '/page?a=1', text: 'hello env-secret-44 ' + f.nonce, truncated: true })).status, 204)
  for (const report of [
    { kind: 'page-text', url: f.origin, text: 'x'.repeat(2049), truncated: false },
    { kind: 'page-text', url: f.origin, text: 'ok', truncated: 'yes' },
    { kind: 'page-text', text: 'missing url', truncated: false },
    { kind: 'page-text', url: f.origin, truncated: false },
  ]) assert.equal((await post(report)).status, 400)
  assert.deepEqual(f.reports, [{ kind: 'page-text', url: f.origin + '/page?a=1', text: 'hello [redacted] [redacted]', truncated: true }])
})

test('runtime-error reports forward stack/source with secrets and URL query removed', async (t) => {
  const f = await fixture(t, undefined, ['tok-99'])
  await f.post({ previewId: 'test-preview', nonce: f.nonce, report: {
    kind: 'runtime-error', message: 'failed tok-99', source: 'http://u:p@x.invalid/a.js?k=tok-99',
    stack: 'Error: x tok-99\n    at a (/a:1)\n    at b (/b:2)\n    at c (/c:3)\n    at d (/d:4)\n    at e (/e:5)\n    at f (/f:6)',
  } })
  const report = f.reports[0]
  assert.ok(report?.kind === 'runtime-error')
  assert.equal(report.message, 'failed [redacted]')
  assert.equal(report.source, 'http://x.invalid/a.js')
  assert.ok(report.stack!.includes('at e (/e:5)') && !report.stack!.includes('at f'))
  assert.ok(!JSON.stringify(report).includes('tok-99'))
})

async function buildFixture(t: TestContext, stamp: BuildStamp, holdMs = 250, pollMs = 10) {
  const nonce = 'build-nonce'
  const channel = createReportChannel('p1', nonce, () => {}, [], () => ({ ...stamp }), holdMs, pollMs)
  const server = createServer((req, res) => channel(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = (query = '') => fetch(origin + '/__dsh_preview/build?nonce=' + nonce + query)
  return { origin, nonce, stamp, get }
}

test('build channel authenticates the nonce and returns the current stamp immediately', async (t) => {
  const f = await buildFixture(t, { build: 'b1', seq: 3 })
  const denied = await fetch(f.origin + '/__dsh_preview/build')
  assert.equal(denied.status, 403)
  assert.equal((await fetch(f.origin + '/__dsh_preview/build?nonce=wrong')).status, 403)
  assert.equal((await fetch(f.origin + '/__dsh_preview/build?nonce=' + f.nonce, { method: 'POST' })).status, 405)
  const response = await f.get()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { build: 'b1', seq: 3 })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('build channel long-poll returns promptly on stamp change and times out to the current value', async (t) => {
  const f = await buildFixture(t, { build: 'b1', seq: 1 }, 500, 10)
  // since/seq 匹配时挂起；状态变化立即返回新印章。
  const changed = f.get('&since=b1&seq=1')
  await new Promise(resolve => setTimeout(resolve, 60))
  f.stamp.seq = 2
  assert.deepEqual(await (await changed).json(), { build: 'b1', seq: 2 })
  const rebuild = f.get('&since=b1&seq=2')
  f.stamp.build = 'b2'
  assert.deepEqual(await (await rebuild).json(), { build: 'b2', seq: 2 })
  // 无变化时到挂起上限回当前值——不是有界等待之外的永久连接。
  const started = Date.now()
  const held = await (await f.get('&since=b2&seq=2')).json()
  assert.ok(Date.now() - started >= 400, 'unchanged stamp must hold until the bounded deadline')
  assert.deepEqual(held, { build: 'b2', seq: 2 })
  // since/seq 不匹配直接立即返回（首帧握手路径）。
  assert.deepEqual(await (await f.get('&since=other&seq=0')).json(), { build: 'b2', seq: 2 })
})

test('callback failures reach the server error handler', async (t) => {
  const f = await fixture(t, () => { throw new Error('consumer failed') })
  assert.equal((await f.post({ previewId: 'test-preview', nonce: f.nonce, report: { kind: 'target-mounted' } })).status, 500)
  assert.match(String(f.errors[0]), /consumer failed/)
})

test('response layer rejects foreign Host and injects before business code', async (t) => {
  const f = await fixture(t)
  const code = await new Promise<number | undefined>((resolve, reject) => {
    request(f.origin, { headers: { Host: 'foreign.invalid' } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject).end()
  })
  assert.equal(code, 403)
  const response = await fetch(f.origin)
  const policy = (response.headers.get('content-security-policy') ?? '').split('; ')
  for (const directive of ["connect-src 'self'", "form-action 'self'", "frame-ancestors 'self' http://127.0.0.1:3080", "script-src 'self' 'unsafe-inline' 'unsafe-eval'"]) assert.ok(policy.includes(directive))
  const html = await response.text()
  assert.ok(html.indexOf('data-dsh-preview-bootstrap') < html.indexOf('throw Error'))
  assert.equal(html.includes('/*__DSH_PREVIEW_CONFIG__*/ null'), false)
})
