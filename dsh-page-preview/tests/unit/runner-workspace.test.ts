/** 工作区占用、访问范围与目标切换（方案 §9.2、§15.3）；仅使用临时目录和自有服务。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RunnerWorkspace } from '../../src/runner/workspace.ts'
import type { WorkspaceOpenResult } from '../../src/runner/workspace.ts'
import type { SessionContext } from '../../src/runner/session.ts'
import type { PreviewPlan } from '../../src/shared/contracts.ts'
import type { Adapter, RunningHandle } from '../../src/adapters/types.ts'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'

const options = { timeout: 10000 }
const unknown = { status: 'unknown', source: 'none', reason: 'Workspace lifecycle fixture' } as const
function plan(targetId = 'orders'): PreviewPlan {
  return { projectId: 'fixture', targetId, selector: { kind: 'route', path: '/' + targetId }, scope: 'page', strategy: 'project', adapter: { id: 'workspace-fixture', version: '1' }, toolchain: {}, requirements: [], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 1000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: 'synthetic' }, missing: [], knownDifferences: ['Workspace lifecycle fixture; not a product adapter'] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function adapter(start: Adapter['start'] = async ctx => { ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://127.0.0.1:12345/', async stop() { return { residual: [] } } } }): Parameters<RunnerWorkspace['open']>[2] {
  return { id: 'workspace-fixture', version: '1', strategies: ['project'], start }
}
async function opened(result: WorkspaceOpenResult) {
  if (result.kind !== 'created' && result.kind !== 'reused') throw new Error('Expected a registered workspace session: ' + result.kind)
  await result.started
  return result.session
}
async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-workspace-')))
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  const ledger = createFileLedger(join(root, 'plugin-data'))
  const manager = new RunnerWorkspace(workspaceRoot)
  const context: SessionContext = { workspaceRoot, appRoot: workspaceRoot, ownerSessionId: 'A', ledger, config: { source: { kind: 'detected' }, project: { id: 'fixture', root: '.', runtime: {} }, diagnostics: [] }, profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] } }
  t.after(async () => { for (const result of await manager.shutdown()) assert.deepEqual(result.residual, []); await rm(root, { recursive: true, force: true }) })
  return { root, workspaceRoot, ledger, manager, context }
}

test('a second owner takes over after full cleanup; owners never query or stop each other', options, async t => {
  // 2026-11-03 Aesc 决策：桌面端各会话同属一个用户，另一会话的预览不锁死工作区——先完整清理再接管。
  const { manager, context } = await setup(t)
  let starts = 0
  const fixture = adapter(async ctx => { starts++; ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12345/', async stop() { return { residual: [] } } } })
  const [first, second] = await Promise.all([manager.open('first', plan(), fixture, context),
    manager.open('second', plan('other'), fixture, { ...context, ownerSessionId: 'B' })])
  // 串行登记：B 的接管可能发生在 A 仍在启动时——A 的启动因 stop 被取消，这是接管的预期结果。
  assert.ok(first.kind === 'created')
  const session = first.session
  await first.started.catch(() => {})
  const taken = await opened(second)
  assert.ok(second.kind === 'created' && second.takenOver === 'first', 'the takeover names the cleaned-up preview')
  assert.ok(['stopped', 'failed'].includes(session.state), 'the previous owner preview ended before the new one ran')
  assert.equal(taken.state, 'reachable')
  // 接管可能发生在 A 的适配器真正启动之前（启动被取消，starts=1），也可能在之后（starts=2）；两者都合法。
  assert.ok(starts === 1 || starts === 2)
  assert.equal(manager.get('second', 'A'), undefined, 'the old owner cannot see the new owner preview')
  assert.equal(manager.get('first', 'B'), undefined)
  assert.deepEqual(manager.list('A').map(value => value.state), ['stopped'])
  assert.equal(await manager.stop('second', 'A'), undefined, 'the old owner cannot stop it either')
  assert.equal(taken.state, 'reachable')
})

test('same owner and identical plan reuse the actual preview ID and original startup promise', options, async t => {
  const { manager, context } = await setup(t)
  const first = await manager.open('first', plan(), adapter(), context)
  await opened(first)
  const second = await manager.open('unused-new-id', plan(), adapter(), context)
  assert.equal(second.kind, 'reused')
  if (first.kind === 'created' && second.kind === 'reused') {
    assert.equal(first.session, second.session)
    assert.equal(first.started, second.started)
    assert.equal(second.session.previewId, 'first')
  }
  assert.equal(manager.get('unused-new-id', 'A'), undefined)
  assert.equal(manager.list('A').length, 1)
})

test('workspace mismatch rejects without poisoning the queue and canonical aliases use the same workspace', options, async t => {
  const { root, manager, workspaceRoot, context } = await setup(t)
  const other = join(root, 'other')
  await mkdir(other)
  await assert.rejects(manager.open('bad', plan(), adapter(), { ...context, workspaceRoot: other }), error => error instanceof Error && 'diagnostic' in error)
  const alias = join(root, 'alias')
  await symlink(workspaceRoot, alias)
  assert.equal((await opened(await manager.open('valid', plan(), adapter(), { ...context, workspaceRoot: alias }))).state, 'reachable')
})

test('same-owner target switch waits for old cleanup and a later owner takes over afterwards', options, async t => {
  const { manager, context } = await setup(t)
  const stopping = deferred<void>()
  const finish = deferred<{ residual: string[] }>()
  const first = await opened(await manager.open('first', plan(), adapter(async ctx => { ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12345/', stop() { stopping.resolve(); return finish.promise } } }), context))
  let newStarts = 0
  const fixture = adapter(async ctx => { newStarts++; ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12346/', async stop() { return { residual: [] } } } })
  const switching = manager.open('next', plan('settings'), fixture, context)
  const other = manager.open('foreign', plan('foreign'), fixture, { ...context, ownerSessionId: 'B' })
  await stopping.promise
  assert.equal(first.state, 'stopping')
  assert.equal(newStarts, 0)
  finish.resolve({ residual: [] })
  const switchedResult = await switching
  assert.ok(switchedResult.kind === 'created')
  const switched = switchedResult.session
  await switchedResult.started.catch(() => {})
  assert.equal(first.state, 'stopped', 'the same-owner switch completed its cleanup first')
  const foreignResult = await other
  const foreign = await opened(foreignResult)
  assert.ok(foreignResult.kind === 'created' && foreignResult.takenOver === 'next')
  assert.ok(['stopped', 'failed'].includes(switched.state), 'the later owner took over only after the switch')
  assert.equal(foreign.state, 'reachable')
})

test('failed old cleanup prevents switching and only the owner may retry it', options, async t => {
  const { manager, context } = await setup(t)
  let clean = false
  let starts = 0
  const fixture = adapter(async ctx => { starts++; ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12345/', async stop() { return { residual: clean ? [] : ['synthetic residual'] } } } })
  await opened(await manager.open('first', plan(), fixture, context))
  const blocked = await manager.open('next', plan('next'), fixture, context)
  assert.equal(blocked.kind, 'busy')
  if (blocked.kind === 'busy') {
    assert.equal(blocked.occupant.session.previewId, 'first')
    assert.equal(blocked.occupant.session.state, 'cleanup_failed')
    assert.equal(blocked.occupant.ownerSessionId, 'A')
  }
  assert.equal(starts, 1)
  assert.equal(manager.get('first', 'A')?.state, 'cleanup_failed')
  assert.equal(await manager.stop('first', 'B'), undefined)
  clean = true
  assert.deepEqual(await manager.stop('first', 'A'), { residual: [] })
  await opened(await manager.open('next', plan('next'), fixture, context))
  assert.equal(starts, 2)
  assert.deepEqual(await manager.open('first', plan(), fixture, context), { kind: 'not-found' })
})

test('plan mutations do not alter the running snapshot and changed execution plans are not reused', options, async t => {
  const { manager, context } = await setup(t)
  const original = plan()
  const first = await opened(await manager.open('first', original, adapter(), context))
  original.targetId = 'changed'
  assert.equal(first.plan.targetId, 'orders')
  const next = await opened(await manager.open('next', original, adapter(), context))
  assert.equal(first.state, 'stopped')
  assert.equal(next.plan.targetId, 'changed')
  const changed = structuredClone(original)
  changed.fingerprints.config = 'different execution config'
  const denied = await manager.open('next', changed, adapter(), context)
  assert.equal(denied.kind, 'busy')
  if (denied.kind === 'busy') assert.equal(denied.occupant.session, next)
  const newer = await manager.open('newer', changed, adapter(), context)
  assert.equal(newer.kind, 'created')
  await opened(newer)
  assert.equal(next.state, 'stopped')
})

test('invalid or cancelled replacement plans never stop the existing target', options, async t => {
  const { manager, context } = await setup(t)
  let stops = 0
  const current = await opened(await manager.open('first', plan(), adapter(async ctx => { ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12345/', async stop() { stops++; return { residual: [] } } } }), context))
  const invalid = plan('invalid')
  invalid.missing = [{ code: 'requirement_unsatisfied', phase: 'plan', message: 'Synthetic missing capability' }]
  await assert.rejects(manager.open('invalid', invalid, adapter(), context))
  const signal = new AbortController()
  signal.abort()
  await assert.rejects(manager.open('cancelled', plan('cancelled'), adapter(), context, signal.signal), { name: 'AbortError' })
  assert.equal(stops, 0)
  assert.equal(current.state, 'reachable')
  assert.equal(manager.get('invalid', 'A'), undefined)
  assert.equal(manager.get('cancelled', 'A'), undefined)
})

test('shutdown coalesces, blocks queued opens and retries actual cleanup failures', options, async t => {
  const { manager, context } = await setup(t)
  let stops = 0
  await opened(await manager.open('first', plan(), adapter(async ctx => { ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } }); return { url: 'http://localhost:12345/', async stop() { return { residual: ++stops === 1 ? ['synthetic residual'] : [] } } } }), context))
  const queued = manager.open('never-started', plan('later'), adapter(), context)
  const a = manager.shutdown()
  const b = manager.shutdown()
  assert.equal(a, b)
  assert.deepEqual(await queued, { kind: 'closed' })
  assert.equal((await a)[0]?.state, 'cleanup_failed')
  assert.equal((await manager.shutdown())[0]?.state, 'stopped')
  assert.equal(stops, 2)
  assert.deepEqual(await manager.open('later', plan(), adapter(), context), { kind: 'closed' })
})

test('failed startup stays observable and frees the workspace without silently recreating the failed ID', options, async t => {
  const { manager, context } = await setup(t)
  const rejected = await manager.open('failed', plan(), adapter(async () => { throw new Error('Synthetic start failure') }), context)
  if (rejected.kind !== 'created') throw new Error('Expected registered startup')
  await assert.rejects(rejected.started, /Synthetic start failure/)
  assert.equal(manager.get('failed', 'A')?.state, 'failed')
  assert.deepEqual(await manager.open('failed', plan(), adapter(), context), { kind: 'not-found' })
  assert.equal((await opened(await manager.open('new', plan(), adapter(), { ...context, ownerSessionId: 'B' }))).state, 'reachable')
  assert.equal(manager.list('A').length, 1)
  assert.equal(manager.list('B').length, 1)
})

test('real service switch releases the old PID and port before starting the next service; shutdown clears both ledgers',
  { ...options, skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const { manager, context, ledger } = await setup(t)
  const children: Array<{ pid: number; port: number }> = []
  const fixture = adapter(async ctx => {
    const previous = children.at(-1)
    if (previous) {
      assert.equal(await readProcessStartTime(previous.pid), undefined)
      assert.deepEqual(await findListeningPids(previous.port), [])
    }
    const server = fileURLToPath(new URL('../fixtures/non-vite-existing-server/server.mjs', import.meta.url))
    const child = await spawnManaged({ executable: process.execPath, args: [server, '0'], cwd: ctx.appRoot, env: {} }, ledger, { previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot }, ctx.signal)
    let entryId: string | undefined
    try {
      let text = ''
      let origin = ''
      for await (const chunk of child.stdout) { text += chunk; if (text.includes('\n')) { origin = JSON.parse(text.split('\n')[0]!).origin; break } }
      const port = Number(new URL(origin).port)
      assert.deepEqual(await findListeningPids(port), [child.pid])
      children.push({ pid: child.pid, port })
      entryId = (await ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot, resource: { kind: 'port', port, pid: child.pid } })).id
      ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven' } })
      return { url: origin + '/orders/', async stop() {
        const residual = await child.stop(100)
        if (!residual.length) await ledger.release(entryId!)
        return { residual: residual.map(pid => 'process ' + pid) }
      } }
    } catch (error) {
      assert.deepEqual(await child.stop(100), [])
      if (entryId) await ledger.release(entryId)
      throw error
    }
  })
  const first = await opened(await manager.open('first', plan(), fixture, context))
  const second = await opened(await manager.open('second', plan('settings'), fixture, context))
  assert.equal(first.state, 'stopped')
  assert.equal(second.state, 'reachable')
  assert.equal(children.length, 2)
  const result = await manager.shutdown()
  assert.ok(result.every(item => item.state === 'stopped' && !item.residual.length))
  for (const child of children) {
    assert.equal(await readProcessStartTime(child.pid), undefined)
    assert.deepEqual(await findListeningPids(child.port), [])
  }
  assert.deepEqual(await ledger.listByPreview('first'), [])
  assert.deepEqual(await ledger.listByPreview('second'), [])
})
