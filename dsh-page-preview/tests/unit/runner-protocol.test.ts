/** 双向 IPC 的身份、结果与嵌套边界（方案 §6.5、§9.2、§15.3）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHostMessage } from '../../src/shared/plan-schema.ts'
import { parseRunnerMessage } from '../../src/shared/ipc-validation.ts'

test('Host protocol requires caller identity and request IDs without echoing malformed payloads', () => {
  const stop = { type: 'stop', requestId: 'r', previewId: 'p', ownerSessionId: 'owner' }
  assert.deepEqual(parseHostMessage(stop), stop)
  for (const message of [{ ...stop, ownerSessionId: '' }, { ...stop, ownerSessionId: undefined }, { ...stop, approved: true }, { type: 'shutdown' }, { type: 'status', requestId: 'r', ownerSessionId: 'owner', secret: 'synthetic-no-echo' }]) {
    assert.throws(() => parseHostMessage(message), error => error instanceof Error && error.message === 'Invalid Host IPC message')
  }
})

test('Runner replies validate nested snapshots and agreement between status and acknowledgement', () => {
  const snapshot = { previewId: 'p', state: 'reachable', freshness: 'unverified', readiness: { serviceReachable: { status: 'proven' }, documentLoaded: { status: 'unverified' }, targetMounted: { status: 'unverified' } } }
  const ack = { type: 'ack', requestId: 'r', ok: true, result: { status: 'ok', previews: [snapshot] } }
  assert.deepEqual(parseRunnerMessage(ack), ack)
  assert.deepEqual(parseRunnerMessage({ type: 'ack', requestId: 'r', ok: false, result: { status: 'busy' } }), { type: 'ack', requestId: 'r', ok: false, result: { status: 'busy' } })
  for (const value of [{ ...ack, ok: false }, { ...ack, result: { status: 'busy' } }, { ...ack, result: { status: 'ok', previews: [{ ...snapshot, type: 'state' }] } }, { ...ack, result: { status: 'ok', previews: [{ ...snapshot, ready: true }] } }, { ...ack, result: { status: 'ok', residual: [1] } }, { type: 'ready-for-commands', pid: 1, node: { executable: '/node', version: 'v24', extra: true } }]) {
    assert.throws(() => parseRunnerMessage(value), /Invalid Runner IPC message/)
  }
})

test('pageText observations cross IPC only with a strict bounded shape', () => {
  const state = { type: 'state', previewId: 'p', state: 'ready', freshness: 'current', readiness: { serviceReachable: { status: 'proven' }, documentLoaded: { status: 'proven' }, targetMounted: { status: 'proven' } } }
  const pageText = { text: '可见文本', url: 'http://127.0.0.1:9000/index.html', truncated: true, receivedAt: new Date().toISOString() }
  assert.deepEqual(parseRunnerMessage({ ...state, pageText }), { ...state, pageText })
  for (const bad of [
    { ...pageText, text: 'x'.repeat(2049) },
    { ...pageText, url: 'x'.repeat(17000) },
    { ...pageText, truncated: 'yes' },
    { ...pageText, receivedAt: 'not a date' },
    { text: 'ok', url: 'http://x/', truncated: false },
    { ...pageText, extra: 'field' },
  ]) {
    assert.throws(() => parseRunnerMessage({ ...state, pageText: bad }), /Invalid Runner IPC message/, JSON.stringify(bad).slice(0, 80))
  }
  // status 快照里同样的形状。
  const snapshot = { previewId: 'p', state: 'ready', freshness: 'current', readiness: { serviceReachable: { status: 'proven' }, documentLoaded: { status: 'proven' }, targetMounted: { status: 'proven' } }, pageText }
  const ack = { type: 'ack', requestId: 'r', ok: true, result: { status: 'ok', previews: [snapshot] } }
  assert.deepEqual(parseRunnerMessage(ack), ack)
  assert.throws(() => parseRunnerMessage({ ...ack, result: { status: 'ok', previews: [{ ...snapshot, pageText: { ...pageText, truncated: 1 } }] } }), /Invalid Runner IPC message/)
})
