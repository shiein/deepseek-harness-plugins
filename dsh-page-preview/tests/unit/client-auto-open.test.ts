/** 侧边栏自动展示的纯逻辑（方案 §10，2026-11-03）：只为跟随开始后新出现地址的预览自动打开一次。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startAutoOpen } from '../../src/client/auto-open.ts'
import type { PanelPreview, PanelSnapshot } from '../../src/client/protocol.ts'

const preview = (previewId: string, state: string, url?: string): PanelPreview => ({
  previewId, projectId: 'p', targetId: 't', scope: 'page', strategy: 'isolated', state, freshness: 'unverified',
  ...(url === undefined ? {} : { url }), capabilityGaps: [],
  readiness: { serviceReachable: { status: 'proven' }, documentLoaded: { status: 'unverified' },
    targetMounted: { status: 'unverified' } },
}) as PanelPreview

function harness() {
  let session: string | undefined
  const listeners = new Set<() => void>()
  const streams = new Map<string, { push(value: PanelSnapshot): void; aborted: () => boolean }>()
  const opened: string[] = []
  const stop = startAutoOpen({
    mounted: { getSnapshot: () => session, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
    follow(sessionId, signal) {
      const queue: PanelSnapshot[] = []
      let wake: (() => void) | undefined
      streams.set(sessionId, { push(value) { queue.push(value); wake?.() }, aborted: () => signal.aborted })
      return (async function* () {
        while (!signal.aborted) {
          if (!queue.length) await new Promise<void>(resolve => {
            wake = resolve
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          while (queue.length) yield queue.shift()!
        }
      })()
    },
    open: url => opened.push(url),
  })
  const show = (value: string | undefined) => { session = value; for (const fn of listeners) fn() }
  const push = async (sessionId: string, previews: PanelPreview[]) => {
    streams.get(sessionId)!.push({ previews, diagnostics: [] })
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { show, push, opened, stop, streams }
}

test('previews that become reachable after following starts open once in the Browser tab', async () => {
  const h = harness()
  h.show('S1')
  await h.push('S1', [preview('old', 'reachable', 'http://127.0.0.1:1/old'), preview('pending', 'starting')])
  assert.deepEqual(h.opened, [], 'previews already visible when the session came on screen are not re-opened')
  await h.push('S1', [preview('old', 'reachable', 'http://127.0.0.1:1/old'),
    preview('pending', 'reachable', 'http://127.0.0.1:2/p')])
  assert.deepEqual(h.opened, ['http://127.0.0.1:2/p'], 'a preview starting during follow opens when reachable')
  await h.push('S1', [preview('pending', 'ready', 'http://127.0.0.1:2/p'), preview('new', 'starting')])
  await h.push('S1', [preview('new', 'failed', 'http://127.0.0.1:3/n')])
  assert.deepEqual(h.opened, ['http://127.0.0.1:2/p'], 'no duplicate opens and failed previews never open')
  await h.push('S1', [preview('next', 'ready', 'http://127.0.0.1:4/n')])
  assert.deepEqual(h.opened, ['http://127.0.0.1:2/p', 'http://127.0.0.1:4/n'])
  h.stop()
})

test('switching sessions restarts following and stopping aborts the stream', async () => {
  const h = harness()
  h.show('S1')
  await h.push('S1', [])
  h.show('S2')
  assert.equal(h.streams.get('S1')!.aborted(), true, 'the previous session stream is aborted')
  await h.push('S2', [])
  await h.push('S2', [preview('s2', 'reachable', 'http://127.0.0.1:5/s2')])
  assert.deepEqual(h.opened, ['http://127.0.0.1:5/s2'])
  h.show(undefined)
  assert.equal(h.streams.get('S2')!.aborted(), true)
  h.stop()
})

test('a failed follow stream reconnects while the session stays on screen', async () => {
  let attempts = 0
  const opened: string[] = []
  const errors: unknown[] = []
  const stop = startAutoOpen({
    mounted: { getSnapshot: () => 'S1', subscribe: () => () => {} },
    retryMs: 5,
    follow(_sessionId, signal) {
      attempts++
      const attempt = attempts
      return (async function* () {
        if (attempt === 1) {
          yield { previews: [], diagnostics: [] }
          throw new Error('Runner restarted')
        }
        yield { previews: [preview('fresh', 'reachable', 'http://127.0.0.1:6/f')], diagnostics: [] }
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      })()
    },
    open: url => opened.push(url),
    report: error => errors.push(error),
  })
  for (let index = 0; index < 50 && !opened.length; index++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(attempts, 2, 'the stream was re-established')
  assert.equal(errors.length, 1, 'the failure is reported, not swallowed')
  assert.deepEqual(opened, ['http://127.0.0.1:6/f'], 'a preview that appeared during the gap still opens')
  stop()
})
