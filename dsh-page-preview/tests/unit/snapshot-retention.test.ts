/** Host 终态预览回收（R4-2，r4-2 测试债 的纯策略部分）：上限边界、cleanup_failed 保留、多 owner 隔离。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_TERMINAL_PER_OWNER, previewsToEvict } from '../../src/host/snapshot-retention.ts'
import type { RetainedPreview } from '../../src/host/snapshot-retention.ts'

function preview(previewId: string, owner = 'A', state = 'stopped', terminalAt?: number): RetainedPreview {
  return { previewId, owner, state, ...(terminalAt === undefined ? {} : { terminalAt }) }
}

function range(prefix: string, count: number, owner = 'A', state = 'stopped', start = 0): RetainedPreview[] {
  return Array.from({ length: count }, (_, index) => preview(prefix + (start + index), owner, state, index + 1))
}

test('at and below the limit nothing is evicted; the oldest overflow goes first', () => {
  const kept = range('p', MAX_TERMINAL_PER_OWNER)
  assert.deepEqual(previewsToEvict(kept), [])
  // 第 17 个进入终态时，最旧的 terminalAt 被回收。
  const overflow = range('p', MAX_TERMINAL_PER_OWNER + 1)
  assert.deepEqual(previewsToEvict(overflow), ['p0'])
  // 一次可清多个（例如回收前积压）。
  assert.deepEqual(previewsToEvict(range('p', MAX_TERMINAL_PER_OWNER + 3)).sort(), ['p0', 'p1', 'p2'])
})

test('non-terminal and cleanup_failed previews are never evicted', () => {
  const list = [
    ...range('t', MAX_TERMINAL_PER_OWNER + 2),
    preview('live', 'A', 'reachable'),
    preview('updating', 'A', 'updating'),
    preview('broken-cleanup', 'A', 'cleanup_failed'),
  ]
  const evicted = previewsToEvict(list)
  assert.deepEqual(evicted.sort(), ['t0', 't1'])
  assert.ok(!evicted.includes('live') && !evicted.includes('updating') && !evicted.includes('broken-cleanup'))
})

test('limits apply per owner; one owner overflowing leaves others intact', () => {
  const list = [...range('a', MAX_TERMINAL_PER_OWNER + 1, 'A'), ...range('b', MAX_TERMINAL_PER_OWNER + 1, 'B')]
  assert.deepEqual(previewsToEvict(list).sort(), ['a0', 'b0'])
  // 另一个 owner 不到上限时完全不回收。
  const only = [...range('a', MAX_TERMINAL_PER_OWNER + 5, 'A'), ...range('b', 3, 'B')]
  assert.deepEqual(previewsToEvict(only).sort(), ['a0', 'a1', 'a2', 'a3', 'a4'])
})

test('missing terminalAt counts as oldest; ordering is deterministic regardless of input order', () => {
  const list = [
    ...range('p', MAX_TERMINAL_PER_OWNER),
    preview('notimestamp', 'A', 'stopped'),
  ]
  // 无时间戳的记录排在"最旧"，先被回收。
  assert.deepEqual(previewsToEvict(list), ['notimestamp'])
  const shuffled = [...list].reverse()
  assert.deepEqual(previewsToEvict(shuffled), ['notimestamp'])
  // 时间相同按 previewId 字典序排序后取尾部，淘汰 ID 最大者（结果确定）。
  const same = Array.from({ length: MAX_TERMINAL_PER_OWNER + 1 }, (_, index) =>
    preview('same-' + String(index).padStart(2, '0'), 'A', 'stopped', 42))
  assert.deepEqual(previewsToEvict(same), ['same-16'])
})

test('failed previews count toward the same terminal pool as stopped', () => {
  const list = [
    ...range('s', 10, 'A', 'stopped'),
    ...range('f', MAX_TERMINAL_PER_OWNER - 10 + 1, 'A', 'failed', 100),
  ]
  assert.equal(list.length, MAX_TERMINAL_PER_OWNER + 1)
  assert.deepEqual(previewsToEvict(list), ['s0'])
})
