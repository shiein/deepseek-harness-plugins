/** Client 面板控制器绑定（方案 §10）：Remote 绑定会话、打开动作经 sidebarRight 入参，不建第二事实源。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { PanelSnapshot } from '../../src/client/protocol.ts'
import { badgeLabel, createPanelController, readinessLabel, stoppable } from '../../src/client/view-model.ts'
import type { PanelRemote } from '../../src/client/view-model.ts'

test('panel controller binds the session for remote calls and forwards the open action', async () => {
  const calls: string[] = []
  const stream: RemoteStreamHandle<PanelSnapshot, never> = {
    send() {},
    end() {},
    dispose() {},
    async *[Symbol.asyncIterator]() {},
  }
  const remote: PanelRemote = {
    follow(sessionId) { calls.push('follow:' + sessionId); return stream },
    async stop(sessionId, previewId) {
      calls.push('stop:' + sessionId + ':' + previewId)
      return { ok: true, value: { status: 'ok', previewId, diagnostics: [] } }
    },
    async open(sessionId, request) {
      calls.push('remote-open:' + sessionId + ':' + request.projectId)
      return { ok: true, value: { status: 'ok', previewId: 'preview-2', diagnostics: [] } }
    },
  }
  const controller = createPanelController(remote, 'session-A', url => calls.push('open:' + url))
  controller.follow(AbortSignal.timeout(1000))
  const reply = await controller.stop('preview-1')
  assert.equal(reply.ok, true)
  controller.openInBrowser('http://127.0.0.1:51234/')
  assert.deepEqual(calls, ['follow:session-A', 'stop:session-A:preview-1', 'open:http://127.0.0.1:51234/'])
})

test('readiness labels never merge evidence into a fabricated ready; stoppable states stay honest', () => {
  const evidence = (status: 'proven' | 'failed' | 'unverified') => ({ status })
  const base = {
    serviceReachable: evidence('proven'), documentLoaded: evidence('proven'), targetMounted: evidence('proven'),
  }
  const preview = (readiness: typeof base) => ({
    readiness,
    previewId: 'p', projectId: 'a', targetId: 't', scope: 'page', strategy: 'static',
    state: 'serving', freshness: 'current', capabilityGaps: [],
  })
  assert.equal(readinessLabel(preview(base)), 'proven')
  assert.equal(readinessLabel(preview({ ...base, targetMounted: evidence('unverified') })), 'unverified')
  assert.equal(readinessLabel(preview({ ...base, serviceReachable: evidence('failed') })), 'failed')
  for (const state of ['stopped', 'failed', 'cleanup_failed']) assert.equal(stoppable(state), false)
  for (const state of ['serving', 'preparing', 'starting']) assert.equal(stoppable(state), true)
})

test('badge labels use the dictionary and fall back to the raw value', () => {
  const t = (key: string) => ({ 'state.ready': '就绪', 'freshness.stale': '' } as Record<string, string>)[key] ?? key
  assert.equal(badgeLabel(t, 'state', 'ready'), '就绪')
  assert.equal(badgeLabel(t, 'state', 'brand_new_state'), 'brand_new_state')
  assert.equal(badgeLabel(t, 'freshness', 'stale'), 'stale')
})
