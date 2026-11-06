/** Host→真实 Runner→产品 static.start 集成（方案 §6.5、§9.2、§15.3）；仅临时原文件样本。 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { RunnerClient } from '../../src/host/runner-client.ts'
import type { RunnerClientOptions } from '../../src/host/runner-client.ts'
import type { PreviewPlan } from '../../src/shared/contracts.ts'
import type { RunnerSnapshot } from '../../src/shared/ipc.ts'
import { fingerprintJson } from '../../src/shared/fingerprint.ts'
import { createFileLedger, readProcessStartTime } from '../../src/shared/runner/ledger.ts'
import { findListeningPids } from '../../src/shared/runner/port-ownership.ts'
import { runnerPaths } from '../../src/shared/runner/paths.ts'
const options = { timeout: 20000, skip: !['darwin', 'linux'].includes(process.platform) }
const unknown = { status: 'unknown', source: 'none', reason: 'No carrier integration asserted by IPC tests' } as const
async function setup(t: { after(callback: () => Promise<void>): void }, opts: RunnerClientOptions = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-client-')))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await cp(new URL('../fixtures/static-multipage/', import.meta.url), join(workspace, 'public'), { recursive: true })
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }
  const config = join(workspace, 'page-preview.config.json')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const dataDir = join(dir, 'plugin')
  const client = new RunnerClient({ dataDir, ...opts })
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    assert.deepEqual(await client.dispose(), { residual: [] })
    await rm(dir, { recursive: true, force: true })
  })
  const plan: PreviewPlan = { projectId: 'site', targetId: 'index', selector: { kind: 'file', path: 'public/index.html' }, scope: 'page', strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: ['mock-only'], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 3000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: fingerprintJson(project) }, missing: [], knownDifferences: [] }
  return { dir, workspace, dataDir, config, project, client, plan, cleanups, paths: runnerPaths(dataDir, workspace) }
}
async function reachable(client: RunnerClient, workspace: string, owner = 'A', id = 'first'): Promise<RunnerSnapshot> {
  for (let i = 0; i < 200; i++) {
    const snapshot = (await client.status(workspace, owner, id)).previews?.[0]
    if (snapshot?.state === 'reachable' && snapshot.url) return snapshot
    assert.ok(!snapshot || !['failed', 'cleanup_failed'].includes(snapshot.state))
    await delay(10)
  }
  throw new Error('Runner did not become reachable')
}
async function gone(pid: number) {
  for (let i = 0; i < 300; i++) {
    if (!(await readProcessStartTime(pid))) return
    await delay(20)
  }
  throw new Error('Owned test process did not exit')
}

test('real fork serves original files outside Host, enforces owner scope, reuses and stops without source changes', options, async t => {
  const f = await setup(t)
  assert.deepEqual(await f.client.status(f.workspace, 'A'), { status: 'ok', previews: [] })
  const rootLedger = createFileLedger(f.paths.control)
  assert.deepEqual(await rootLedger.listByPreview('__runner__'), [])
  assert.equal((await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' })).status, 'ok')
  const snapshot = await reachable(f.client, f.workspace)
  const port = Number(new URL(snapshot.url!).port)
  const records = await rootLedger.listByPreview('__runner__')
  const resource = records[0]?.resource
  if (resource?.kind !== 'process') throw new Error('Runner process record missing')
  assert.notEqual(resource.pid, process.pid)
  assert.deepEqual(await findListeningPids(port), [resource.pid])
  const html = await (await fetch(snapshot.url!)).text()
  assert.ok(html.includes('真实静态样本'))
  assert.equal(snapshot.readiness.targetMounted.status, 'unverified')
  assert.deepEqual(await f.client.stop('first', 'B'), { status: 'not_found' })
  assert.deepEqual(await f.client.status(f.workspace, 'B'), { status: 'ok', previews: [] })
  assert.equal((await f.client.start('unused', f.plan, f.workspace, { ownerSessionId: 'A' })).previewId, 'first')
  const alias = join(f.dir, 'alias')
  await symlink(f.workspace, alias)
  assert.equal((await f.client.start('other-unused', f.plan, alias, { ownerSessionId: 'A' })).previewId, 'first')
  assert.equal((await rootLedger.listByPreview('__runner__')).length, 1)
  assert.equal((await f.client.stop('first', 'A')).status, 'ok')
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await f.client.dispose(), { residual: [] })
  assert.equal(await readProcessStartTime(resource.pid), undefined)
  assert.deepEqual(await rootLedger.listByPreview('__runner__'), [])
})

test('concurrent caller startup shares one Runner and a later owner takes over after cleanup', options, async t => {
  const f = await setup(t)
  const [first, second] = await Promise.all([f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' }),
    f.client.start('second', f.plan, f.workspace, { ownerSessionId: 'B' })])
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  // 两个启动请求的到达顺序不确定：恰有一方接管并清理了另一方。
  assert.deepEqual([first.takenOver, second.takenOver].filter(value => value !== undefined).length, 1)
  assert.ok(first.takenOver === 'second' || second.takenOver === 'first',
    '2026-11-03 decision: another session preview is cleaned up and taken over')
  assert.equal((await createFileLedger(f.paths.control).listByPreview('__runner__')).length, 1)
  const secondHost = new RunnerClient({ dataDir: f.dataDir })
  try {
    await assert.rejects(secondHost.start('foreign-host', f.plan, f.workspace, { ownerSessionId: 'B' }), error => error instanceof Error && 'diagnostic' in error && JSON.stringify(error.diagnostic).includes('cleanup_failed'))
    assert.equal((await createFileLedger(f.paths.control).listByPreview('__runner__')).length, 1)
  } finally { assert.deepEqual(await secondHost.dispose(), { residual: [] }) }
})

test('Runner with an unreadable ledger record stays alive but refuses start until the record is repaired', options, async t => {
  const f = await setup(t)
  const book = join(f.paths.services, 'ledger')
  await mkdir(book, { recursive: true })
  const broken = join(book, 'invalid-record.json')
  await writeFile(broken, '{}')
  await assert.rejects(f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' }), error => {
    assert.ok(error instanceof Error && 'diagnostics' in error)
    assert.ok(JSON.stringify(error.diagnostics).includes('cleanup_failed'))
    return true
  })
  await rm(broken)
  await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' })
  await reachable(f.client, f.workspace)
})

test('changed config and execution items reject without executing a command', options, async t => {
  const f = await setup(t)
  const stale = structuredClone(f.plan)
  stale.fingerprints.config = 'wrong'
  await assert.rejects(f.client.start('stale', stale, f.workspace, { ownerSessionId: 'A' }), error => error instanceof Error && 'diagnostics' in error)
  const malformed = { ...f.plan, readiness: { ...f.plan.readiness, approved: true } }
  await assert.rejects(f.client.start('malformed', malformed, f.workspace, { ownerSessionId: 'A' }), error => {
    assert.ok(error instanceof Error && 'diagnostics' in error)
    assert.ok(JSON.stringify(error.diagnostics).includes('config_invalid'))
    return true
  })
  await writeFile(f.config, JSON.stringify({ schemaVersion: 1, projects: [{ ...f.project, unknown: 'synthetic-not-echoed' }] }))
  await assert.rejects(f.client.start('invalid-config', f.plan, f.workspace, { ownerSessionId: 'A' }), error => {
    assert.ok(error instanceof Error && 'diagnostics' in error)
    assert.ok(JSON.stringify(error.diagnostics).includes('config_invalid'))
    assert.ok(!JSON.stringify(error.diagnostics).includes('synthetic-not-echoed'))
    return true
  })
  await writeFile(f.config, JSON.stringify({ schemaVersion: 1, projects: [{ ...f.project, runtime: { ...f.project.runtime, env: { SYNTHETIC: 'do-not-echo-secret' } } }] }))
  await assert.rejects(f.client.start('unapproved', f.plan, f.workspace, { ownerSessionId: 'A' }), error => {
    assert.ok(error instanceof Error && 'diagnostics' in error)
    assert.ok(JSON.stringify(error.diagnostics).includes('config_changed_needs_approval'))
    assert.ok(!JSON.stringify(error.diagnostics).includes('do-not-echo-secret'))
    return true
  })
  assert.deepEqual((await f.client.status(f.workspace, 'A')).previews, [])
})

test('unexpected Runner death checks persisted resources and reports failed instead of stale ready', options, async t => {
  const f = await setup(t)
  await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' })
  const snapshot = await reachable(f.client, f.workspace)
  const record = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0]
  if (record?.resource.kind !== 'process') throw new Error('Missing Runner ownership')
  const failed = new Promise<void>(resolve => { f.client.onMessage(message => { if (message.type === 'state' && message.previewId === 'first' && message.state === 'failed') resolve() }) })
  assert.equal(await readProcessStartTime(record.resource.pid), record.resource.startTime)
  process.kill(record.resource.pid, 'SIGKILL')
  await failed
  assert.equal((await f.client.status(f.workspace, 'A', 'first')).previews?.[0]?.state, 'failed')
  assert.deepEqual(await findListeningPids(Number(new URL(snapshot.url!).port)), [])
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
})

test('Host SIGKILL triggers actual IPC disconnect cleanup and the next Host reconciles the persisted Runner record', options, async t => {
  const f = await setup(t)
  const launcher = fork(fileURLToPath(new URL('../fixtures/runner-ipc/host-launcher.ts', import.meta.url)), [f.workspace, f.dataDir], { execArgv: [], env: {}, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const launcherStart = await readProcessStartTime(launcher.pid!)
  assert.ok(launcherStart)
  const testLedger = createFileLedger(join(f.dir, 'test-host'))
  const hostEntry = await testLedger.record({ previewId: 'host-test', ownerSessionId: 'test-launcher', workspaceRoot: f.workspace, resource: { kind: 'process', pid: launcher.pid!, startTime: launcherStart, command: process.execPath } })
  f.cleanups.push(async () => {
    if (await readProcessStartTime(launcher.pid!) === launcherStart) process.kill(launcher.pid!, 'SIGTERM')
    await gone(launcher.pid!)
    await testLedger.release(hostEntry.id)
    const ledger = createFileLedger(f.paths.control)
    for (const entry of await ledger.listByPreview('__runner__')) if (entry.resource.kind === 'process') {
      if (await readProcessStartTime(entry.resource.pid) === entry.resource.startTime) process.kill(entry.resource.pid, 'SIGTERM')
      await gone(entry.resource.pid)
    }
  })
  const address = new Promise<{ url: string }>((resolve, reject) => {
    launcher.once('message', message => resolve(message as { url: string }))
    launcher.once('exit', () => reject(new Error('Test Host exited before reporting its preview')))
  })
  launcher.send({ type: 'start', requestId: 'test', previewId: 'lost-host', ownerSessionId: 'A', plan: f.plan, workspaceRoot: f.workspace })
  const { url } = await address
  const original = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0]
  if (original?.resource.kind !== 'process') throw new Error('Missing child Runner ownership')
  assert.equal(await readProcessStartTime(launcher.pid!), launcherStart)
  process.kill(launcher.pid!, 'SIGKILL')
  await gone(launcher.pid!)
  await gone(original.resource.pid)
  assert.deepEqual(await findListeningPids(Number(new URL(url).port)), [])
  assert.equal((await createFileLedger(f.paths.control).listByPreview('__runner__')).length, 1)
  await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' })
  await reachable(f.client, f.workspace)
  const current = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0]
  assert.ok(current?.resource.kind === 'process' && current.resource.pid !== original.resource.pid)
})

test('SIGKILLed Runner residue blocks the next start until recover reclaims and archives it', options, async t => {
  const f = await setup(t)
  await f.client.start('first', f.plan, f.workspace, { ownerSessionId: 'A' })
  await reachable(f.client, f.workspace)
  const record = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0]
  if (record?.resource.kind !== 'process') throw new Error('Missing Runner ownership')
  process.kill(record.resource.pid, 'SIGKILL')
  await gone(record.resource.pid)
  // 等 Host 侧退出核对释放旧 worker；status 成功返回说明 workers 表已清理。
  for (let i = 0; i < 200; i++) {
    try {
      if ((await f.client.status(f.workspace, 'A', 'first')).previews?.[0]?.state === 'failed') break
    } catch { /* worker still being reaped */ }
    await delay(20)
    if (i === 199) throw new Error('Runner exit was not reaped')
  }
  // Runner 无法自清理时留下的两类残留：外来路径记录与损坏记录。
  const services = createFileLedger(f.paths.services)
  const foreign = join(f.dir, 'foreign-leftover')
  await writeFile(foreign, 'not a plugin temporary path')
  const stale = await services.record({ previewId: 'first', ownerSessionId: 'A', workspaceRoot: f.workspace, resource: { kind: 'path', path: foreign } })
  await mkdir(join(f.paths.services, 'ledger'), { recursive: true })
  const broken = join(f.paths.services, 'ledger', 'torn-record.json')
  await writeFile(broken, '{ torn')
  // 下一次启动被残留阻断；对账已自动回收消失的记录（Runner 进程与端口）。
  await assert.rejects(f.client.start('second', f.plan, f.workspace, { ownerSessionId: 'A' }), error => {
    assert.ok(error instanceof Error && 'diagnostics' in error)
    assert.ok(JSON.stringify(error.diagnostics).includes('cleanup_failed'))
    return true
  })
  const recovered = await f.client.recover(f.workspace)
  // 死 Runner 的进程/端口记录已在被拒启动的对账中自动回收；recover 时只剩残留与归档可报告。
  assert.equal(recovered.reclaimed.length, 0)
  // 残留三项：仍被本进程持有的活 Runner 记录（active，不终止不归档）、外来路径、损坏记录。
  assert.equal(recovered.residual.length, 3)
  assert.ok(recovered.residual.some(value => value.includes('live parent')))
  assert.deepEqual(recovered.archived.sort(), ['torn-record.json', stale.id + '.json'].sort())
  assert.equal(await readFile(foreign, 'utf8'), 'not a plugin temporary path')
  await f.client.start('second', f.plan, f.workspace, { ownerSessionId: 'A' })
  await reachable(f.client, f.workspace, 'A', 'second')
})

