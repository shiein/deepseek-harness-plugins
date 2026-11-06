/** Client 启动顺序回归（方案 §4.1、§15.3）：模拟延迟/失败的官方会话目录，不连接 DSH 或模型。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../../dev/bridge/client.mts'

function fixture(refresh) {
  const calls = []
  const scope = {
    sessions: { refresh },
    sidebarRight: {
      mounted: { subscribe: () => () => {}, getSnapshot: () => undefined },
    },
    effect: (effect) => { calls.push('install'); return effect() },
    uiWorkspace: { openSession: (id) => calls.push(id) },
  }
  const ctx = {
    remote: { $mount: async () => { calls.push('mount') } },
    inject: (dependencies, callback) => {
      assert.ok(dependencies.includes('sessions'))
      return callback(scope)
    },
  }
  return { ctx, calls }
}

test('Client waits for the session catalog before installing and navigating to its probe', async () => {
  const baseline = Promise.withResolvers()
  const started = Promise.withResolvers()
  const { ctx, calls } = fixture(() => { started.resolve(); return baseline.promise })
  const activation = apply(ctx)
  await started.promise
  assert.deepEqual(calls, ['mount'])
  baseline.resolve()
  await activation
  assert.deepEqual(calls, ['mount', 'install', 'page-preview-phase0-carrier'])
})

test('Client exposes catalog failure without attempting navigation or installing a stream', async () => {
  const failure = new Error('session catalog unavailable')
  const { ctx, calls } = fixture(async () => { throw failure })
  await assert.rejects(apply(ctx), failure)
  assert.deepEqual(calls, ['mount'])
})
