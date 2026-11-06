/** 浏览器 bootstrap 的实际脚本与断言证据（方案 §6.8、§9.2、§15.3）；VM 仅模拟 DOM/时钟，另需真实浏览器验收。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { assertionEvidence, sameDocumentUrl } from '../../src/runner/response-layer/assertions.ts'
import { isBrowserReport } from '../../src/runner/response-layer/report-channel.ts'
import type { BrowserReport } from '../../src/runner/response-layer/report-channel.ts'
import type { TargetAssertion } from '../../src/shared/contracts.ts'
import { createResponseLayer } from '../../src/runner/response-layer/server.ts'

const documentUrl = 'http://127.0.0.1:1234/owned'
const script = await readFile(new URL('../../src/browser/bootstrap.js', import.meta.url), 'utf8')
async function bootstrap(assertions: TargetAssertion[], build?: string) {
  const reports: BrowserReport[] = []
  const intervals = new Map<number, () => void>()
  const timeouts = new Map<number, () => void>()
  const listeners = new Map<string, () => void>()
  let id = 0
  let shown = true
  let parentHidden = false
  const parent = { isConnected: true, parentElement: null, getClientRects: () => [{}] }
  const element = { isConnected: true, parentElement: parent, getClientRects: () => shown ? [{}] : [] }
  const document = { body: { innerText: '' }, addEventListener(name: string, callback: () => void) { listeners.set(name, callback) }, querySelectorAll(selector: string) { if (selector === '[') throw new SyntaxError('Invalid selector'); return selector === '.target' ? [element] : [] } }
  const window = { addEventListener(name: string, callback: () => void) { listeners.set(name, callback) }, getComputedStyle(value: object) { return { display: 'block', visibility: 'visible', opacity: value === parent && parentHidden ? '0' : '1' } }, ...(build === undefined ? {} : { __DSH_BUILD__: build }), __DSH_PREVIEW__: undefined as { mounted(detail?: string): void; report?(payload: BrowserReport): void } | undefined }
  runInNewContext(script.replace('/*__DSH_PREVIEW_CONFIG__*/ null', JSON.stringify({ previewId: 'test', nonce: 'private-test-only', assertions, targetDeadlineMs: 500 })), {
    document, window, location: { href: 'http://127.0.0.1:1234/owned' }, navigator: { sendBeacon(_url: string, body: string) { reports.push(JSON.parse(body).report as BrowserReport); return true } },
    setInterval(callback: () => void) { intervals.set(++id, callback); return id }, clearInterval(key: number) { intervals.delete(key) },
    setTimeout(callback: () => void) { timeouts.set(++id, callback); return id }, clearTimeout(key: number) { timeouts.delete(key) },
  })
  return { reports, document, mount: () => window.__DSH_PREVIEW__!.mounted(), report: (payload: BrowserReport) => window.__DSH_PREVIEW__!.report!(payload), loaded: () => listeners.get('DOMContentLoaded')!(), poll: () => { for (const callback of [...intervals.values()]) callback() }, hide: () => { shown = false }, hideParent: () => { parentHidden = true }, deadline: () => { for (const callback of [...timeouts.values()]) callback() }, timers: () => intervals.size + timeouts.size }
}

test('bootstrap requires mount and all DOM assertions together, waits for async text and releases its timers', async () => {
  const assertions: TargetAssertion[] = [{ kind: 'mount-signal' }, { kind: 'selector-visible', selector: '.target' }, { kind: 'text-present', text: 'Loaded' }]
  const f = await bootstrap(assertions)
  f.loaded()
  const latest = () => f.reports.filter(report => report.kind === 'assertions').at(-1)!
  assert.equal(assertionEvidence(assertions, latest(), documentUrl)?.status, 'unverified')
  f.document.body.innerText = 'Loaded'
  f.poll()
  assert.equal(assertionEvidence(assertions, latest(), documentUrl)?.status, 'unverified')
  f.mount()
  assert.equal(assertionEvidence(assertions, latest(), documentUrl)?.status, 'proven')
  assert.equal(f.timers(), 0)
})

test('hidden target, transparent ancestor and invalid CSS selector never produce successful readiness', async () => {
  for (const variant of ['hidden', 'ancestor', 'selector']) {
    const assertions: TargetAssertion[] = [{ kind: 'mount-signal' }, { kind: 'selector-visible', selector: variant === 'selector' ? '[' : '.target' }]
    const f = await bootstrap(assertions)
    if (variant === 'hidden') f.hide()
    if (variant === 'ancestor') f.hideParent()
    f.loaded(); f.mount(); f.poll()
    for (const report of f.reports.filter(report => report.kind === 'assertions')) assert.equal(assertionEvidence(assertions, report, documentUrl)?.status, 'unverified')
    f.deadline()
    assert.equal(f.timers(), 0)
    assert.ok(!f.reports.some(report => report.kind === 'runtime-error'))
  }
})

