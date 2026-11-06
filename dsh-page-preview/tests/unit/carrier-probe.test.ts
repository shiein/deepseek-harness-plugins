/** 探针会话所有权与重复订阅回归（方案 §4.1、§15.2）；HTTP 用局部 test mock，不替代 DSH 实测。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { apply, CarrierProbe } from '../../dev/bridge/host.mts'

test('desktop probe rejects non-loopback origins and relative output paths before creating a session', (t) => {
  const ctx = new Context()
  new SessionStore(ctx)
  t.after(() => ctx.fiber.dispose())
  assert.throws(() => apply(ctx, { origin: 'https://example.com', output: '/private/tmp/probe' }), /loopback/)
  assert.throws(() => apply(ctx, { origin: 'http://127.0.0.1:1234', output: '../outside' }), /must be absolute/)
  assert.equal(ctx.sessions.get(SessionId('page-preview-phase0-carrier')), undefined)
})

test('carrier probe rejects foreign acknowledgements and completes only once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-carrier-'))
  t.after(() => rm(dir, { recursive: true }))
  const originalOutput = process.env.DSH_PREVIEW_PROBE_OUTPUT
  process.env.DSH_PREVIEW_PROBE_OUTPUT = join(dir, 'unused-env')
  t.after(() => {
    if (originalOutput === undefined) delete process.env.DSH_PREVIEW_PROBE_OUTPUT
    else process.env.DSH_PREVIEW_PROBE_OUTPUT = originalOutput
  })
  const ctx = new Context()
  new SessionStore(ctx)
  t.after(() => ctx.fiber.dispose())
  const probe = new CarrierProbe(ctx, 'http://127.0.0.1:1234', dir)
  const signal = AbortSignal.timeout(3000)
  assert.equal((await probe.follow('other-session', signal)[Symbol.asyncIterator]().next()).done, true)
  assert.throws(() => probe.acknowledge('other-session', { id: 1, status: 'accepted', detail: '' }), /Unexpected/)
  let loads = 0
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    reports: Array.from({ length: loads }, () => ({ kind: 'document-loaded' })),
  })))
  const stream = probe.follow('page-preview-phase0-carrier', signal)[Symbol.asyncIterator]()
  for (const [index, kind] of ['open', 'refresh', 'close'].entries()) {
    const command = await stream.next()
    assert.equal(command.done, false)
    assert.equal(command.value.kind, kind)
    assert.throws(() => probe.acknowledge('page-preview-phase0-carrier', { id: 99, status: 'accepted', detail: '' }), /Unexpected/)
    probe.acknowledge('page-preview-phase0-carrier', { id: index + 1, status: 'accepted', detail: 'API invoked' })
    if (kind !== 'close') loads++
  }
  assert.equal((await stream.next()).done, true)
  assert.equal(JSON.parse(await readFile(join(dir, 'carrier-observations.json'), 'utf8')).completed, true)
  await assert.rejects(readFile(join(dir, 'unused-env/carrier-observations.json')), { code: 'ENOENT' })
  const calls = fetchMock.mock.callCount()
  assert.equal((await probe.follow('page-preview-phase0-carrier', signal)[Symbol.asyncIterator]().next()).done, true)
  assert.equal(fetchMock.mock.callCount(), calls)
})
