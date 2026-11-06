import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HttpFixture } from '../../src/shared/config/schema.ts'
import { matchFixture, matchHttpPath } from '../../src/scenario/http-matcher.ts'

const origin = 'http://127.0.0.1:5173'
const ok = { status: 200 }

test('fixture without origin only matches preview origin', () => {
  const fixtures: HttpFixture[] = [{ method: 'GET', path: '/api/users', response: ok }]
  const request = { method: 'GET', path: '/api/users', query: {} }
  assert.equal(matchFixture({ ...request, origin }, fixtures, origin).kind, 'matched')
  assert.equal(matchFixture({ ...request, origin: 'https://api.example.com' }, fixtures, origin).kind, 'unmatched')
})

test('overlapping fixtures are reported as ambiguous', () => {
  const fixtures: HttpFixture[] = [
    { method: 'GET', path: '/api/users', response: ok },
    { method: 'get', path: '/api/users', response: ok },
  ]
  const outcome = matchFixture({ origin, method: 'GET', path: '/api/users', query: {} }, fixtures, origin)
  assert.deepEqual(outcome, { kind: 'ambiguous', indexes: [0, 1] })
})

test('query constraints narrow the match', () => {
  const fixtures: HttpFixture[] = [{ method: 'GET', path: '/api/users', query: { page: '2' }, response: ok }]
  assert.equal(matchFixture({ origin, method: 'GET', path: '/api/users', query: { page: '1' } }, fixtures, origin).kind, 'unmatched')
})

test('declared bodies require exact deep JSON equality with object order ignored and array order retained', () => {
  const fixtures: HttpFixture[] = [{ method: 'POST', path: '/api/users', body: { page: 1, filter: { names: ['A', 'B'] } }, response: ok }]
  const request = { origin, method: 'POST', path: '/api/users', query: {} }
  assert.equal(matchFixture({ ...request, body: { filter: { names: ['A', 'B'] }, page: 1 } }, fixtures, origin).kind, 'matched')
  for (const body of [undefined, null, { page: '1', filter: { names: ['A', 'B'] } }, { page: 1, filter: { names: ['B', 'A'] } }, { page: 1, filter: { names: ['A', 'B'] }, extra: true }]) assert.equal(matchFixture({ ...request, ...(body === undefined ? {} : { body }) }, fixtures, origin).kind, 'unmatched')
  fixtures[0]!.body = null
  assert.equal(matchFixture({ ...request, body: null }, fixtures, origin).kind, 'matched')
  assert.equal(matchFixture(request, fixtures, origin).kind, 'unmatched')
  delete fixtures[0]!.body
  assert.equal(matchFixture({ ...request, body: { arbitrary: true } }, fixtures, origin).kind, 'matched')
})

test('path parameters capture one encoded segment and exact/parameter overlaps stay ambiguous', () => {
  const fixtures: HttpFixture[] = [{ method: 'GET', path: '/api/users/:id', response: ok }]
  const request = { origin, method: 'GET', path: '/api/users/%E4%B8%AD%2F42', query: {} }
  const matched = matchFixture(request, fixtures, origin)
  assert.ok(matched.kind === 'matched')
  assert.deepEqual(matched.params, { id: '中/42' })
  for (const path of ['/api/users', '/api/users/', '/api/users/a/b', '/api/users/%E0%A4']) assert.equal(matchFixture({ ...request, path }, fixtures, origin).kind, 'unmatched')
  fixtures.push({ method: 'GET', path: '/api/users/admin', response: ok })
  assert.deepEqual(matchFixture({ ...request, path: '/api/users/admin' }, fixtures, origin), { kind: 'ambiguous', indexes: [0, 1] })
})

test('path pattern syntax errors are explicit, literals decode once and parameter names do not mutate prototypes', () => {
  for (const pattern of ['relative', '//other/path', '/api/:id/:id', '/api/:bad-name', '/api/users?x=1', '/api/%E0%A4']) assert.throws(() => matchHttpPath(pattern, '/api/value'))
  assert.deepEqual(matchHttpPath('/api/用户/:value/', '/api/%E7%94%A8%E6%88%B7/%252F/'), { value: '%2F' })
  const result = matchHttpPath('/api/:__proto__', '/api/value')
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(Object.hasOwn(result!, '__proto__'), true)
  assert.equal(result!.__proto__, 'value')
})