test('partial success in different observations is not combined and absent/malformed reports are not proof', () => {
  const assertions: TargetAssertion[] = [{ kind: 'selector-visible', selector: '.a' }, { kind: 'text-present', text: 'B' }]
  for (const results of [[true, false], [false, true]]) assert.equal(assertionEvidence(assertions, { kind: 'assertions', url: documentUrl, results }, documentUrl)?.status, 'unverified')
  assert.equal(assertionEvidence(assertions, { kind: 'assertions', url: documentUrl, results: [true] }, documentUrl), undefined)
  assert.equal(assertionEvidence([], { kind: 'assertions', url: documentUrl, results: [] }, documentUrl), undefined)
  assert.equal(assertionEvidence(assertions, { kind: 'assertion', index: 0, passed: true }, documentUrl), undefined)
  assert.equal(isBrowserReport({ kind: 'assertions', url: documentUrl, results: [true, 'yes'] }), false)
  assert.equal(isBrowserReport({ kind: 'assertions', url: documentUrl, results: [true, false] }), true)
})

test('a stamped document forwards its build version and the bridge exposes module-updated reporting', async () => {
  const f = await bootstrap([], 'synthetic-build-7')
  f.loaded()
  const loaded = f.reports.find(report => report.kind === 'document-loaded')
  assert.deepEqual(loaded, { kind: 'document-loaded', url: documentUrl, build: 'synthetic-build-7' })
  assert.equal(typeof f.report, 'function')
  f.report!({ kind: 'module-updated', version: 'synthetic-build-8' })
  assert.deepEqual(f.reports.at(-1), { kind: 'module-updated', version: 'synthetic-build-8' })
  const clean = await bootstrap([])
  clean.loaded()
  assert.deepEqual(clean.reports.find(report => report.kind === 'document-loaded'), { kind: 'document-loaded', url: documentUrl })
})

test('an unconfigured bootstrap sends no target proof and response-layer assertion config requires a deadline', async () => {
  const f = await bootstrap([])
  f.loaded(); f.mount(); f.poll()
  assert.equal(f.reports.filter(report => report.kind === 'assertions').length, 0)
  const options = { previewId: 'test', nonce: 'private-test-only', allowedHosts: ['127.0.0.1'], csp: {}, frameAncestors: [], bootstrapScript: script, assertions: [{ kind: 'mount-signal' } as const], onReport() {} }
  assert.throws(() => createResponseLayer(options), /bounded deadline/)
  assert.ok(createResponseLayer({ ...options, targetDeadlineMs: 500 }).transformDocument('<html></html>').includes('"targetDeadlineMs":500'))
})

test('assertion evidence binds the expected document URL including query/hash and ignores subdocument reports', () => {
  const assertions: TargetAssertion[] = [{ kind: 'text-present', text: 'Target' }]
  for (const url of ['malformed', documentUrl + '#other', documentUrl + '?other=1', 'http://other.invalid/owned', documentUrl + '/subdocument']) assert.equal(assertionEvidence(assertions, { kind: 'assertions', url, results: [true] }, documentUrl), undefined)
  assert.equal(sameDocumentUrl(documentUrl + '?b=2&a=1#detail', documentUrl + '?a=1&b=2#detail'), true)
  assert.equal(isBrowserReport({ kind: 'assertions', results: [true] }), false)
})

test('only hosts with a build long-poll endpoint tell the bootstrap to poll it (Vite has none)', () => {
  const options = {
    previewId: 'test', nonce: 'private-test-only', allowedHosts: ['127.0.0.1'], csp: {}, frameAncestors: [],
    bootstrapScript: script, onReport() {}, buildVersion: () => 'b1',
  }
  const vite = createResponseLayer(options).transformDocument('<html></html>')
  assert.ok(vite.includes('window.__DSH_BUILD__="b1"'))
  assert.ok(!vite.includes('__DSH_BUILD_POLL__=true'), 'Vite documents must not poll a missing /__dsh_preview/build')
  const cli = createResponseLayer({ ...options, buildState: () => ({ build: 'b1', seq: 0 }) })
    .transformDocument('<html></html>')
  assert.ok(cli.includes('window.__DSH_BUILD_POLL__=true'))
})
