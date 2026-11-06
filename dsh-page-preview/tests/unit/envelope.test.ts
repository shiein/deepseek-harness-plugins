/**
 * R6-1 场景级响应包装（`docs/r6-plan.md` §3 R6-1；方案 §7.2）：
 * validateEnvelope 的拒绝面、applyEnvelope 的展开/保留面、schema 与 validateConfig 联动、
 * draftFixtures 的 envelope/envelopeHint 输出，以及 Mock 中间件的真实展开与未命中不变性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ENVELOPE_DATA_TOKEN, applyEnvelope, validateEnvelope } from '../../src/shared/envelope.ts'
import { collectEnvelopeHint } from '../../src/scenario/envelope-hint.ts'
import { draftFixtures } from '../../src/scenario/fixture-draft.ts'
import { createMockMiddleware } from '../../src/scenario/mock-middleware.ts'
import { ScenarioStore } from '../../src/scenario/store.ts'
import { validateConfig } from '../../src/shared/config/schema.ts'
import type { HttpFixture } from '../../src/shared/config/schema.ts'
import { FIXTURE_PLACEHOLDER } from '../../src/shared/fixture-draft.ts'

const envelope = { template: { code: 0, msg: 'ok', data: ENVELOPE_DATA_TOKEN } }
const configOf = (scenarios: Record<string, unknown>) => ({ schemaVersion: 1, projects: [
  { id: 'app', root: 'app', runtime: { adapter: 'vue-vite' }, scenarios },
] })

test('validateEnvelope requires exactly one data token, JSON values and bounded templates', () => {
  assert.deepEqual(validateEnvelope(envelope), [])
  assert.ok(validateEnvelope({ template: { code: 0 } })[0]?.includes('exactly once'))
  const doubled = { template: { a: ENVELOPE_DATA_TOKEN, b: { c: ENVELOPE_DATA_TOKEN } } }
  assert.ok(validateEnvelope(doubled)[0]?.includes('exactly once'))
  assert.ok(validateEnvelope({ template: { data: ENVELOPE_DATA_TOKEN, fn: () => 1 } })[0]?.includes('JSON values'))
  const undef = { template: { data: ENVELOPE_DATA_TOKEN, missing: undefined } }
  assert.ok(validateEnvelope(undef)[0]?.includes('JSON values'))
  const circular: Record<string, unknown> = { data: ENVELOPE_DATA_TOKEN }
  circular.self = circular
  assert.ok(validateEnvelope({ template: circular }).some(value => value.includes('circular')))
  const deep = (level: number): unknown => level === 0 ? ENVELOPE_DATA_TOKEN : { next: deep(level - 1) }
  assert.ok(validateEnvelope({ template: deep(20) }).some(value => value.includes('nesting')))
  assert.ok(validateEnvelope({ template: { data: ENVELOPE_DATA_TOKEN, pad: 'x'.repeat(17 * 1024) } })
    .some(value => value.includes('bytes')))
  assert.ok(validateEnvelope({ template: { data: ENVELOPE_DATA_TOKEN, bad: Number.NaN } })
    .some(value => value.includes('finite')))
})

test('validateConfig reports envelope problems as config issues and accepts the declared shape', () => {
  const ok = validateConfig(configOf({ default: { businessPaths: ['/api/**'], envelope,
    http: [{ method: 'GET', path: '/api/x', response: { status: 200, body: { v: 1 }, }, envelope: false }] } }))
  assert.deepEqual(ok.issues, [])
  const bad = validateConfig(configOf({ default: { envelope: { template: { code: 0 } } } }))
  assert.ok(bad.issues.some(value => value.path.endsWith('/envelope/template')
    && value.message.includes('exactly once')))
  const wrong = validateConfig(configOf({ default: { envelope: { template: { data: ENVELOPE_DATA_TOKEN } },
    http: [{ method: 'GET', path: '/api/x', response: { status: 200, body: 1 }, envelope: true }] } }))
  assert.ok(wrong.issues.length > 0, 'fixture.envelope only accepts literal false')
})

test('applyEnvelope wraps only JSON bodies, keeps exclusions verbatim and never mutates the fixture', () => {
  const fixture: HttpFixture = { method: 'GET', path: '/api/user', response: { status: 200, body: { name: 'a' } } }
  const wrapped = applyEnvelope(fixture, envelope)
  assert.deepEqual(wrapped.response.body, { code: 0, msg: 'ok', data: { name: 'a' } })
  assert.deepEqual(fixture.response.body, { name: 'a' }, 'the input fixture is unchanged')
  for (const body of [[1, 2], null, 7, 'text', true]) {
    const expanded = applyEnvelope({ method: 'GET', path: '/x', response: { status: 200, body } }, envelope)
    assert.deepEqual((expanded.response.body as { data: unknown }).data, body)
  }
  const keep: HttpFixture[] = [
    { method: 'GET', path: '/f', response: { status: 200, body: { v: 1 }, bodyFile: 'data/x.json' } },
    { method: 'GET', path: '/f', response: { status: 204 } },
    { method: 'GET', path: '/f', response: { status: 205, body: undefined } },
    { method: 'GET', path: '/f', response: { status: 200, body: { v: 1 } }, envelope: false },
  ]
  for (const item of keep) assert.equal(applyEnvelope(item, envelope), item)
  assert.throws(() => applyEnvelope({ method: 'GET', path: '/x',
    response: { status: 200, body: { data: FIXTURE_PLACEHOLDER } } }, envelope), /placeholder/)
  assert.throws(() => applyEnvelope({ method: 'GET', path: '/x', response: { status: 200, body: 1 } },
    { template: { code: 0 } }), /exactly once/)
})

test('the mock middleware expands declared fixtures and unmatched requests stay unmatched', async t => {
  const unmatched: unknown[] = []
  const http = createServer((req, res) => middleware(req, res, () => { res.writeHead(418); res.end() }))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())))
  const address = http.address()
  const origin = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0)
  const middleware = createMockMiddleware({ previewOrigin: origin, businessPaths: ['/api/**'], envelope,
    store: new ScenarioStore('envelope-test'),
    fixtures: [
      { method: 'GET', path: '/api/user/info', response: { status: 200, body: { name: 'a', roles: ['r'] } } },
      { method: 'GET', path: '/api/raw', response: { status: 200, body: { v: 9 } }, envelope: false },
    ],
    onUnmatched: value => unmatched.push(value), onDiagnostic() {} })
  const wrapped = await (await fetch(origin + '/api/user/info')).json()
  assert.deepEqual(wrapped, { code: 0, msg: 'ok', data: { name: 'a', roles: ['r'] } })
  assert.deepEqual(await (await fetch(origin + '/api/raw')).json(), { v: 9 })
  const missed = await fetch(origin + '/api/menu/list')
  assert.equal(missed.status, 404)
  assert.deepEqual(await missed.json(), { code: 'unmatched_request' })
  assert.deepEqual(unmatched, [{ method: 'GET', url: '/api/menu/list' }])
})

test('draftFixtures writes data-positioned bodies and carries the declared envelope in the snippet', () => {
  const entries = [{ method: 'GET', path: '/api/user/info', queryKeys: [], count: 2 }]
  const plain = draftFixtures('s', entries)
  assert.equal(plain.fixtures[0]?.response.body, FIXTURE_PLACEHOLDER)
  assert.equal('envelope' in JSON.parse(plain.configSnippet).s, false)
  const wrapped = draftFixtures('s', entries, 20, undefined, { envelope })
  assert.equal(wrapped.fixtures[0]?.response.body, FIXTURE_PLACEHOLDER, 'the draft body stays a data placeholder')
  const parsed = JSON.parse(wrapped.configSnippet).s
  assert.deepEqual(parsed.envelope, envelope, 'the snippet keeps the declared scenario envelope verbatim')
})

test('collectEnvelopeHint suggests a template from interceptor evidence only', async t => {
  const root = await realpathRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/request.ts'), `export async function send(url) {
  const response = await fetch(url)
  const body = await response.json()
  if (body.code !== 0) throw new Error('business failure: ' + body.msg)
  return body.data
}
`)
  const hint = await collectEnvelopeHint(root)
  assert.ok(hint, 'code!==0 + body.data evidence must produce a hint')
  assert.deepEqual(hint.template, { code: 0, msg: 'ok', data: ENVELOPE_DATA_TOKEN })
  assert.ok(hint.evidence.some(value => value.file === 'src/request.ts' && value.snippet.includes('body.code !== 0')))
  assert.ok(hint.evidence.some(value => value.snippet.includes('body.data')))

  // 只有 code 判断没有 data 读取：识别不到就不给。
  await rm(join(root, 'src/request.ts'))
  await writeFile(join(root, 'src/check.ts'), 'if (res.code === 200) log(res.code)\n')
  assert.equal(await collectEnvelopeHint(root), undefined)

  // axios 风格 res.data.code !== 0 + res.data.data。
  await rm(join(root, 'src/check.ts'))
  await writeFile(join(root, 'src/http.ts'), `service.interceptors.response.use((res) => {
  if (res.data.code !== 0) return Promise.reject(res.data.message)
  return res.data.data
})
`)
  const axiosHint = await collectEnvelopeHint(root)
  assert.deepEqual(axiosHint?.template, { code: 0, message: 'ok', data: ENVELOPE_DATA_TOKEN })
})

async function realpathRoot(): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(await mkdtemp(join(tmpdir(), 'dsh-envelope-hint-')))
}
