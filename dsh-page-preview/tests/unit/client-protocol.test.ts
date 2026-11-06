/** Host↔Client 面板协议的 wire 契约（方案 §4.3）：schema 即两端边界，多余或越界字段拒绝。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import remoteInfo, { TYPERT, panelSnapshotSchema, panelStopSchema, panelPreviewSchema } from '../../src/client/protocol.ts'

test('wire descriptors expose follow/stop/open under the pagePreview namespace', () => {
  const ids = remoteInfo.descriptors.map(value => value.id)
  assert.deepEqual(ids.sort(), [
    'dsh-page-preview#pagePreview/follow', 'dsh-page-preview#pagePreview/open',
    'dsh-page-preview#pagePreview/stop',
  ])
  const follow = remoteInfo.descriptors.find(value => value.method === 'follow')
  assert.equal(follow?.mode, 'stream')
  assert.equal(follow?.cancellation?.parameter, 'signal')
  assert.deepEqual(follow?.parameters.map(value => value.wire ?? value.name), ['sessionId'])
  const stop = remoteInfo.descriptors.find(value => value.method === 'stop')
  assert.equal(stop?.mode, undefined)
  assert.deepEqual(stop?.parameters.map(value => value.wire ?? value.name), ['sessionId', 'previewId'])
  const open = remoteInfo.descriptors.find(value => value.method === 'open')
  assert.equal(open?.mode, undefined)
  assert.deepEqual(open?.parameters.map(value => value.wire ?? value.name), ['sessionId', 'request'])
  assert.equal(TYPERT.invocations, remoteInfo.descriptors)
  assert.equal(remoteInfo.package, 'dsh-page-preview')
})

const preview = {
  previewId: 'p1', projectId: 'site', targetId: 'index', scope: 'page', strategy: 'static',
  state: 'reachable', freshness: 'unverified', url: 'http://127.0.0.1:8080/index.html',
  capabilityGaps: [{ name: 'refresh', status: 'conditional' }],
  readiness: {
    serviceReachable: { status: 'proven', at: '2026-11-02T00:00:00.000Z' },
    documentLoaded: { status: 'unverified' },
    targetMounted: { status: 'unverified' },
  },
}

test('panel snapshot accepts the registry projection and rejects extra or malformed fields', () => {
  const ok = panelSnapshotSchema.safeParse({ previews: [preview], diagnostics: [{ code: 'preview_busy', phase: 'start', message: 'busy', location: { file: 'a.ts', line: 3 } }], diagnosticsTruncated: 2 })
  assert.ok(ok.success)
  assert.equal(panelSnapshotSchema.safeParse({ previews: [{ ...preview, env: { SECRET: 'x' } }], diagnostics: [] }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ previews: [{ ...preview, url: 'not a url' }], diagnostics: [] }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ previews: Array.from({ length: 65 }, () => preview), diagnostics: [] }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ previews: [], diagnostics: [] }).success, true)
})

test('panel preview and stop replies stay bounded and enum-checked', () => {
  assert.equal(panelPreviewSchema.safeParse({ ...preview, state: '' }).success, false)
  assert.equal(panelStopSchema.safeParse({ status: 'ok', previewId: 'p1', state: 'stopped', diagnostics: [] }).success, true)
  assert.equal(panelStopSchema.safeParse({ status: 'ready', previewId: 'p1', diagnostics: [] }).success, false)
  assert.equal(panelStopSchema.safeParse({ status: 'ok', previewId: 'p1', diagnostics: Array.from({ length: 17 }, () => ({ code: 'x', phase: 'stop', message: 'm' })) }).success, false)
})
