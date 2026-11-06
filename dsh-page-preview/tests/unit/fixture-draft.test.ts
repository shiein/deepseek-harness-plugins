/** 未命中请求 → fixture 草稿（R3-1，r3-1 测试债）：排序截断、占位标记、businessPaths 归纳、跨源分流。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  containsPlaceholder, draftFixtures, FIXTURE_PLACEHOLDER,
} from '../../src/scenario/fixture-draft.ts'
import type { UnmatchedForDraft } from '../../src/scenario/fixture-draft.ts'
import { validateConfig } from '../../src/shared/config/schema.ts'

function entry(path: string, count = 1, rest: Partial<UnmatchedForDraft> = {}): UnmatchedForDraft {
  return { method: 'get', path, queryKeys: [], count, ...rest }
}

test('fixtures sort by count descending with deterministic ties, truncated by maxFixtures', () => {
  const entries = [entry('/api/low', 1), entry('/api/high', 9), entry('/api/mid', 3), entry('/api/mid2', 3)]
  const draft = draftFixtures('default', entries, 3)
  assert.deepEqual(draft.fixtures.map(value => value.path), ['/api/high', '/api/mid', '/api/mid2'])
  assert.equal(draft.omitted, 1)
  // count 相同按 method+path 字典序。
  const same = draftFixtures('s', [entry('/z', 2), entry('/a', 2)])
  assert.deepEqual(same.fixtures.map(value => value.path), ['/a', '/z'])
})

test('method is uppercased; query keys become empty-string constraints; bodies stay placeholder', () => {
  const draft = draftFixtures('s', [entry('/api/search', 2, { queryKeys: ['page', 'q'] })])
  const fixture = draft.fixtures[0]
  assert.equal(fixture?.method, 'GET')
  assert.deepEqual(fixture?.query, { page: '', q: '' })
  assert.equal(fixture?.response.body, FIXTURE_PLACEHOLDER)
  assert.equal(fixture?.response.status, 200)
  assert.equal(typeof fixture?.provenance, 'string')
  // 无 queryKeys 的条目不带 query 字段。
  assert.equal(draftFixtures('s', [entry('/api/plain')]).fixtures[0]?.query, undefined)
})

test('numeric and UUID path segments are kept verbatim, never parameterized', () => {
  const draft = draftFixtures('s', [
    entry('/api/orders/12345'), entry('/api/users/550e8400-e29b-41d4-a716-446655440000'),
  ])
  assert.deepEqual(draft.fixtures.map(value => value.path), [
    '/api/orders/12345', '/api/users/550e8400-e29b-41d4-a716-446655440000',
  ])
})

test('businessPaths summarize the longest shared directory, else first-segment directories', () => {
  const shared = draftFixtures('s', [entry('/api/v1/users'), entry('/api/v1/orders'), entry('/api/v1/items')])
  assert.deepEqual(shared.businessPaths, ['/api/v1/**'])
  // 无共同前缀时退回首段目录去重，最多 4 条。
  const scattered = draftFixtures('s', [
    entry('/auth/login'), entry('/billing/pay'), entry('/users/me'), entry('/orders/list'), entry('/z/x'),
  ])
  assert.deepEqual(scattered.businessPaths, ['/auth/**', '/billing/**', '/orders/**', '/users/**'])
  // 顶层路径没有目录段时不给建议。
  assert.deepEqual(draftFixtures('s', [entry('/ping')]).businessPaths, [])
})

test('cross-origin misses produce origin fixtures (bounded) plus the crossOrigin report', () => {
  const entries = [
    entry('/api/local', 5),
    ...Array.from({ length: 12 }, (_, i) => entry('/ext/' + i, 1, { origin: 'https://api.example.com' })),
  ]
  const draft = draftFixtures('s', entries)
  // R5-1c：跨源未命中生成带原 origin 的 fixture（按 count 排序、上限 MAX_CROSS_ORIGIN），
  // 可直接粘贴——预检已放行显式 origin fixture。
  assert.equal(draft.fixtures.length, 9)
  assert.equal(draft.fixtures[0]?.path, '/api/local')
  assert.equal(draft.fixtures[0]?.origin, undefined)
  const remote = draft.fixtures.slice(1)
  assert.ok(remote.every(fixture => fixture.origin === 'https://api.example.com'
    && fixture.response.body === FIXTURE_PLACEHOLDER))
  assert.equal(draft.crossOrigin.length, 8)
  assert.equal(draft.crossOrigin[0]?.origin, 'https://api.example.com')
  // 跨源不计入 omitted（omitted 只表示同源排序截断）。
  assert.equal(draft.omitted, 0)
  // 跨源路径不参与 businessPaths 归纳——只反映同源条目。
  assert.deepEqual(draft.businessPaths, ['/api/**'])
  assert.deepEqual(draftFixtures('s', [entry('/ext/x', 1, { origin: 'https://api.example.com' })])
    .businessPaths, [], 'a remote-only draft has no same-origin business path suggestion')
  // 草稿 JSON 片段可粘贴且 origin 字段通过 schema 校验（占位体仍被拒）。
  const snippet = JSON.parse(draft.configSnippet) as Record<string, { http: Array<{ origin?: string }> }>
  assert.equal(snippet.s?.http.filter(fixture => fixture.origin !== undefined).length, 8)
})

test('configSnippet parses as the scenarios block whose fixtures satisfy the config schema', () => {
  const draft = draftFixtures('readonly', [entry('/api/data', 4, { queryKeys: ['q'] })])
  const snippet: unknown = JSON.parse(draft.configSnippet)
  assert.ok(typeof snippet === 'object' && snippet !== null && 'readonly' in snippet)
  const scenario = (snippet as Record<string, { http?: unknown; businessPaths?: string[] }>).readonly
  assert.ok(Array.isArray(scenario?.http))
  assert.equal(scenario?.businessPaths?.[0], '/api/**')
  // 草稿含占位标记：粘贴后必须被 validateConfig 拒绝，而不是悄悄生效。
  const config = {
    schemaVersion: 1,
    projects: [{ id: 'app', root: '.', runtime: { strategy: 'static', adapter: 'static' },
      scenarios: snippet }],
  }
  const result = validateConfig(config)
  assert.ok(result.issues.some(issue => issue.path.includes('readonly') && issue.message.includes('placeholder')),
    'placeholder draft must be rejected: ' + JSON.stringify(result.issues))
})

test('write-method misses also produce handler drafts that honestly gate store-backed writes', () => {
  // R5-1f：写请求同时带静态 fixture（既有路径）与 handler 模板（注明不写 store 不影响后续读取）。
  const draft = draftFixtures('s', [
    entry('/api/orders', 3, { method: 'post' }),
    entry('/api/users', 1, { method: 'delete' }),
    entry('/api/list', 9),
    entry('/ext/write', 2, { method: 'PUT', origin: 'https://api.example.com' }),
  ])
  // 静态 http fixture 路径不变：写方法也各有一条（声明的静态响应 + 既有诊断）。
  assert.equal(draft.fixtures.length, 4)
  const methods = draft.fixtures.map(fixture => fixture.method)
  assert.deepEqual(methods, ['GET', 'POST', 'DELETE', 'PUT'])
  // handlerDrafts 只覆盖写方法（GET 不出模板），按 fixture 同序排列。
  assert.equal(draft.handlerDrafts.length, 3)
  const post = draft.handlerDrafts.find(value => value.method === 'POST' && value.path === '/api/orders')
  assert.ok(post)
  assert.match(post.template, /request\.method !== "POST"/)
  assert.match(post.template, /request\.path !== "\/api\/orders"/)
  assert.match(post.template, /not reflected in later\n.*reads|not reflected in later reads/)
  assert.match(post.template, /store\.set/)
  assert.match(post.template, /store\.get/)
  // 跨源写请求的模板守卫带原 origin。
  const remote = draft.handlerDrafts.find(value => value.method === 'PUT')
  assert.equal(remote?.origin, 'https://api.example.com')
  assert.match(remote!.template, /request\.origin !== "https:\/\/api\.example\.com"/)
  // 模板是可评估的 handler 函数形态（default 数组元素）。
  const fn = new Function('return (' + post.template + ')')() as (
    request: { method: string; path: string; body?: unknown },
    store: { set(key: string, value: unknown): void; get(key: string): unknown },
  ) => Promise<{ status: number; body: unknown } | undefined>
  const calls: Array<[string, unknown]> = []
  const store = { set: (k: string, v: unknown) => { calls.push([k, v]) }, get: (k: string) => calls.find(([key]) => key === k)?.[1] }
  return fn({ method: 'POST', path: '/api/orders', body: { id: 1 } }, store).then(result => {
    assert.equal(result?.status, 200)
    assert.deepEqual(result?.body, { id: 1 })
    return fn({ method: 'GET', path: '/api/orders' }, store).then(skipped => {
      assert.equal(skipped, undefined, 'the template only handles its declared request')
    })
  })
})

test('containsPlaceholder deep-rejects marker strings in bodies, headers and nested shapes', () => {
  assert.equal(containsPlaceholder(FIXTURE_PLACEHOLDER), true)
  assert.equal(containsPlaceholder({ data: [1, { body: FIXTURE_PLACEHOLDER }] }), true)
  assert.equal(containsPlaceholder({ headers: { 'x-a': FIXTURE_PLACEHOLDER } }), true)
  assert.equal(containsPlaceholder('prefix_' + FIXTURE_PLACEHOLDER), false)
  assert.equal(containsPlaceholder({ data: 'real' }), false)
  assert.equal(containsPlaceholder(undefined), false)
  assert.equal(containsPlaceholder(42), false)
})
