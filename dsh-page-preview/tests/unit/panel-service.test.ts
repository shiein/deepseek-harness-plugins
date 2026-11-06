/** Client 面板 Host 服务（方案 §4.3、§10）：同一 owner/workspace 的 status/stop 投影；异属会话无可见性。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import type { SessionRegistryOptions } from '../../src/host/session-registry.ts'
import { PanelService } from '../../src/host/panel-service.ts'
import type { PanelSnapshot } from '../../src/client/protocol.ts'
import type { PreviewPlan } from '../../src/shared/contracts.ts'
import { fingerprintJson } from '../../src/shared/fingerprint.ts'

const options = { timeout: 60000 }

async function setup(t: { after(callback: () => Promise<void>): void }, extra: SessionRegistryOptions = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-panel-')))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await cp(new URL('../fixtures/static-multipage/', import.meta.url), join(workspace, 'public'), { recursive: true })
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const dataDir = join(dir, 'plugin')
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const client = new RunnerClient({ dataDir })
  const registry = new SessionRegistry(client, undefined, { dataDir, ...extra })
  const service = new PanelService(ctx, registry, sessions)
  sessions.create(SessionId('owner-A'), { meta: { cwd: workspace } })
  sessions.create(SessionId('owner-B'), { meta: { cwd: workspace } })
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const unknown = { status: 'unknown' as const, source: 'none' as const, reason: 'test' }
  const plan: PreviewPlan = { projectId: 'site', targetId: 'index', selector: { kind: 'file', path: 'public/index.html' }, scope: 'page', strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: ['mock-only'], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 3000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: fingerprintJson(project) }, missing: [], knownDifferences: [] }
  return { ctx, sessions, client, registry, service, plan, workspace }
}

async function nextMatching(iterator: AsyncIterator<PanelSnapshot>, predicate: (snapshot: PanelSnapshot) => boolean, rounds = 50): Promise<PanelSnapshot> {
  for (let index = 0; index < rounds; index++) {
    const { value, done } = await iterator.next()
    if (done) throw new Error('Panel stream ended before the expected snapshot')
    if (predicate(value)) return value
  }
  throw new Error('Panel stream did not produce the expected snapshot')
}

test('panel follow streams the same owner projection and stop shares the owned cleanup path', options, async t => {
  const f = await setup(t)
  const control = new AbortController()
  const stream = f.service.follow('owner-A', control.signal)
  const iterator = stream[Symbol.asyncIterator]()
  t.after(() => { control.abort(); void iterator.return?.(undefined) })
  const initial = (await iterator.next()).value
  assert.deepEqual(initial, { previews: [], diagnostics: [] })
  const started = await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'owner-A' })
  assert.ok(started.previewId)
  const ready = await nextMatching(iterator, snapshot => snapshot.previews.some(value => value.previewId === 'first' && value.state === 'reachable' && value.url !== undefined))
  const row = ready.previews.find(value => value.previewId === 'first')!
  assert.equal(row.projectId, 'site')
  assert.equal(row.readiness.serviceReachable.status, 'proven')
  const foreign = await f.service.stop('owner-B', 'first')
  assert.equal(foreign.status, 'not_found')
  assert.ok((await f.client.status(f.workspace, 'owner-A', 'first')).previews?.[0]?.state !== 'stopped', 'Foreign stop must not stop the owned preview')
  const reply = await f.service.stop('owner-A', 'first')
  assert.equal(reply.status, 'ok')
  assert.equal(reply.previewId, 'first')
  assert.equal(reply.state, 'stopped')
  await nextMatching(iterator, snapshot => snapshot.previews.every(value => value.previewId !== 'first' || value.state === 'stopped'))
})

test('panel snapshots and change waits are owner-scoped and abort cleanly', options, async t => {
  const f = await setup(t)
  assert.deepEqual(await f.registry.panelSnapshot({ ownerSessionId: 'owner-A', workspaceRoot: f.workspace }), { previews: [], diagnostics: [] })
  await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'owner-A' })
  for (let index = 0; index < 200; index++) {
    if ((await f.client.status(f.workspace, 'owner-A', 'first')).previews?.[0]?.state === 'reachable') break
    await delay(10)
  }
  const own = await f.registry.panelSnapshot({ ownerSessionId: 'owner-A', workspaceRoot: f.workspace })
  assert.equal(own.previews.length, 1)
  assert.equal(own.previews[0]?.previewId, 'first')
  assert.equal(own.previews[0]?.state, 'reachable')
  assert.deepEqual(await f.registry.panelSnapshot({ ownerSessionId: 'owner-B', workspaceRoot: f.workspace }), { previews: [], diagnostics: [] })
  assert.equal((await f.registry.stopForOwner({ ownerSessionId: 'owner-B', workspaceRoot: f.workspace }, 'first')).status, 'not_found')
  const version = await f.registry.panelChanges(0, AbortSignal.timeout(1000))
  assert.equal(await f.registry.panelChanges(version!, AbortSignal.timeout(25)), undefined)
  assert.equal((await f.service.stop('owner-A', 'first')).status, 'ok')
  await assert.rejects(async () => { for await (const _ of f.service.follow('missing-session', AbortSignal.timeout(2000))) { void _ } })
})

test('panel suggestion open shares the tool open path: payload validation, ownership and takeover',
  options, async t => {
  const f = await setup(t)
  const file = JSON.stringify({ kind: 'file', path: 'public/index.html' })
  const malformed = await f.service.open('owner-A', { projectId: 'site', target: '{broken' })
  assert.equal(malformed.status, 'error')
  assert.equal(malformed.diagnostics[0]?.code, 'config_invalid')
  const invalid = await f.service.open('owner-A', { projectId: 'site', target: JSON.stringify({ kind: 'file' }) })
  assert.equal(invalid.status, 'error')
  assert.equal(invalid.diagnostics[0]?.code, 'config_invalid')
  const missing = await f.service.open('owner-A', { projectId: 'unknown', target: file })
  assert.equal(missing.status, 'not_found')
  const opened = await f.service.open('owner-A', { projectId: 'site', target: file })
  assert.equal(opened.status, 'ok')
  assert.ok(opened.previewId && opened.url)
  // 面板打开与工具 open 同一条链路：就绪、owner 投影与接管诊断一致。
  const snapshot = await f.registry.panelSnapshot({ ownerSessionId: 'owner-A', workspaceRoot: f.workspace })
  assert.equal(snapshot.previews[0]?.previewId, opened.previewId)
  const page = await (await fetch(opened.url!)).text()
  assert.ok(page.includes('<h1>真实静态样本</h1>'))
  const taken = await f.service.open('owner-B', { projectId: 'site', target: file })
  assert.equal(taken.status, 'ok')
  assert.ok(taken.diagnostics.some(value => value.code === 'preview_taken_over'))
  const afterTakeover = await f.registry.panelSnapshot({ ownerSessionId: 'owner-A', workspaceRoot: f.workspace })
  assert.ok(afterTakeover.previews.every(value => value.state === 'stopped'),
    'A 被接管后只应看到已停止的旧预览，不应看到 B 的新预览')
  assert.equal((await f.registry.panelSnapshot({ ownerSessionId: 'owner-B', workspaceRoot: f.workspace }))
    .previews[0]?.previewId, taken.previewId)
  assert.equal((await f.service.stop('owner-B', taken.previewId!)).status, 'ok')
  await assert.rejects(f.service.open('missing-session', { projectId: 'site', target: file }))
  })

