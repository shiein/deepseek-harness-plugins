/** 托管进程、账本与真实终止回归（方案 §9.2、§15.3）；仅运行临时目录和自己的子进程。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import type { ResourceLedger } from '../../src/runner/ledger.ts'
import { killTree, spawnManaged } from '../../src/runner/process-tree.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'

const options = { skip: !['darwin', 'linux'].includes(process.platform), timeout: 10000 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function setup(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-managed-'))
  t.after(() => rm(dir, { recursive: true }))
  return { dir, ledger: createFileLedger(dir), owner: { previewId: 'managed-test', ownerSessionId: 'test-session', workspaceRoot: dir } }
}
async function line(output: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of output) { text += chunk; if (text.includes('\n')) return text.split('\n')[0]! }
  throw new Error('Expected child output')
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000
  while (await readProcessStartTime(pid)) {
    if (Date.now() > deadline) throw new Error('Fixture process did not exit')
    await delay(20)
  }
}

test('managed process uses literal args and explicit env, records identity and stops idempotently', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const original = process.env.DSH_MANAGED_TEST_PARENT
  process.env.DSH_MANAGED_TEST_PARENT = 'synthetic-parent-value'
  t.after(() => { if (original === undefined) delete process.env.DSH_MANAGED_TEST_PARENT; else process.env.DSH_MANAGED_TEST_PARENT = original })
  const script = "console.log(JSON.stringify({value:process.env.EXPLICIT,parent:process.env.DSH_MANAGED_TEST_PARENT||null,arg:process.argv[1]}));console.error('fixture-stderr');setInterval(()=>{},1000)"
  const proc = await spawnManaged({ executable: process.execPath, args: ['-e', script, '$(literal)'], cwd: dir, env: { EXPLICIT: 'provided' } }, ledger, owner)
  t.after(async () => { await proc.stop(100) })
  assert.deepEqual(JSON.parse(await line(proc.stdout)), { value: 'provided', parent: null, arg: '$(literal)' })
  assert.equal(await line(proc.stderr), 'fixture-stderr')
  const records = await ledger.listByPreview(owner.previewId)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0]?.resource, { kind: 'process', pid: proc.pid, pgid: proc.pgid, startTime: proc.startTime, command: process.execPath })
  assert.doesNotMatch(JSON.stringify(records), /synthetic-parent-value|provided|literal/)
  assert.deepEqual(await proc.stop(100), [])
  assert.deepEqual(await proc.stop(100), [])
  assert.equal((await proc.exited).signal, 'SIGTERM')
  assert.deepEqual(await ledger.listByPreview(owner.previewId), [])
})

test('wrong identity never sends a signal; managed groups include listening descendants', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const fixture = fileURLToPath(new URL('../fixtures/managed-process/group.mjs', import.meta.url))
  const proc = await spawnManaged({ executable: process.execPath, args: [fixture], cwd: dir, env: {} }, ledger, owner)
  t.after(async () => { await proc.stop(100) })
  const child: { pid: number; port: number } = JSON.parse(await line(proc.stdout))
  await assert.rejects(killTree({ ...proc, startTime: 'wrong-identity' }, 10), { code: 'ownership_unverified' })
  assert.equal(await readProcessStartTime(proc.pid), proc.startTime)
  assert.deepEqual(await findListeningPids(child.port), [child.pid])
  assert.deepEqual(await proc.stop(100), [])
  await gone(child.pid)
  assert.deepEqual(await findListeningPids(child.port), [])
})

test('managed group escalates to SIGKILL after its TERM grace period', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const fixture = fileURLToPath(new URL('../fixtures/managed-process/group.mjs', import.meta.url))
  const proc = await spawnManaged({ executable: process.execPath, args: [fixture, 'stubborn'], cwd: dir, env: {} }, ledger, owner)
  t.after(async () => { await proc.stop(50) })
  const child: { pid: number; port: number } = JSON.parse(await line(proc.stdout))
  assert.deepEqual(await proc.stop(30), [])
  assert.equal((await proc.exited).signal, 'SIGKILL')
  assert.deepEqual(await findListeningPids(child.port), [])
})

test('ledger failure rolls back a spawned process and exposes the original error', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const failure = new Error('disposable ledger failure')
  let pid = 0
  const failing: ResourceLedger = { ...ledger, async record(entry) { if (entry.resource.kind === 'process') pid = entry.resource.pid; throw failure } }
  await assert.rejects(spawnManaged({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, env: {} }, failing, owner), failure)
  assert.ok(pid > 0)
  await gone(pid)
})

test('cancellation during registration rolls back the process and committed ledger record', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const entered = deferred<number>()
  const release = deferred<void>()
  const gated: ResourceLedger = { ...ledger, async record(input) {
    const entry = await ledger.record(input)
    if (input.resource.kind !== 'process') throw new Error('Unexpected resource')
    entered.resolve(input.resource.pid)
    await release.promise
    return entry
  } }
  const control = new AbortController()
  const started = spawnManaged({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, env: {} }, gated, owner, control.signal)
  const pid = await entered.promise
  control.abort()
  release.resolve()
  await assert.rejects(started, { name: 'AbortError' })
  await gone(pid)
  assert.deepEqual(await ledger.listByPreview(owner.previewId), [])
  await assert.rejects(spawnManaged({ executable: process.execPath, args: [], cwd: dir, env: {} }, ledger, owner, control.signal), { name: 'AbortError' })
})

test('spawn failure and invalid group identities allocate no managed record', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  await assert.rejects(spawnManaged({ executable: join(dir, 'missing-executable'), args: [], cwd: dir, env: {} }, ledger, owner), { code: 'ENOENT' })
  await assert.rejects(killTree({ pid: 0, pgid: 0, startTime: 'invalid' }), RangeError)
  assert.deepEqual(await ledger.listByPreview(owner.previewId), [])
})

test('observed escaped descendants remain residual across repeated stop until separately removed', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const fixture = fileURLToPath(new URL('../fixtures/managed-process/group.mjs', import.meta.url))
  const proc = await spawnManaged({ executable: process.execPath, args: [fixture, 'escape'], cwd: dir, env: {} }, ledger, owner)
  const child: { pid: number; port: number } = JSON.parse(await line(proc.stdout))
  const childStart = await readProcessStartTime(child.pid)
  t.after(async () => {
    if (childStart && await readProcessStartTime(child.pid) === childStart) process.kill(child.pid, 'SIGTERM')
    await gone(child.pid)
    await proc.stop(100)
  })
  assert.deepEqual(await proc.stop(50), [child.pid])
  const residualRecords = await ledger.listByPreview(owner.previewId)
  assert.equal(residualRecords.length, 2)
  assert.ok(residualRecords.some(entry => entry.resource.kind === 'process' && entry.resource.pid === child.pid && entry.resource.startTime === childStart))
  assert.deepEqual(await proc.stop(50), [child.pid])
  assert.deepEqual(await findListeningPids(child.port), [child.pid])
  assert.ok(childStart)
  assert.equal(await readProcessStartTime(child.pid), childStart)
  process.kill(child.pid, 'SIGTERM')
  await gone(child.pid)
  assert.deepEqual(await proc.stop(50), [])
  assert.deepEqual(await ledger.listByPreview(owner.previewId), [])
})

test('failure to record an observed escape preserves the running group and can be retried', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  let rejectResidual = false
  const guarded: ResourceLedger = { ...ledger, async record(entry) {
    if (rejectResidual) throw new Error('residual ledger unavailable')
    return ledger.record(entry)
  } }
  const fixture = fileURLToPath(new URL('../fixtures/managed-process/group.mjs', import.meta.url))
  const proc = await spawnManaged({ executable: process.execPath, args: [fixture, 'escape'], cwd: dir, env: {} }, guarded, owner)
  const child: { pid: number; port: number } = JSON.parse(await line(proc.stdout))
  const childStart = await readProcessStartTime(child.pid)
  t.after(async () => {
    rejectResidual = false
    if (childStart && await readProcessStartTime(child.pid) === childStart) process.kill(child.pid, 'SIGTERM')
    await gone(child.pid)
    await proc.stop(100)
  })
  rejectResidual = true
  await assert.rejects(proc.stop(50), { code: 'cleanup_failed' })
  assert.equal(await readProcessStartTime(proc.pid), proc.startTime)
  assert.deepEqual(await findListeningPids(child.port), [child.pid])
  rejectResidual = false
  assert.deepEqual(await proc.stop(50), [child.pid])
})

test('an exited group leader leaves unverified members as residual without signalling them', options, async (t) => {
  const { dir, ledger, owner } = await setup(t)
  const fixture = fileURLToPath(new URL('../fixtures/managed-process/group.mjs', import.meta.url))
  const proc = await spawnManaged({ executable: process.execPath, args: [fixture], cwd: dir, env: {} }, ledger, owner)
  const child: { pid: number; port: number } = JSON.parse(await line(proc.stdout))
  const childStart = await readProcessStartTime(child.pid)
  t.after(async () => {
    if (childStart && await readProcessStartTime(child.pid) === childStart) process.kill(child.pid, 'SIGTERM')
    await gone(child.pid)
    await proc.stop(100)
  })
  assert.equal(await readProcessStartTime(proc.pid), proc.startTime)
  process.kill(proc.pid, 'SIGTERM')
  await proc.exited
  assert.deepEqual(await proc.stop(50), [child.pid])
  assert.deepEqual(await findListeningPids(child.port), [child.pid])
  assert.equal((await ledger.listByPreview(owner.previewId)).length, 1)
})
