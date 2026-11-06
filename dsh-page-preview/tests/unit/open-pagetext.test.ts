/** open 的 pageText 投影（R5-0a）：只有可证明晚于挂载边界的观测才输出；其余如实不输出。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { postMountPageText } from '../../src/host/page-text.ts'
import type { ReadinessEvidence } from '../../src/shared/contracts.ts'

const unverified = { status: 'unverified' } as const
const base: ReadinessEvidence = { serviceReachable: unverified, documentLoaded: unverified, targetMounted: unverified }
const text = (receivedAt: string) => ({ text: 'Orders', truncated: false, url: 'http://127.0.0.1:9000/preview', receivedAt })

test('isolated: text is reported only when observed at or after the mount-signal boundary', () => {
  const mounted = { targetMounted: { status: 'unverified' as const, at: '2026-11-03T00:00:05.000Z' } }
  const readiness = { ...base, ...mounted }
  // 挂载信号先到达：其后的文本（含同毫秒）是挂载后文本。
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:05.000Z') }, 'isolated')?.text, 'Orders')
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:05.100Z') }, 'isolated')?.text, 'Orders')
  // 挂载信号之前的首帧文本（无论空或非空）都不是页面文本。
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:04.900Z') }, 'isolated'), undefined)
  assert.equal(postMountPageText({ readiness, pageText: { ...text('2026-11-03T00:00:04.900Z'), text: '' } }, 'isolated'), undefined)
})

test('isolated: no mount signal yet, failed mount, or no observation is never reported', () => {
  // 挂载信号尚未到达（无 at）：文档加载再早也不能证明文本是挂载后的。
  const readiness = { ...base, documentLoaded: { status: 'proven' as const, at: '2026-11-03T00:00:01.000Z' } }
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:02.000Z') }, 'isolated'), undefined)
  // 挂载失败不是边界。
  const failed = { ...base, targetMounted: { status: 'failed' as const, at: '2026-11-03T00:00:03.000Z' } }
  assert.equal(postMountPageText({ readiness: failed, pageText: text('2026-11-03T00:00:04.000Z') }, 'isolated'), undefined)
  // 没有观测直接 undefined（由 open 侧补 pending 标注）。
  assert.equal(postMountPageText({ readiness }, 'isolated'), undefined)
  // proven 挂载同样作为边界。
  const proven = { ...base, targetMounted: { status: 'proven' as const, at: '2026-11-03T00:00:05.000Z' } }
  assert.equal(postMountPageText({ readiness: proven, pageText: text('2026-11-03T00:00:06.000Z') }, 'isolated')?.text, 'Orders')
})

test('static: the document-load evidence is the boundary (no framework mount signal exists)', () => {
  const readiness = { ...base, documentLoaded: { status: 'proven' as const, at: '2026-11-03T00:00:02.000Z' } }
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:02.500Z') }, 'static')?.text, 'Orders')
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:01.000Z') }, 'static'), undefined)
  const failed = { ...base, documentLoaded: { status: 'failed' as const, at: '2026-11-03T00:00:02.000Z' } }
  assert.equal(postMountPageText({ readiness: failed, pageText: text('2026-11-03T00:00:03.000Z') }, 'static'), undefined)
})

test('project/attach paths produce no page text; a stray observation still needs its mount boundary', () => {
  const readiness = { ...base, targetMounted: { status: 'proven' as const, at: '2026-11-03T00:00:05.000Z' } }
  assert.equal(postMountPageText({ readiness, pageText: text('2026-11-03T00:00:06.000Z') }, 'project')?.text, 'Orders')
  assert.equal(postMountPageText({ readiness: base, pageText: text('2026-11-03T00:00:06.000Z') }, 'attach'), undefined)
})
