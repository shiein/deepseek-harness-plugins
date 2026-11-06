/** Runner 会话生命周期（方案 §9.2、§15.3）：合成状态与真实独立 Node 服务分别验证。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Adapter, RunEvent, RunningHandle, StartContext } from '../../src/adapters/types.ts'
import type { PreviewPlan, SessionState } from '../../src/shared/contracts.ts'
import type { RunnerToHost } from '../../src/shared/ipc.ts'
import { RunnerSession } from '../../src/runner/session.ts'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'
import type { ManagedProcess } from '../../src/runner/process-tree.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'

const options = { timeout: 10000 }
const unsupported = { status: 'unsupported', source: 'none', reason: 'Lifecycle fixture only' } as const
function plan(): PreviewPlan {
  return {
    projectId: 'fixture', targetId: 'orders', selector: { kind: 'route', path: '/orders/' }, scope: 'page', strategy: 'project',
    adapter: { id: 'lifecycle-fixture', version: '1' }, toolchain: {}, requirements: [], process: { kind: 'in-runner' },
    readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 1000 },
    capabilities: { scopes: {}, isolatedRender: unsupported, scenarioApply: unsupported, scenarioReset: unsupported, refresh: { status: 'supported', source: 'adapter', coverage: ['Synthetic update outcomes in lifecycle tests'] }, captureCurrentView: unsupported, runtimeErrors: unsupported, readinessAssertion: unsupported, network: [] },
    fingerprints: { config: 'synthetic-fixture' }, missing: [], knownDifferences: ['Lifecycle test adapter; not a product adapter'],
  }
}
function adapter(start: Adapter['start']): Adapter {
  return {
    id: 'lifecycle-fixture', version: '1', strategies: ['project'],
    features: { scenarios: false, targetAssertions: false, isolatedTarget: false },
    start,
    async probe() { throw new Error('Not used by lifecycle tests') },
    async discover() { throw new Error('Not used by lifecycle tests') },
    async plan() { throw new Error('Not used by lifecycle tests') },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function handle(overrides: Partial<RunningHandle> = {}): RunningHandle { return { url: 'http://127.0.0.1:12345/orders/', async stop() { return { residual: [] } }, ...overrides } }
function proof(ctx: StartContext, layer: 'serviceReachable' | 'documentLoaded' | 'targetMounted') { ctx.emit({ type: 'evidence', layer, evidence: { status: 'proven' } }) }
function ready(ctx: StartContext) { proof(ctx, 'serviceReachable'); proof(ctx, 'documentLoaded'); proof(ctx, 'targetMounted') }
async function setup(t: { after(callback: () => Promise<void>): void }, value = plan(), cleanupTimeoutMs = 500) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-session-')))
  const ledger = createFileLedger(dir)
  const session = new RunnerSession('lifecycle-test', value, { cleanupTimeoutMs })
  t.after(async () => { const stopped = await session.stop(); assert.deepEqual(stopped.residual, []); await rm(dir, { recursive: true, force: true }) })
  const context: Omit<StartContext, 'previewId' | 'plan' | 'signal' | 'deadline' | 'emit'> = {
    workspaceRoot: dir, appRoot: dir, ownerSessionId: 'isolated-test-session', ledger,
    config: { source: { kind: 'detected' }, project: { id: 'fixture', root: '.', runtime: {} }, diagnostics: [] },
    profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] },
  }
  return { session, ledger, context, dir }
}
function waitState(session: RunnerSession, state: SessionState): Promise<void> {
  if (session.state === state) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Expected session state ' + state)) }, 5000)
    const off = session.onMessage(message => { if (message.type === 'state' && message.state === state) { off(); clearTimeout(timer); resolve() } })
  })
}

test('service and a handle only prove reachable; snapshots do not invent target readiness or freshness', options, async t => {
  const { session, context } = await setup(t)
  await session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle() }), context)
  assert.equal(session.state, 'reachable')
  assert.equal(session.freshness, 'unverified')
  assert.equal(session.readiness.targetMounted.status, 'unverified')
  const snapshot = session.snapshot()
  snapshot.readiness.serviceReachable.status = 'failed'
  assert.equal(session.readiness.serviceReachable.status, 'proven')
})

test('ready requires all three proofs plus the returned handle, even when proofs arrive out of order', options, async t => {
  const value = plan()
  value.readiness.assertions = [{ kind: 'mount-signal' }]
  const { session, context } = await setup(t, value)
  const entered = deferred<StartContext>()
  const finish = deferred<RunningHandle>()
  const started = session.start(adapter(async ctx => { entered.resolve(ctx); return finish.promise }), context)
  const ctx = await entered.promise
  proof(ctx, 'targetMounted'); proof(ctx, 'serviceReachable'); proof(ctx, 'documentLoaded')
  assert.equal(session.state, 'starting')
  assert.equal(session.snapshot().url, undefined)
  finish.resolve(handle())
  await started
  assert.equal(session.state, 'ready')
  assert.equal(session.freshness, 'unverified')
})

test('required target timeout fails after cleanup instead of turning HTTP reachability into ready', options, async t => {
  const value = plan()
  value.readiness.targetDeadlineMs = 20
  value.readiness.assertions = [{ kind: 'text-present', text: 'Orders' }]
  const { session, context } = await setup(t, value)
  let stops = 0
  await assert.rejects(session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle({ async stop() { stops++; return { residual: [] } } }) }), context), error => error instanceof Error && 'diagnostic' in error && session.diagnostics[0]?.code === 'target_not_ready')
  assert.equal(session.state, 'failed')
  assert.equal(stops, 1)
  assert.equal(session.readiness.targetMounted.status, 'unverified')
})

test('service timeout aborts cooperative startup and pre-cancelled startup never invokes the adapter', options, async t => {
  const value = plan()
  value.readiness.serviceDeadlineMs = 20
  const { session, context } = await setup(t, value)
  await assert.rejects(session.start(adapter(ctx => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }))), context))
  assert.equal(session.state, 'failed')
  assert.equal(session.diagnostics[0]?.code, 'start_timeout')
  const second = await setup(t)
  const signal = new AbortController()
  signal.abort()
  let calls = 0
  await assert.rejects(second.session.start(adapter(async () => { calls++; return handle() }), second.context, signal.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  assert.equal(second.session.state, 'failed')
})

test('pending startup is a cleanup failure; a late handle is stopped and cannot resurrect the session', options, async t => {
  const { session, context } = await setup(t, plan(), 20)
  const entered = deferred<void>()
  const finish = deferred<RunningHandle>()
  const started = session.start(adapter(async () => { entered.resolve(); return finish.promise }), context)
  const rejected = assert.rejects(started)
  await entered.promise
  const a = session.stop()
  const b = session.stop()
  assert.equal(a, b)
  assert.ok((await a).residual.includes('Adapter startup is still pending'))
  assert.equal(session.state, 'cleanup_failed')
  await rejected
  let stops = 0
  const stopped = waitState(session, 'stopped')
  finish.resolve(handle({ async stop() { stops++; return { residual: [] } } }))
  await stopped
  assert.equal(stops, 1)
  assert.deepEqual(await session.stop(), { residual: [] })
})

test('throwing and timed out handle cleanup stay retryable without duplicate concurrent cleanup', options, async t => {
  const first = await setup(t)
  let stops = 0
  const cleanupError = new Error('Synthetic cleanup error')
  await first.session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle({ async stop() { if (++stops === 1) throw cleanupError; return { residual: [] } } }) }), first.context)
  assert.ok((await first.session.stop()).residual.length)
  assert.equal(first.session.state, 'cleanup_failed')
  assert.equal(first.session.lastCleanupError, cleanupError)
  assert.deepEqual(await first.session.stop(), { residual: [] })
  assert.equal(stops, 2)
  const second = await setup(t, plan(), 20)
  const finish = deferred<{ residual: string[] }>()
  let calls = 0
  await second.session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle({ stop() { calls++; return finish.promise } }) }), second.context)
  assert.ok((await second.session.stop()).residual.includes('Adapter cleanup is still pending'))
  assert.equal(second.session.state, 'cleanup_failed')
  const stopped = waitState(second.session, 'stopped')
  finish.resolve({ residual: [] })
  await stopped
  assert.equal(calls, 1)
})

test('a failed session stays failed when late cleanup retries settle; only clean explicit stops reach stopped', options, async t => {
  const first = await setup(t, plan(), 20)
  let emit!: (event: RunEvent) => void
  const finish = deferred<{ residual: string[] }>()
  await first.session.start(adapter(async ctx => { emit = ctx.emit; proof(ctx, 'serviceReachable'); return handle({ stop() { return finish.promise } }) }), first.context)
  const messages: RunnerToHost[] = []
  first.session.onMessage(message => messages.push(message))
  emit({ type: 'exited', code: 1, signal: null })
  await waitState(first.session, 'cleanup_failed')
  assert.ok(first.session.residual.includes('Adapter cleanup is still pending'))
  finish.resolve({ residual: [] })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Failed session did not return to failed state')), 5000)
    const off = first.session.onMessage(message => { if (message.type === 'state' && message.state === 'failed') { off(); clearTimeout(deadline); resolve() } })
  })
  assert.equal(first.session.state, 'failed')
  assert.deepEqual(await first.session.stop(), { residual: [] })
  assert.equal(first.session.state, 'failed')
  assert.ok(first.session.diagnostics.some(item => item.code === 'runtime_error'))
  assert.ok(!messages.some(message => message.type === 'stopped' || message.type === 'state' && message.state === 'stopped'))
  const second = await setup(t)
  await second.session.start(adapter(async ctx => { emit = ctx.emit; proof(ctx, 'serviceReachable'); return handle() }), second.context)
  emit({ type: 'exited', code: 1, signal: null })
  await waitState(second.session, 'failed')
  assert.deepEqual(await second.session.stop(), { residual: [] })
  assert.equal(second.session.state, 'failed')
  const third = await setup(t)
  await third.session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle() }), third.context)
  assert.deepEqual(await third.session.stop(), { residual: [] })
  assert.equal(third.session.state, 'stopped')
})

test('adapter success cannot erase ledger residuals or reuse a preview ID with persisted resources', options, async t => {
  const { session, ledger, context, dir } = await setup(t)
  await session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle() }), context)
  const entry = await ledger.record({ previewId: session.previewId, ownerSessionId: context.ownerSessionId, workspaceRoot: dir, resource: { kind: 'path', path: dir } })
  assert.ok((await session.stop()).residual.some(item => item.includes(entry.id)))
  assert.equal((await ledger.listByPreview(session.previewId)).length, 1)
  await ledger.release(entry.id)
  assert.deepEqual(await session.stop(), { residual: [] })
  const second = await setup(t)
  const existing = await second.ledger.record({ previewId: second.session.previewId, ownerSessionId: 'other-owner', workspaceRoot: second.dir, resource: { kind: 'path', path: second.dir } })
  let calls = 0
  await assert.rejects(second.session.start(adapter(async () => { calls++; return handle() }), second.context))
  assert.equal(calls, 0)
  assert.equal(second.session.state, 'cleanup_failed')
  assert.equal((await second.ledger.listByPreview(second.session.previewId)).length, 1)
  await second.ledger.release(existing.id)
})

test('compile errors retain the old state and stale freshness; successful retry recovers without restart', options, async t => {
  const { session, context } = await setup(t)
  let calls = 0
  await session.start(adapter(async ctx => {
    ready(ctx)
    ctx.emit({ type: 'freshness', freshness: 'current' })
    return handle({ async refresh() { return ++calls === 1 ? { kind: 'compile-error', diagnostics: [{ code: 'compile_error', phase: 'update', message: 'Synthetic compile failure' }] } : { kind: 'updated', freshness: 'current' } } })
  }), context)
  await session.refresh()
  assert.equal(session.state, 'ready')
  assert.equal(session.freshness, 'stale')
  assert.equal(session.diagnostics.at(-1)?.code, 'compile_error')
  await session.refresh()
  assert.equal(session.state, 'ready')
  assert.equal(session.freshness, 'current')
})

test('page-text observations are redacted against env values, bounded and published on the snapshot', options, async t => {
  const { session, context, dir } = await setup(t)
  context.config.project.runtime.env = { TOKEN: 'session-secret-7' }
  await writeFile(join(dir, '.env'), 'FILE_SECRET=file-secret-9\n')
  let ctx: StartContext | undefined
  await session.start(adapter(async value => { ctx = value; proof(value, 'serviceReachable'); return handle() }), context)
  const observation = { text: 'token session-secret-7 file-secret-9', url: 'http://127.0.0.1:12345/orders/?q=file-secret-9', truncated: true, receivedAt: new Date().toISOString() }
  ctx!.emit({ type: 'page-text', observation })
  // 转发的 text/url 去掉 env 值与 query；观察不改动 readiness 或 freshness。
  assert.equal(session.pageText?.text, 'token [redacted] [redacted]')
  assert.equal(session.pageText?.url, 'http://127.0.0.1:12345/orders')
  assert.equal(session.pageText?.truncated, true)
  assert.deepEqual(session.snapshot().pageText, session.pageText && structuredClone(session.pageText))
  assert.equal(session.readiness.targetMounted.status, 'unverified')
  assert.equal(session.freshness, 'unverified')
  // 长文本在存储边界仍按 PAGE_TEXT_LIMIT 截断并注明。
  ctx!.emit({ type: 'page-text', observation: { ...observation, text: 'y'.repeat(2100) } })
  assert.ok(session.pageText!.text.length <= 2048 + 20)
  assert.ok(session.pageText!.text.endsWith('[truncated]'))
})

test('restart-required stops the existing handle and fails without silently launching a replacement', options, async t => {
  const { session, context } = await setup(t)
  let starts = 0
  let stops = 0
  await session.start(adapter(async ctx => { starts++; ready(ctx); return handle({ async refresh() { return { kind: 'restart-required', reason: 'configuration changed' } }, async stop() { stops++; return { residual: [] } } }) }), context)
  await assert.rejects(session.refresh())
  assert.equal(session.state, 'failed')
  assert.equal(session.freshness, 'stale')
  assert.equal(starts, 1)
  assert.equal(stops, 1)
})

test('late refresh results cannot undo a stop and simultaneous refresh requests share one update', options, async t => {
  const { session, context } = await setup(t)
  const finish = deferred<{ kind: 'updated'; freshness: 'current' }>()
  await session.start(adapter(async ctx => { ready(ctx); return handle({ refresh() { return finish.promise } }) }), context)
  const a = session.refresh()
  const b = session.refresh()
  assert.equal(a, b)
  await session.stop()
  finish.resolve({ kind: 'updated', freshness: 'current' })
  await a
  assert.equal(session.state, 'stopped')
  assert.equal(session.freshness, 'unverified')
})

test('unexpected origins and failed readiness evidence fail and clean up the returned handle', options, async t => {
  for (const badOrigin of ['http://example.com/orders/', 'http://user:synthetic-secret@127.0.0.1:3000/orders/']) {
    const { session, context } = await setup(t)
    let stops = 0
    await assert.rejects(session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle({ url: badOrigin, async stop() { stops++; return { residual: [] } } }) }), context))
    assert.equal(stops, 1)
    assert.equal(session.state, 'failed')
    assert.equal(session.diagnostics[0]?.code, 'ownership_unverified')
    assert.doesNotMatch(JSON.stringify(session.diagnostics), /synthetic-secret/)
  }
  const { session, context } = await setup(t)
  let ctx: StartContext | undefined
  await session.start(adapter(async value => { ctx = value; proof(value, 'serviceReachable'); return handle() }), context)
  const failed = waitState(session, 'failed')
  ctx!.emit({ type: 'evidence', layer: 'targetMounted', evidence: { status: 'failed', detail: 'Synthetic missing provider' } })
  await failed
  assert.equal(session.diagnostics[0]?.code, 'target_not_ready')
})

test('startup cancellation releases its handle, but a signal aborted after completed startup does not stop the preview', options, async t => {
  const first = await setup(t)
  const entered = deferred<void>()
  const signal = new AbortController()
  let stops = 0
  const pending = first.session.start(adapter(async () => { entered.resolve(); return handle({ async stop() { stops++; return { residual: [] } } }) }), first.context, signal.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  signal.abort()
  await rejected
  assert.equal(stops, 1)
  assert.equal(first.session.state, 'failed')
  const second = await setup(t)
  const later = new AbortController()
  await second.session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle() }), second.context, later.signal)
  later.abort()
  assert.equal(second.session.state, 'reachable')
  assert.deepEqual(await second.session.stop(), { residual: [] })
})

async function serviceAdapter(observe: (proc: ManagedProcess, port: number) => void, gate?: Promise<void>): Promise<Adapter> {
  return adapter(async ctx => {
    if (gate) await gate // 有意模拟不接收取消的异步构建器，供迟到句柄回收测试。
    const fixture = fileURLToPath(new URL('../fixtures/non-vite-existing-server/server.mjs', import.meta.url))
    const proc = await spawnManaged({ executable: process.execPath, args: [fixture, '0'], cwd: ctx.appRoot, env: {} }, ctx.ledger, { previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot })
    try {
      let text = ''
      let origin = ''
      for await (const chunk of proc.stdout) { text += chunk; if (text.includes('\n')) { origin = JSON.parse(text.split('\n')[0]!).origin; break } }
      const port = Number(new URL(origin).port)
      observe(proc, port)
      assert.equal(await readProcessStartTime(proc.pid), proc.startTime)
      assert.deepEqual(await findListeningPids(port), [proc.pid])
      const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(2000) })
      assert.equal((await health.json() as { sample: string }).sample, 'non-vite-orders')
      const entry = await ctx.ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot, resource: { kind: 'port', port, pid: proc.pid } })
      proof(ctx, 'serviceReachable')
      void proc.exited.then(exit => ctx.emit({ type: 'exited', ...exit }))
      return {
        url: origin + '/orders/',
        async stop() {
          const residual = await proc.stop(100)
          if (!residual.length) await ctx.ledger.release(entry.id)
          return { residual: residual.map(pid => 'process ' + pid) }
        },
      }
    } catch (error) {
      assert.deepEqual(await proc.stop(100), [])
      throw error
    }
  })
}

test('real managed non-Vite service reaches only reachable and repeated stop releases PID, port and ledger',
  { ...options, skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const { session, context, ledger } = await setup(t)
  let child: ManagedProcess | undefined
  let port = 0
  await session.start(await serviceAdapter((proc, actual) => { child = proc; port = actual }), context)
  assert.equal(session.state, 'reachable')
  assert.equal((await ledger.listByPreview(session.previewId)).length, 2)
  assert.deepEqual(await session.stop(), { residual: [] })
  assert.equal(await readProcessStartTime(child!.pid), undefined)
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await ledger.listByPreview(session.previewId), [])
})

test('real unexpected service exit fails after verified cleanup and retains runtime diagnostics',
  { ...options, skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const { session, context, ledger } = await setup(t)
  let child: ManagedProcess | undefined
  let port = 0
  await session.start(await serviceAdapter((proc, actual) => { child = proc; port = actual }), context)
  const failed = waitState(session, 'failed')
  assert.equal(await readProcessStartTime(child!.pid), child!.startTime)
  process.kill(child!.pid, 'SIGTERM')
  await failed
  assert.equal(session.diagnostics[0]?.code, 'runtime_error')
  assert.deepEqual(await ledger.listByPreview(session.previewId), [])
  assert.deepEqual(await findListeningPids(port), [])
})

test('a real service returned after stop timeout is automatically reclaimed instead of publishing readiness',
  { ...options, skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const { session, context, ledger } = await setup(t, plan(), 30)
  const gate = deferred<void>()
  const entered = deferred<void>()
  let child: ManagedProcess | undefined
  let port = 0
  const actual = await serviceAdapter((proc, value) => { child = proc; port = value }, gate.promise)
  const start = session.start(adapter(async ctx => { entered.resolve(); return actual.start(ctx) }), context)
  const rejected = assert.rejects(start)
  await entered.promise
  assert.ok((await session.stop()).residual.length)
  assert.equal(session.state, 'cleanup_failed')
  await rejected
  const stopped = waitState(session, 'stopped')
  gate.resolve()
  await stopped
  assert.equal(await readProcessStartTime(child!.pid), undefined)
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await ledger.listByPreview(session.previewId), [])
  assert.equal(session.readiness.serviceReachable.status, 'unverified')
})

// R3-5（§9.1）：turn/end 输入变化在 Runner 会话侧的分级——
// 执行项/配置文件/.env 走 restart/approval 诊断不更新；场景 bodyFile 走就地重载；其余交给适配器裁量。
function watchDiscretion() {
  const calls: string[][] = []
  const spy = async (paths: string[]) => {
    calls.push([...paths])
    return { kind: 'ignored', reason: 'Synthetic coverage' } as const
  }
  return { calls, spy }
}
const startReachable = (session: RunnerSession,
  context: Parameters<RunnerSession['start']>[1],
  overrides: Parameters<typeof handle>[0] = {},
) => session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle(overrides) }), context)
const configFile = (dir: string) => join(dir, 'page-preview.config.json')
function explicitSource(context: { config: { source: unknown } }, dir: string) {
  context.config.source = { kind: 'explicit', file: configFile(dir) }
}
const diagnosticCodes = (session: RunnerSession) => session.diagnostics.map(item => item.code)

test('configuration file changes take the restart path and never reach adapter discretion', options, async t => {
  const { session, context, dir } = await setup(t)
  explicitSource(context, dir)
  const spy = watchDiscretion()
  await startReachable(session, context, { inputsChanged: spy.spy })
  await session.inputsChanged(['page-preview.config.json', 'src/app.ts'])
  assert.equal(session.freshness, 'stale')
  assert.deepEqual(diagnosticCodes(session), ['preview_needs_restart'])
  // 重启主导：一旦需要 restart/approval，同批其余路径不再交付适配器（就地更新已无意义）。
  assert.deepEqual(spy.calls, [])
})

test('setup and scenario handler files require fresh approval instead of an in-place update', options, async t => {
  const { session, context } = await setup(t)
  context.config.project.runtime = { setup: 'preview/setup.js' }
  context.config.project.scenarios = { default: { handlers: 'preview/handlers.js' } }
  const spy = watchDiscretion()
  await startReachable(session, context, { inputsChanged: spy.spy })
  await session.inputsChanged(['preview/setup.js', 'preview/handlers.js'])
  assert.equal(session.freshness, 'stale')
  assert.deepEqual(diagnosticCodes(session), ['config_changed_needs_approval'])
  assert.deepEqual(spy.calls, [])
})

test('dotenv family files are restart inputs anywhere inside the application root', options, async t => {
  const { session, context } = await setup(t)
  const spy = watchDiscretion()
  await startReachable(session, context, { inputsChanged: spy.spy })
  await session.inputsChanged(['.env', 'config/.env.local', 'env-not-matching.txt'])
  assert.equal(session.freshness, 'stale')
  assert.deepEqual(diagnosticCodes(session), ['preview_needs_restart'])
  // restart 命中时提前返回：env-not-matching.txt 虽非执行输入，也不在该批交付裁量。
  assert.deepEqual(spy.calls, [])
})

test('scenario bodyFile changes attempt an in-place reload and report failure honestly', options, async t => {
  const value = plan()
  value.scenario = 'default'
  const { session, context } = await setup(t, value)
  context.config.project.scenarios = { default: {
    http: [{ method: 'GET', path: '/api/orders', response: { status: 200, bodyFile: 'fixtures/orders.json' } }],
  } }
  const spy = watchDiscretion()
  await startReachable(session, context, { inputsChanged: spy.spy })
  await session.inputsChanged(['fixtures/orders.json'])
  const diagnostic = session.diagnostics.find(item => item.code === 'runtime_error')
  assert.ok(diagnostic !== undefined, 'fixture reload failure must surface a diagnostic')
  assert.ok(diagnostic.message.includes('does not support scenario updates'), diagnostic.message)
  // 重载失败不伪造 freshness；也不把 bodyFile 交给适配器裁量。
  assert.equal(session.freshness, 'unverified')
  assert.deepEqual(spy.calls, [])
})

test('scenario bodyFile changes reload through the running handle when bindings exist', options, async t => {
  const value = plan()
  value.scenario = 'default'
  const { session, context, dir } = await setup(t, value)
  explicitSource(context, dir)
  const scene = { businessPaths: ['/api/**'],
    http: [{ method: 'GET', path: '/api/orders', response: { status: 200, bodyFile: 'fixtures/orders.json' } }] }
  context.config.project.scenarios = { default: scene }
  await writeFile(configFile(dir), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'fixture', root: '.', runtime: {}, scenarios: { default: scene } }] }))
  await mkdir(join(dir, 'fixtures'), { recursive: true })
  await writeFile(join(dir, 'fixtures/orders.json'), '[{"id":1}]')
  const switched: string[] = []
  session.reloadBinding = { dataDir: dir, configFile: configFile(dir) }
  await startReachable(session, context, {
    async switchScenario(update) { switched.push(update.name); return { kind: 'updated', freshness: 'current' } },
  })
  await session.inputsChanged(['fixtures/orders.json'])
  assert.deepEqual(switched, ['default'], JSON.stringify(session.diagnostics))
  assert.equal(session.freshness, 'current')
  assert.deepEqual(diagnosticCodes(session), [])
})

test('restart-required marks stale with a diagnostic; ignored leaves the preview untouched', options, async t => {
  const { session, context } = await setup(t)
  const seen: string[][] = []
  await session.start(adapter(async ctx => {
    proof(ctx, 'serviceReachable')
    return handle({ async inputsChanged(paths) {
      seen.push([...paths])
      return seen.length === 1
        ? { kind: 'restart-required', reason: 'build configuration changed' }
        : { kind: 'ignored', reason: 'covered by the dev server' }
    } })
  }), context)
  await session.inputsChanged(['vite.config.ts'])
  assert.equal(session.freshness, 'stale')
  assert.deepEqual(diagnosticCodes(session), ['preview_needs_restart'])
  await session.inputsChanged(['src/widget.vue'])
  assert.deepEqual(seen, [['vite.config.ts'], ['src/widget.vue']])
  assert.equal(diagnosticCodes(session).length, 1, 'an ignored decision adds no diagnostic')
})

test('paths without an adapter discretion channel record stale without a diagnostic', options, async t => {
  const { session, context } = await setup(t)
  await session.start(adapter(async ctx => { proof(ctx, 'serviceReachable'); return handle() }), context)
  await session.inputsChanged(['src/app.ts'])
  assert.equal(session.freshness, 'stale')
  assert.deepEqual(diagnosticCodes(session), [])
})

test('changes outside the application root are ignored; surviving paths arrive app-root relative', options, async t => {
  const { session, context, dir } = await setup(t)
  context.appRoot = join(dir, 'app')
  const spy = watchDiscretion()
  await startReachable(session, context, { inputsChanged: spy.spy })
  await session.inputsChanged(['elsewhere/readme.md', 'app/src/widget.vue'])
  assert.deepEqual(spy.calls, [['src/widget.vue']])
  assert.equal(session.freshness, 'unverified')
})

test('scenario switch updates the plan binding and clears the unmatched log', options, async t => {
  const value = plan()
  value.scenario = 'first'
  const { session, context, dir } = await setup(t, value)
  explicitSource(context, dir)
  context.config.project.scenarios = { first: { props: { title: 'One' } }, second: { props: { title: 'Two' } } }
  await writeFile(configFile(dir), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'fixture', root: '.', runtime: {},
      scenarios: { first: { props: { title: 'One' } }, second: { props: { title: 'Two' } } } }] }))
  session.reloadBinding = { dataDir: dir, configFile: configFile(dir) }
  const seen: string[] = []
  await session.start(adapter(async ctx => {
    ready(ctx)
    ctx.emit({ type: 'unmatched', request: { method: 'GET', path: '/api/ghost' } })
    return handle({ async switchScenario(update) {
      seen.push(update.name)
      return { kind: 'updated', freshness: 'current' }
    } })
  }), context)
  assert.ok(session.snapshot().unmatched !== undefined, 'fixture unmatched request must be recorded')
  const outcome = await session.switchScenario('second')
  assert.equal(outcome.kind, 'updated')
  assert.deepEqual(seen, ['second'])
  assert.equal(session.plan.scenario, 'second')
  assert.ok(session.plan.fingerprints.scenario !== undefined)
  assert.equal(session.snapshot().unmatched, undefined, 'switch clears the unmatched log')
  assert.equal(session.freshness, 'current')
})

test('a scenario update the worker could not apply keeps the old scenario binding and state', options, async t => {
  const value = plan()
  value.scenario = 'first'
  const { session, context, dir } = await setup(t, value)
  explicitSource(context, dir)
  context.config.project.scenarios = { first: { props: { title: 'One' } }, second: { props: { title: 'Two' } } }
  await writeFile(configFile(dir), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'fixture', root: '.', runtime: {},
      scenarios: { first: { props: { title: 'One' } }, second: { props: { title: 'Two' } } } }] }))
  session.reloadBinding = { dataDir: dir, configFile: configFile(dir) }
  await session.start(adapter(async ctx => {
    ready(ctx)
    return handle({ async switchScenario() { return { kind: 'compile-error', diagnostics: [{
      code: 'compile_error', phase: 'update',
      message: 'Preview entry did not become servable within its deadline; the update was not applied',
      hint: 'Fix the reported compile error, then retry',
    }] } } })
  }), context)
  const outcome = await session.switchScenario('second')
  assert.equal(outcome.kind, 'compile-error')
  assert.equal(session.state, 'ready', 'a recoverable update failure returns to the previous state')
  assert.equal(session.plan.scenario, 'first', 'an unapplied switch keeps the old scenario name')
  assert.equal(session.freshness, 'stale')
  assert.ok(session.diagnostics.some(value => value.code === 'compile_error'),
    'the not-applied diagnostic must be recorded')
})

test('failed scenario preflights never reach the worker and leave the preview untouched', options, async t => {
  const value = plan()
  value.scenario = 'first'
  const { session, context, dir } = await setup(t, value)
  explicitSource(context, dir)
  context.config.project.scenarios = { first: { props: { title: 'One' } } }
  await writeFile(configFile(dir), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'fixture', root: '.', runtime: {}, scenarios: { first: { props: { title: 'One' } } } }] }))
  session.reloadBinding = { dataDir: dir, configFile: configFile(dir) }
  let calls = 0
  await session.start(adapter(async ctx => {
    ready(ctx)
    return handle({ async switchScenario() { calls++; return { kind: 'updated', freshness: 'current' } } })
  }), context)
  await assert.rejects(session.switchScenario('ghost'), /not configured/)
  assert.equal(calls, 0, 'preflight rejection must happen before the worker update')
  assert.equal(session.state, 'ready')
  assert.equal(session.plan.scenario, 'first')
})

test('a switch that resolves after stop cannot rewrite the stopped plan', options, async t => {
  const value = plan()
  value.scenario = 'first'
  const { session, context, dir } = await setup(t, value)
  explicitSource(context, dir)
  context.config.project.scenarios = { first: {}, second: {} }
  await writeFile(configFile(dir), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'fixture', root: '.', runtime: {}, scenarios: { first: {}, second: {} } }] }))
  session.reloadBinding = { dataDir: dir, configFile: configFile(dir) }
  const gate = deferred<{ kind: 'updated'; freshness: 'current' }>()
  await session.start(adapter(async ctx => {
    ready(ctx)
    return handle({ async switchScenario() { return gate.promise } })
  }), context)
  const switching = session.switchScenario('second')
  await waitState(session, 'updating')
  await session.stop()
  gate.resolve({ kind: 'updated', freshness: 'current' })
  await switching
  assert.equal(session.state, 'stopped')
  assert.equal(session.plan.scenario, 'first', 'late success must not resurrect a stopped preview')
})

test('inputs arriving during an update are queued and re-judged after it settles', options, async t => {
  const { session, context } = await setup(t)
  const spy = watchDiscretion()
  const gate = deferred<{ kind: 'updated'; freshness: 'current' }>()
  const notified = deferred<void>()
  await session.start(adapter(async ctx => {
    proof(ctx, 'serviceReachable')
    return handle({
      async refresh() { return gate.promise },
      async inputsChanged(paths) { notified.resolve(); return spy.spy(paths) },
    })
  }), context)
  const updating = session.refresh()
  await waitState(session, 'updating')
  await session.inputsChanged(['src/queued.ts'])
  assert.deepEqual(spy.calls, [], 'queued inputs must not interleave with the running update')
  gate.resolve({ kind: 'updated', freshness: 'current' })
  await updating
  await notified.promise
  assert.deepEqual(spy.calls, [['src/queued.ts']])
})
