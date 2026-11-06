/** 资源账本的持久化、并发登记与核对回收对账（方案 §9.2、§15.2）。只使用临时目录和测试进程。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { mkdir, mkdtemp, lstat, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { processTable } from '../../src/shared/runner/process-table.ts'
import { findListeningPids } from '../../src/shared/runner/port-ownership.ts'
import { createServer } from 'node:net'

const darwin = { skip: !['darwin', 'linux'].includes(process.platform) }
const owner = (dir: string) => ({ previewId: 'preview', ownerSessionId: 'session', workspaceRoot: dir })

/** 可牺牲的独立进程组（detached ⇒ pgid=pid）；测试结束兜底整组 SIGKILL。直接子进程：ppid 是存活的测试进程。 */
async function spawnIdle(t: { after(callback: () => Promise<void>): void }, script = 'setInterval(() => {}, 1000000)') {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
  child.unref()
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
  const pid = child.pid!
  const startTime = await readProcessStartTime(pid)
  assert.ok(startTime)
  t.after(async () => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } })
  return { pid, pgid: pid, startTime }
}

/** 真正的孤儿进程：helper 创建 detached 孙进程并上报其 PID 后退出，孙进程 reparent 到 PID 1、pgid=pid。 */
async function spawnOrphan(t: { after(callback: () => Promise<void>): void }) {
  const helper = spawn(process.execPath, ['-e', [
    "const {spawn} = require('node:child_process')",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], { detached: true, stdio: 'ignore' })",
    'g.unref()',
    'process.stdout.write(String(g.pid))',
  ].join(';')], { stdio: ['ignore', 'pipe', 'ignore'] })
  let reported = ''
  helper.stdout!.on('data', (chunk) => { reported += chunk })
  await new Promise<void>((resolve, reject) => { helper.once('exit', () => resolve()); helper.once('error', reject) })
  const pid = Number(reported.trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const startTime = await readProcessStartTime(pid)
  assert.ok(startTime)
  for (let i = 0; i < 100; i++) {
    const table = await processTable()
    if (table.get(pid)?.ppid === 1) break
    await delay(20)
    if (i === 99) throw new Error('orphan test process was not reparented')
  }
  t.after(async () => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } })
  return { pid, pgid: pid, startTime }
}

async function gone(pid: number) {
  for (let i = 0; i < 100; i++) {
    if (!(await readProcessStartTime(pid))) return
    await delay(20)
  }
  throw new Error('test process did not exit')
}

test('independent ledger instances retain concurrent resource records and idempotent release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true }))
  const ledgers = [createFileLedger(dir), createFileLedger(dir)] as const
  const entries = await Promise.all(Array.from({ length: 20 }, (_, index) => ledgers[index % 2 === 0 ? 0 : 1].record({
    previewId: index % 2 === 0 ? 'preview-a' : 'preview-b', ownerSessionId: 'session', workspaceRoot: dir,
    resource: { kind: 'path', path: join(dir, 'temporary-' + index) },
  })))
  const reopened = createFileLedger(dir)
  assert.equal((await reopened.listByPreview('preview-a')).length, 10)
  assert.equal((await reopened.listByPreview('preview-b')).length, 10)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 20)
  const entry = entries[0]!
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'ledger', entry.id + '.json'), 'utf8')), entry)
  await reopened.release(entry.id)
  await reopened.release(entry.id)
  assert.equal((await reopened.listByPreview('preview-a')).length, 9)
  await assert.rejects(reopened.release('../outside'), /Invalid ledger entry ID/)
})

test('reconcile discards absent paths, removes owned plugin temporary paths, and retains foreign paths', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const owned = await mkdtemp(join(tmpdir(), 'dsh-preview-vue-'))
  const foreign = join(dir, 'owned-temporary-file')
  await writeFile(foreign, 'preserve until explicit cleanup')
  const ledger = createFileLedger(dir)
  const gone = await ledger.record({ ...owner(dir), resource: { kind: 'path', path: join(dir, 'already-gone') } })
  const plugin = await ledger.record({ ...owner(dir), resource: { kind: 'path', path: owned } })
  const foreignEntry = await ledger.record({ ...owner(dir), resource: { kind: 'path', path: foreign } })
  const report = await ledger.reconcile()
  assert.deepEqual(report.reclaimed.map((item) => item.entry.id).sort(), [gone.id, plugin.id].sort())
  assert.equal(report.residual.length, 1)
  assert.equal(report.residual[0]!.entry.id, foreignEntry.id)
  assert.ok(report.residual[0]!.reason.includes('outside the plugin temporary root'))
  await assert.rejects(lstat(owned))
  assert.equal(await readFile(foreign, 'utf8'), 'preserve until explicit cleanup')
  assert.deepEqual((await ledger.listByPreview('preview')).map(entry => entry.id), [foreignEntry.id])
})