// R4-2（r4-2 测试债 的集成部分）：真实 Runner 下终态预览按 owner 上限回收，
// 被回收 ID 的 status 返回 not_found，其他 owner 不受影响；cleanup_failed 语义由
// snapshot-retention.test.ts 纯函数部分覆盖（该状态无法确定性触发）。
const evictOptions = { timeout: 180000, skip: !['darwin', 'linux'].includes(process.platform) }
test('terminal previews are retained per owner and evicted past the limit', evictOptions, async t => {
  const f = await setup(t)
  const { MAX_TERMINAL_PER_OWNER } = await import('../../src/host/snapshot-retention.ts')
  // 每个 owner MAX+2 个终态预览：start→stop 串行，终态消息经 emit 记录时间并触发回收。
  const owners = { A: 'evict-a', B: 'evict-b' }
  for (const [owner, prefix] of Object.entries(owners)) {
    for (let i = 0; i < MAX_TERMINAL_PER_OWNER + 2; i++) {
      const id = prefix + '-' + i
      assert.equal((await f.client.start(id, f.plan, f.workspace, { ownerSessionId: owner })).status, 'ok',
        'start ' + id)
      assert.equal((await f.client.stop(id, owner)).status, 'ok', 'stop ' + id)
    }
  }
  // 终态 state 消息异步到达 Host；轮询直到最旧者被回收。
  for (let i = 0; i < 200; i++) {
    const oldest = await f.client.status(f.workspace, 'A', 'evict-a-0')
    if (oldest.status === 'not_found') break
    await delay(50)
    if (i === 199) throw new Error('Oldest terminal preview was not evicted')
  }
  // 每 owner 只保留最近 MAX 个终态：evict-a-0/1 已回收，evict-a-2..17 仍在。
  for (const gone of ['evict-a-0', 'evict-a-1', 'evict-b-0', 'evict-b-1']) {
    const owner = gone.includes('-a-') ? 'A' : 'B'
    assert.equal((await f.client.status(f.workspace, owner, gone)).status, 'not_found', gone)
  }
  for (let i = 2; i < MAX_TERMINAL_PER_OWNER + 2; i++) {
    const keptA = await f.client.status(f.workspace, 'A', 'evict-a-' + i)
    const keptB = await f.client.status(f.workspace, 'B', 'evict-b-' + i)
    assert.equal(keptA.previews?.[0]?.state, 'stopped', 'evict-a-' + i)
    assert.equal(keptB.previews?.[0]?.state, 'stopped', 'evict-b-' + i)
  }
  // owner B 的存活预览不受 A 回收影响；终态单查口径不变（旧 ID 直接 not_found）。
  const surviving = await f.client.start('survivor', f.plan, f.workspace, { ownerSessionId: 'A' })
  assert.equal(surviving.status, 'ok')
})
