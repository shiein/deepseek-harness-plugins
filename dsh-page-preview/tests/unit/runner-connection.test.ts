/** 真实 fork IPC 的握手、关联、取消与失败回归（方案 §6.5、§15.3）；仅运行合成对端。 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { RunnerConnection, RunnerConnectionError } from '../../src/host/runner-connection.ts'
import { parseRunnerMessage } from '../../src/shared/ipc-validation.ts'
import type { RunnerToHost } from '../../src/shared/ipc.ts'

const options = { timeout: 10000 }
function setup(t: { after(callback: () => Promise<void>): void }, mode = 'normal', startupTimeoutMs = 3000) {
  const child = fork(fileURLToPath(new URL('../fixtures/runner-ipc/peer.mjs', import.meta.url)), [mode], { cwd: tmpdir(), env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  const connection = new RunnerConnection(child, { startupTimeoutMs, requestTimeoutMs: 1000 })
  t.after(async () => {
    connection.dispose()
    if (child.connected) child.disconnect()
    await exited
    assert.equal(child.listenerCount('message'), 0)
    assert.equal(child.listenerCount('error'), 0)
  })
  return { child, connection, exited }
}
function received(connection: RunnerConnection, previewId: string) {
  return new Promise<void>(resolve => {
    const off = connection.onMessage(message => {
      if (message.type === 'diagnostic' && message.previewId === previewId) { off(); resolve() }
    })
  })
}

test('real IPC associates out-of-order acknowledgements and keeps readiness evidence unchanged', options, async t => {
  const { connection } = setup(t)
  const messages: RunnerToHost[] = []
  connection.onMessage(message => messages.push(message))
  const order: string[] = []
  const slow = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'slow' }).then(ack => { order.push('slow'); return ack })
  const fast = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'fast' }).then(ack => { order.push('fast'); return ack })
  const [a, b] = await Promise.all([slow, fast])
  assert.notEqual(a.requestId, b.requestId)
  assert.deepEqual(order, ['fast', 'slow'])
  assert.equal(messages[0]?.type, 'ready-for-commands')
  const state = messages.find(message => message.type === 'state')
  assert.equal(state?.type, 'state')
  if (state?.type !== 'state') throw new Error('Expected state evidence')
  assert.equal(state.state, 'reachable')
  assert.equal(state.readiness.targetMounted.status, 'unverified')
})

test('negative acknowledgement rejects with the actual diagnostics and leaves the channel usable', options, async t => {
  const { connection } = setup(t)
  await assert.rejects(connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'negative' }), error => {
    assert.ok(error instanceof RunnerConnectionError)
    assert.equal(error.reason, 'rejected')
    assert.deepEqual(error.diagnostics, [{ code: 'cleanup_failed', phase: 'stop', message: 'synthetic residual', hint: 'retry' }])
    return true
  })
  assert.equal((await connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'fast' })).ok, true)
})

test('request timeout does not consume a late acknowledgement as another request result', options, async t => {
  const { connection } = setup(t)
  await connection.ready()
  await assert.rejects(connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'late' }, { timeoutMs: 20 }), { reason: 'request-timeout' })
  await delay(150)
  assert.equal((await connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'fast' })).ok, true)
})

test('cancellation before handshake sends nothing, and cancellation after send only stops waiting', options, async t => {
  const { connection, child } = setup(t, 'delayed-ready')
  const ids: string[] = []
  connection.onMessage(message => { if (message.type === 'diagnostic') ids.push(message.previewId) })
  const early = new AbortController()
  const waiting = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'cancel-before-ready' }, { signal: early.signal })
  early.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  await connection.ready()
  assert.deepEqual(ids, [])
  const active = new AbortController()
  const seen = received(connection, 'never')
  const pending = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'never' }, { signal: active.signal })
  await seen
  active.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(child.connected, true)
  assert.equal((await connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'fast' })).ok, true)
})

test('unexpected peer exit rejects every pending waiter and reports failure once', options, async t => {
  const { connection, exited } = setup(t)
  const failures: RunnerConnectionError[] = []
  connection.onFailure(error => failures.push(error))
  const a = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'never' })
  const b = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'exit' })
  const results = await Promise.allSettled([a, b])
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof RunnerConnectionError))
  assert.equal(await exited, 17)
  assert.equal(failures.length, 1)
  await assert.rejects(connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'fast' }), RunnerConnectionError)
})

test('malformed peer data fails pending requests without echoing the untrusted payload', options, async t => {
  const { connection } = setup(t)
  await assert.rejects(connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'bad-ack' }), error => {
    assert.ok(error instanceof RunnerConnectionError)
    assert.equal(error.reason, 'protocol')
    assert.doesNotMatch(String(error) + String(error.cause), /synthetic-do-not-echo/)
    return true
  })
})

test('wrong PID, pre-handshake messages and missing handshake fail explicitly', options, async t => {
  for (const mode of ['wrong-pid', 'before-ready', 'no-ready']) {
    const { connection } = setup(t, mode, mode === 'no-ready' ? 150 : 3000)
    await assert.rejects(connection.ready(), { reason: mode === 'no-ready' ? 'startup-timeout' : 'protocol' })
  }
})

test('a repeated handshake is a protocol failure; dispose releases waiters without stopping the peer', options, async t => {
  const duplicate = setup(t, 'duplicate-ready')
  const failed = new Promise<RunnerConnectionError>(resolve => duplicate.connection.onFailure(resolve))
  assert.equal((await failed).reason, 'protocol')
  const { connection, child } = setup(t)
  const seen = received(connection, 'never')
  const pending = connection.request({ type: 'stop', ownerSessionId: 'ipc-test', previewId: 'never' })
  await seen
  connection.dispose()
  await assert.rejects(pending, { reason: 'disposed' })
  assert.equal(child.connected, true)
  connection.dispose()
})

test('IPC validator rejects unknown fields, invalid nested evidence and inconsistent scalar types', () => {
  const readiness = { serviceReachable: { status: 'proven' }, documentLoaded: { status: 'unverified' }, targetMounted: { status: 'unverified' } }
  const state = { type: 'state', previewId: 'p', state: 'reachable', freshness: 'unverified', readiness }
  assert.deepEqual(parseRunnerMessage(state), state)
  for (const value of [null, [], { type: 'unknown' }, { type: 'ack', requestId: '', ok: true }, { type: 'ack', requestId: 'r', ok: 1 }, { ...state, state: 'needs_configuration' }, { ...state, readiness: { ...readiness, targetMounted: { status: 'ready' } } }, { ...state, ready: true }, { type: 'diagnostic', previewId: 'p', diagnostic: { code: 'runtime_error', phase: 'stop', message: 'm', location: { line: -1 } } }]) {
    assert.throws(() => parseRunnerMessage(value), /Invalid Runner IPC message/)
  }
})

test('disposing before a failed fork still observes its asynchronous process error', options, async () => {
  const child = fork(fileURLToPath(new URL('../fixtures/runner-ipc/peer.mjs', import.meta.url)), [], { execPath: '/nonexistent-dsh-preview-test-node', execArgv: [], env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const connection = new RunnerConnection(child)
  connection.dispose()
  await assert.rejects(connection.ready(), RunnerConnectionError)
  await new Promise(setImmediate)
  assert.equal(child.listenerCount('error'), 0)
})