test('reconcile reclaims only orphaned verified processes; live-owned and reused PIDs stay residual', darwin, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = createFileLedger(dir)
  const victim = await spawnOrphan(t)
  const owned = await ledger.record({ ...owner(dir), resource: { kind: 'process', pid: victim.pid, pgid: victim.pgid, startTime: victim.startTime, command: 'test leader' } })
  // 已核对存活但父进程仍在运行：资源属于活着的持有者，只能标为 active 残留，不终止也不归档。
  const held = await spawnIdle(t)
  const heldEntry = await ledger.record({ ...owner(dir), resource: { kind: 'process', pid: held.pid, pgid: held.pgid, startTime: held.startTime, command: 'test leader' } })
  // 记录的 PID 仍是活进程但启动时间不符：说明登记对象已死、槽位复用，只能保留为残留。
  // 复用模拟用测试进程自身的 PID：启动时间故意不符，永远命中残留分支，与记录顺序无关。
  const reused = await ledger.record({ ...owner(dir), resource: { kind: 'process', pid: process.pid, startTime: 'a different boot time', command: 'test leader' } })
  const report = await ledger.reconcile()
  assert.deepEqual(report.reclaimed.map(item => item.entry.id), [owned.id])
  await gone(victim.pid)
  assert.equal(report.residual.length, 2)
  const active = report.residual.find(item => item.entry.id === heldEntry.id)
  assert.equal(active?.active, true)
  const stale = report.residual.find(item => item.entry.id === reused.id)
  assert.ok(stale && !stale.active && stale.reason.includes('different process'))
  // active 登记不可归档：恢复入口不解除仍被活持有者占用的资源。
  const recovered = await ledger.reconcile({ archiveResidual: true })
  assert.deepEqual(recovered.archived, [reused.id + '.json'])
  assert.deepEqual((await ledger.listByPreview('preview')).map(entry => entry.id), [heldEntry.id])
  // 持有者退出后记录成为孤儿资源，正常回收并解除占用。
  process.kill(-held.pgid, 'SIGKILL')
  await gone(held.pid)
  const clean = await ledger.reconcile()
  assert.equal(clean.residual.length, 0)
  assert.deepEqual(await ledger.listByPreview('preview'), [])
})

test('reconcile kills orphaned members of a recorded process group whose leader exited', darwin, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = createFileLedger(dir)
  // 组内后代不脱离进程组：组长被杀后，成员仍以登记 pgid 存活。
  const leader = await spawnIdle(t, [
    "const {spawn} = require('node:child_process')",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], { stdio: 'ignore' }).unref()",
    'setInterval(() => {}, 1000000)',
  ].join(';'))
  await delay(300) // 等后代进入进程组
  const entry = await ledger.record({ ...owner(dir), resource: { kind: 'process', pid: leader.pid, pgid: leader.pgid, startTime: leader.startTime, command: 'test leader' } })
  const before = await processTable()
  const members = [...before.values()].filter(process => process.pgid === leader.pgid && process.pid !== leader.pid)
  assert.ok(members.length >= 1)
  process.kill(leader.pid, 'SIGKILL')
  await gone(leader.pid)
  const report = await ledger.reconcile()
  assert.equal(report.residual.length, 0)
  assert.deepEqual(report.reclaimed.map(item => item.action), ['terminated recorded process group'])
  assert.deepEqual(await ledger.listByPreview('preview'), [])
  const after = await processTable()
  assert.ok(![...after.values()].some(process => process.pgid === leader.pgid))
  for (const member of members) assert.notEqual(await readProcessStartTime(member.pid), member.startTime)
})

test('reconcile releases dead ports and retains listeners whose ownership is unverified', darwin, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  t.after(() => server.close())
  const ledger = createFileLedger(dir)
  const free = await ledger.record({ ...owner(dir), resource: { kind: 'port', port: 1 } })
  const live = await ledger.record({ ...owner(dir), resource: { kind: 'port', port: address.port, pid: process.pid } })
  const report = await ledger.reconcile()
  assert.deepEqual(report.reclaimed.map(item => item.entry.id), [free.id])
  assert.equal(report.residual.length, 1)
  assert.equal(report.residual[0]!.entry.id, live.id)
  server.close()
  for (let i = 0; i < 50 && (await findListeningPids(address.port)).length; i++) await delay(20)
  const second = await ledger.reconcile()
  assert.deepEqual(second.residual, [])
  assert.deepEqual((await ledger.listByPreview('preview')).map(entry => entry.id), [])
})

test('corrupt records block allocation in reports but keep the rest of reconcile working', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = createFileLedger(dir)
  await mkdir(join(dir, 'ledger'), { recursive: true })
  await writeFile(join(dir, 'ledger', 'broken-name.json'), '{ not an entry')
  const gone = await ledger.record({ ...owner(dir), resource: { kind: 'path', path: join(dir, 'already-gone') } })
  const report = await ledger.reconcile()
  assert.equal(report.corrupt.length, 1)
  assert.equal(report.corrupt[0]!.name, 'broken-name.json')
  assert.deepEqual(report.reclaimed.map(item => item.entry.id), [gone.id])
  assert.equal(report.residual.length, 0)
})

test('recover archives residual and corrupt records so the workspace is never permanently locked', darwin, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = createFileLedger(dir)
  const foreign = join(dir, 'foreign-path')
  await writeFile(foreign, 'not ours')
  const stuck = await ledger.record({ ...owner(dir), resource: { kind: 'path', path: foreign } })
  await mkdir(join(dir, 'ledger'), { recursive: true })
  await writeFile(join(dir, 'ledger', 'corrupt.json'), '[]')
  const blocked = await ledger.reconcile()
  assert.equal(blocked.residual.length, 1)
  assert.equal(blocked.corrupt.length, 1)
  const report = await ledger.reconcile({ archiveResidual: true })
  assert.deepEqual(report.archived.sort(), ['corrupt.json', stuck.id + '.json'].sort())
  assert.equal(report.residual.length, 1)
  assert.equal(report.corrupt.length, 1)
  assert.equal((await ledger.listByPreview('preview')).length, 0)
  const names = await readdir(join(dir, 'residual-archive'))
  assert.deepEqual(names.sort(), ['corrupt.json', stuck.id + '.json'].sort())
  const clean = await ledger.reconcile()
  assert.deepEqual(clean.residual, [])
  assert.deepEqual(clean.corrupt, [])
  assert.equal(await readFile(foreign, 'utf8'), 'not ours')
})
