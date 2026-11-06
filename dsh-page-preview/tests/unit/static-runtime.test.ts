/** 原文件静态服务实测（方案 §6.6、§6.8、§15.3）；临时样本、真实 HTTP/端口，不执行业务模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startStatic } from '../../src/adapters/static/runtime.ts'
import { planStatic } from '../../src/adapters/static/preflight.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'
import type { StartContext, RunEvent, RunningHandle } from '../../src/adapters/types.ts'
// 生命周期实测覆盖 macOS 与 Linux（procfs 归属实现）；其他平台无归属核对实现仍跳过。
const options = { timeout: 10000, skip: !['darwin', 'linux'].includes(process.platform) }
async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-static-')))
  await cp(new URL('../fixtures/static-multipage/', import.meta.url), root, { recursive: true })
  const ledger = createFileLedger(join(root, 'private-ledger'))
  const events: RunEvent[] = []
  const control = new AbortController()
  let running: RunningHandle | undefined
  t.after(async () => { if (running) assert.deepEqual(await running.stop(), { residual: [] }); await rm(root, { recursive: true, force: true }) })
  const unknown = { status: 'unknown', source: 'none' } as const
  const ctx: StartContext = {
    previewId: 'static-test', ownerSessionId: 'test-owner', workspaceRoot: root, appRoot: root,
    config: { source: { kind: 'detected' }, project: { id: 'sample', root: '.', runtime: { publicRoot: '.' } }, diagnostics: [] },
    profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] },
    plan: { projectId: 'sample', targetId: 'index', selector: { kind: 'file', path: 'index.html' }, scope: 'page', strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: ['mock-only'], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 3000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: 'fixture' }, missing: [], knownDifferences: [] },
    ledger, signal: control.signal, deadline: Date.now() + 3000, emit: event => events.push(event),
  }
  return { root, ledger, ctx, events, control, async start() { running = await startStatic(ctx); return running } }
}

test('static runtime returns original multipage files with early bootstrap and CSP; stop releases its listener', options, async t => {
  const f = await setup(t)
  const running = await f.start()
  const response = await fetch(running.url)
  const html = await response.text()
  assert.ok(html.includes('真实静态样本'))
  assert.ok(html.indexOf('data-dsh-preview-bootstrap') < html.indexOf('/app.js'))
  assert.ok(response.headers.get('content-security-policy')?.includes("connect-src 'self'"))
  assert.equal((await fetch(new URL('/second.html', running.url))).status, 200)
  assert.equal((await fetch(new URL('/worker.js', running.url))).headers.get('content-type'), 'text/javascript; charset=utf-8')
  const port = Number(new URL(running.url).port)
  assert.deepEqual(await findListeningPids(port), [process.pid])
  assert.equal((await f.ledger.listByPreview(f.ctx.previewId)).length, 1)
  assert.ok(f.events.some(event => event.type === 'evidence' && event.layer === 'serviceReachable'))
  assert.ok(!f.events.some(event => event.type === 'evidence' && event.layer === 'targetMounted'))
  assert.deepEqual(await running.stop(), { residual: [] })
  assert.deepEqual(await running.stop(), { residual: [] })
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await f.ledger.listByPreview(f.ctx.previewId), [])
})

test('unknown business requests, dotfiles, malformed escapes and outside symlinks never return a fallback page', options, async t => {
  const f = await setup(t)
  const outside = join(f.root, '..', 'outside-' + f.ctx.previewId + '-' + Date.now() + '.json')
  await writeFile(outside, 'synthetic private content')
  t.after(() => rm(outside, { force: true }))
  await writeFile(join(f.root, '.env'), 'SYNTHETIC_ONLY=private')
  await symlink(outside, join(f.root, 'escape.json'))
  const running = await f.start()
  for (const path of ['/api/unmatched', '/.env', '/escape.json', '/%E0%A4', '/missing.js']) {
    const response = await fetch(new URL(path, running.url))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { code: 'unmatched_request' })
  }
  assert.equal((await fetch(running.url, { method: 'POST' })).status, 404)
})

test('authenticated reports require the right target and redact nonce from diagnostics', options, async t => {
  const f = await setup(t)
  const running = await f.start()
  const html = await (await fetch(running.url)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  const origin = new URL(running.url).origin
  assert.equal((await fetch(origin + '/__dsh_preview/health?nonce=wrong')).status, 403)
  const report = async (value: unknown) => fetch(origin + '/__dsh_preview/report', { method: 'POST', body: JSON.stringify({ nonce, previewId: f.ctx.previewId, report: value }) })
  await report({ kind: 'document-loaded', url: origin + '/second.html' })
  assert.ok(!f.events.some(event => event.type === 'evidence' && event.layer === 'documentLoaded'))
  assert.equal((await report({ kind: 'document-loaded', url: running.url })).status, 204)
  assert.ok(f.events.some(event => event.type === 'evidence' && event.layer === 'documentLoaded'))
  await report({ kind: 'runtime-error', message: 'synthetic ' + nonce })
  await fetch(origin + '/' + nonce)
  assert.equal(JSON.stringify(f.events).includes(nonce), false)
})

test('static browser errors forward message/stack/source while env-file values are redacted', options, async t => {
  const f = await setup(t)
  // static 不允许 runtime.env；env 文件值走同一统一脱敏（runtime.env 值由 runner-session 测试覆盖）。
  await writeFile(join(f.root, '.env'), 'FILE_SECRET=file-secret-22\nSECOND=env-secret-11\n')
  const running = await f.start()
  const html = await (await fetch(running.url)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  for (const value of [
    { kind: 'runtime-error', message: 'render failed with env-secret-11', source: '/app.js?key=file-secret-22',
      stack: 'Error: boom env-secret-11\n    at one (/app/a.js:1:1)\n    at two (/app/b.js:2:2)\n    at three (/app/c.js:3:3)\n    at four (/app/d.js:4:4)\n    at five (/app/e.js:5:5)\n    at six (/app/f.js:6:6)' },
    { kind: 'unhandled-rejection', message: 'rejected file-secret-22' },
    { kind: 'csp-violation', blockedURI: 'https://example.invalid/api?key=env-secret-11', directive: 'connect-src' },
  ]) {
    const response = await fetch(new URL('/__dsh_preview/report', running.url), { method: 'POST', body: JSON.stringify({ nonce, previewId: f.ctx.previewId, report: value }) })
    assert.equal(response.status, 204)
  }
  const diagnostics = f.events.filter(value => value.type === 'diagnostic').map(value => value.diagnostic)
  assert.deepEqual(diagnostics.map(value => value.code), ['runtime_error', 'runtime_error', 'blocked_request'])
  // 必须转发：message、前 N 帧堆栈、source 路径、被阻断地址与指令。
  assert.ok(diagnostics[0]!.message.includes('render failed with [redacted]'))
  assert.ok(diagnostics[0]!.message.includes('at five (/app/e.js:5:5)'))
  assert.ok(!diagnostics[0]!.message.includes('at six'))
  assert.ok(diagnostics[0]!.message.includes('truncated'))
  assert.equal(diagnostics[0]!.location?.request, '/app.js')
  assert.equal(diagnostics[2]!.location?.request, 'https://example.invalid/api')
  assert.ok(diagnostics[2]!.message.includes('connect-src'))
  // 必须去除：env 值、.env 值、nonce、query。
  const serialized = JSON.stringify(diagnostics)
  for (const secret of ['env-secret-11', 'file-secret-22', nonce!, 'key=']) assert.ok(!serialized.includes(secret), 'must not expose ' + secret)
  assert.ok(diagnostics.every(value => value.message.length > 0 && value.hint))
})

test('page-text reports reach the page-text event bound to the target, redacted and bounded', options, async t => {
  const f = await setup(t)
  await writeFile(join(f.root, '.env'), 'FILE_SECRET=file-secret-33\n')
  const running = await f.start()
  const html = await (await fetch(running.url)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  const origin = new URL(running.url).origin
  const report = async (value: unknown) => fetch(origin + '/__dsh_preview/report', { method: 'POST', body: JSON.stringify({ nonce, previewId: f.ctx.previewId, report: value }) })
  assert.equal((await report({ kind: 'page-text', url: running.url, text: '你好 file-secret-33', truncated: false })).status, 204)
  const observation = f.events.find(value => value.type === 'page-text')?.observation
  assert.ok(observation)
  assert.equal(observation.text, '你好 [redacted]')
  assert.equal(observation.truncated, false)
  assert.equal(observation.url, running.url)
  // 形状校验：超限文本与非布尔 truncated 被拒绝。
  assert.equal((await report({ kind: 'page-text', url: running.url, text: 'x'.repeat(2049), truncated: false })).status, 400)
  assert.equal((await report({ kind: 'page-text', url: running.url, text: 'ok', truncated: 'yes' })).status, 400)
  // 其他文档的 page-text 不绑定到目标观察。
  const before = f.events.filter(value => value.type === 'page-text').length
  assert.equal((await report({ kind: 'page-text', url: origin + '/second.html', text: 'other page', truncated: false })).status, 204)
  assert.equal(f.events.filter(value => value.type === 'page-text').length, before)
})

test('static target assertions only prove the selected document and never combine partial observations', options, async t => {
  const f = await setup(t)
  f.ctx.plan.readiness.assertions = [{ kind: 'selector-visible', selector: 'h1' }, { kind: 'text-present', text: '真实静态样本' }]
  const running = await f.start()
  const html = await (await fetch(running.url)).text()
  assert.match(html, /"targetDeadlineMs":3000/)
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  const report = async (url: string, results: boolean[]) => fetch(new URL('/__dsh_preview/report', running.url), { method: 'POST', body: JSON.stringify({ nonce, previewId: f.ctx.previewId, report: { kind: 'assertions', url, results } }) })
  for (const url of [new URL('/second.html', running.url).href, running.url + '#other', 'http://other.invalid/index.html', 'malformed']) await report(url, [true, true])
  assert.ok(!f.events.some(event => event.type === 'evidence' && event.layer === 'targetMounted'))
  await report(running.url, [true, false]); await report(running.url, [false, true])
  assert.ok(!f.events.some(event => event.type === 'evidence' && event.layer === 'targetMounted' && event.evidence.status === 'proven'))
  await report(running.url, [true, true])
  assert.ok(f.events.some(event => event.type === 'evidence' && event.layer === 'targetMounted' && event.evidence.status === 'proven'))
})

test('explicit SPA navigation preserves params/query, Unicode files work and missing resources stay errors', options, async t => {
  const f = await setup(t)
  f.ctx.plan.selector = { kind: 'route', path: '/orders/:id', params: { id: '42' }, query: { tab: 'active' } }
  f.ctx.config.project.runtime.spaFallback = true
  const running = await f.start()
  assert.ok(running.url.endsWith('/orders/42?tab=active'))
  assert.equal((await fetch(running.url, { headers: { Accept: 'text/html' } })).status, 200)
  assert.equal((await fetch(new URL('/missing.css', running.url), { headers: { Accept: 'text/html' } })).status, 404)
  await cp(join(f.root, 'second.html'), join(f.root, '中文.html'))
  assert.equal((await fetch(new URL('/中文.html', running.url))).status, 200)
})

test('unsupported initialization and cancellation during port registration allocate no lingering service', options, async t => {
  const f = await setup(t)
  f.ctx.plan.route = { path: '/other-navigation' }
  await assert.rejects(f.start(), /route bindings/)
  delete f.ctx.plan.route
  f.ctx.plan.selector = { kind: 'route', path: '/index.html' }
  f.ctx.plan.route = { path: '/second.html' }
  await assert.rejects(f.start(), /conflicts/)
  delete f.ctx.plan.route
  f.ctx.plan.selector = { kind: 'file', path: 'index.html' }
  f.ctx.plan.scenario = 'unsupported'
  await assert.rejects(f.start(), /not configured/)
  assert.deepEqual(await f.ledger.listByPreview(f.ctx.previewId), [])
  delete f.ctx.plan.scenario
  let port = 0
  f.ctx.ledger = { ...f.ledger, async record(input) {
    const entry = await f.ledger.record(input)
    if (input.resource.kind === 'port') port = input.resource.port
    f.control.abort()
    return entry
  } }
  await assert.rejects(f.start(), { name: 'AbortError' })
  assert.ok(port > 0)
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await f.ledger.listByPreview(f.ctx.previewId), [])
})

test('static scene fixtures precede SPA fallback and preserve actual files, bounded matching and diagnostics', options, async t => {
  const f = await setup(t)
  f.ctx.config.project.runtime.spaFallback = true
  f.ctx.config.project.scenarios = { own: { businessPaths: ['/api/**', '/second.html'], http: [
    { method: 'GET', path: '/api/value', response: { status: 200, bodyFile: 'reply.json', headers: { 'Content-Type': 'application/json' } } },
    { method: 'POST', path: '/api/write', response: { status: 201, body: { accepted: true } } },
    { method: 'GET', path: '/second.html', response: { status: 200, body: 'MUST_NOT_REPLACE_FILE' } },
  ] } }
  await writeFile(join(f.root, 'reply.json'), '{"value":"static fixture"}')
  const outcome = await planStatic(f.ctx, { projectId: f.ctx.plan.projectId, targetId: f.ctx.plan.targetId, selector: f.ctx.plan.selector, scope: f.ctx.plan.scope }, 'own')
  assert.ok(outcome.kind === 'plan')
  f.ctx.plan = outcome.plan
  const running = await f.start()
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, running.url), init)
  assert.deepEqual(await (await request('/api/value', { headers: { Accept: 'text/html' } })).json(), { value: 'static fixture' })
  assert.equal((await request('/api/missing?private=DO_NOT_EXPOSE_QUERY', { headers: { Accept: 'text/html' } })).status, 404)
  assert.equal((await request('/ordinary-route', { headers: { Accept: 'text/html' } })).status, 200)
  assert.ok(!(await (await request('/second.html')).text()).includes('MUST_NOT_REPLACE_FILE'))
  assert.equal((await request('/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await request('/api/write', { method: 'POST' })).status, 201)
  assert.ok(f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'unsupported_capability'))
  assert.ok(!JSON.stringify(f.events).includes('DO_NOT_EXPOSE_QUERY'))
  assert.deepEqual(await running.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.ctx.previewId), [])
})
