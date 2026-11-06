/** 未命中请求汇总（R3-1，r3-1 测试债）：键规范化、上限、去重计数、畸形输入丢弃、清空。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_UNMATCHED, UnmatchedRequestLog } from '../../src/runner/unmatched-log.ts'

const at = (ms: number) => new Date(ms)

test('keys normalize method casing, strip query from path and keep cross-origin separate', () => {
  const log = new UnmatchedRequestLog()
  log.record({ method: 'get', path: '/api/users?page=1&token=abc' }, at(1000))
  log.record({ method: 'post', origin: 'https://api.example.com/v2', path: '/api/users#frag' }, at(2000))
  const { entries, dropped } = log.snapshot()
  assert.equal(dropped, 0)
  assert.equal(entries.length, 2)
  const sameOrigin = entries.find(value => value.origin === undefined)
  assert.equal(sameOrigin?.method, 'GET')
  assert.equal(sameOrigin?.path, '/api/users')
  const crossOrigin = entries.find(value => value.origin !== undefined)
  assert.equal(crossOrigin?.method, 'POST')
  assert.equal(crossOrigin?.origin, 'https://api.example.com')
  assert.equal(crossOrigin?.path, '/api/users')
  // 同名同源与跨源是两个键，不相合并。
  assert.notEqual(sameOrigin, crossOrigin)
})

test('queryKeys keep names only, deduped and sorted; query values never appear', () => {
  const log = new UnmatchedRequestLog()
  log.record({ method: 'GET', path: '/api/list', queryKeys: ['token', 'page', 'page', 'B'] }, at(1000))
  const entry = log.snapshot().entries[0]
  assert.deepEqual(entry?.queryKeys, ['B', 'page', 'token'])
  assert.ok(!JSON.stringify(log.snapshot()).includes('abc'))
  // 超长与空键名被丢弃。
  const log2 = new UnmatchedRequestLog()
  log2.record({ method: 'GET', path: '/a', queryKeys: ['', 'k'.repeat(300), 'ok'] })
  assert.deepEqual(log2.snapshot().entries[0]?.queryKeys, ['ok'])
})

test('repeat observations bump count and lastSeen while keeping firstSeen', () => {
  const log = new UnmatchedRequestLog()
  log.record({ method: 'GET', path: '/api/a' }, at(1000))
  log.record({ method: 'GET', path: '/api/a', queryKeys: ['q1'] }, at(2000))
  log.record({ method: 'GET', path: '/api/a' }, at(3000))
  const entry = log.snapshot().entries[0]
  assert.equal(entry?.count, 3)
  assert.equal(entry?.firstSeen, at(1000).toISOString())
  assert.equal(entry?.lastSeen, at(3000).toISOString())
  // 更长的 queryKeys 集合胜出（信息量更大）。
  assert.deepEqual(entry?.queryKeys, ['q1'])
})

test('malformed methods, paths and origins are discarded instead of recorded', () => {
  const log = new UnmatchedRequestLog()
  for (const method of ['', ' ', 'G E T', 'GET/x', 'X'.repeat(17)]) {
    log.record({ method, path: '/api/a' })
  }
  for (const path of ['', 'no-slash', 'relative/api', '?only']) {
    log.record({ method: 'GET', path })
  }
  for (const origin of ['not a url', 'ftp://x.test', 'https://user:pw@x.test', 'javascript:alert(1)']) {
    log.record({ method: 'GET', origin, path: '/api/a' })
  }
  assert.deepEqual(log.snapshot(), { entries: [], dropped: 0 })
  // 合法值边界：16 字符 method 与带端口 origin 正常记录。
  log.record({ method: 'X'.repeat(16), origin: 'http://localhost:3000', path: '/ok' })
  const entry = log.snapshot().entries[0]
  assert.equal(entry?.origin, 'http://localhost:3000')
  assert.equal(entry?.method, 'X'.repeat(16))
})

test('lastNewEntryAt tracks only new keys, repeats keep the older stamp; clear resets it', () => {
  const log = new UnmatchedRequestLog()
  assert.equal(log.snapshot().lastNewEntryAt, undefined)
  log.record({ method: 'GET', path: '/api/a' }, at(1000))
  assert.equal(log.snapshot().lastNewEntryAt, at(1000).toISOString())
  // 重复命中既有键只累计 count，不更新 lastNewEntryAt（R6-4 稳定信号）。
  log.record({ method: 'GET', path: '/api/a' }, at(2000))
  assert.equal(log.snapshot().lastNewEntryAt, at(1000).toISOString())
  log.record({ method: 'POST', path: '/api/b' }, at(3000))
  assert.equal(log.snapshot().lastNewEntryAt, at(3000).toISOString())
  log.clear()
  assert.equal(log.snapshot().lastNewEntryAt, undefined)
})

test('beyond MAX_UNMATCHED distinct keys only dropped accumulates; clear resets both', () => {
  const log = new UnmatchedRequestLog()
  for (let i = 0; i < MAX_UNMATCHED; i++) log.record({ method: 'GET', path: '/api/' + i })
  assert.equal(log.snapshot().entries.length, MAX_UNMATCHED)
  assert.equal(log.snapshot().dropped, 0)
  log.record({ method: 'GET', path: '/api/overflow' })
  log.record({ method: 'POST', path: '/api/overflow2' })
  // 已满时重复命中既有键仍累计 count，不占 dropped。
  log.record({ method: 'GET', path: '/api/0' })
  const snapshot = log.snapshot()
  assert.equal(snapshot.entries.length, MAX_UNMATCHED)
  assert.equal(snapshot.dropped, 2)
  assert.equal(snapshot.entries.find(value => value.path === '/api/0')?.count, 2)
  log.clear()
  assert.deepEqual(log.snapshot(), { entries: [], dropped: 0 })
})
