/**
 * macOS OS 行为与文件账本探针（方案 §9.2、§14），不代替完整 Runner 生命周期验收。
 * 只创建/终止自己的临时 Host 和服务；按 PID+启动时间验证，所有数据用完删除。
 * node dev/phase0-process.ts
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { findListeningPids, findOwnedListeningPorts } from '../../src/runner/port-ownership.ts'

interface RecordedProcess {
  pid: number; pgid: number; startTime: string; port: number
  childPid: number; childStartTime: string; childPort: number
}

if (process.platform !== 'darwin') throw new Error('This Phase 0 probe is only verified on macOS')
const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-process-'))
const ledgerPath = join(dir, 'probe-ledger.json')
const host = fork(new URL('../../tests/fixtures/process-tree/host.mjs', import.meta.url), [ledgerPath, dir], {
  execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {},
})
const hostExited = once(host, 'exit')
let entry: RecordedProcess | undefined
let hostStart: string | undefined
try {
  assert.ok(host.pid)
  hostStart = await readProcessStartTime(host.pid)
  assert.ok(hostStart)
  await once(host, 'message', { signal: AbortSignal.timeout(5000) })
  entry = parseRecord(JSON.parse(await readFile(ledgerPath, 'utf8')))
  assert.deepEqual(await findListeningPids(entry.port), [entry.pid])
  assert.deepEqual(await findOwnedListeningPorts(entry.pid), [entry.port, entry.childPort].sort((a, b) => a - b))
  assert.equal(await readProcessStartTime(host.pid), hostStart)
  host.kill('SIGKILL')
  await hostExited
  const ledger = createFileLedger(dir)
  const persisted = await ledger.listByPreview('phase0-process')
  assert.equal(persisted.length, 4)
  const recovered = await ledger.reconcile()
  assert.equal(recovered.reclaimed.length, 0)
  assert.equal(recovered.residual.length, 4)
  // Host 已死，文件仍在；独立进程组里的服务仍在，不能假定 Host 退出就释放了端口。
  entry = parseRecord(JSON.parse(await readFile(ledgerPath, 'utf8')))
  assert.equal(await readProcessStartTime(entry.pid), entry.startTime)
  assert.deepEqual(await findListeningPids(entry.port), [entry.pid])
  assert.deepEqual(await findListeningPids(entry.childPort), [entry.childPid])
  assert.equal(await terminateRecorded({ ...entry, startTime: 'mismatching saved identity' }), false)
  assert.deepEqual(await findListeningPids(entry.port), [entry.pid])
  assert.equal(await terminateRecorded(entry), true)
  assert.deepEqual(await findListeningPids(entry.port), [])
  assert.deepEqual(await findListeningPids(entry.childPort), [])
  const afterCleanup = await ledger.reconcile()
  assert.equal(afterCleanup.reclaimed.length, 3)
  assert.equal(afterCleanup.residual.length, 1)
  assert.ok(afterCleanup.residual[0]?.reason.includes('Group leader has exited'))
  // 对账只负责提示；本探针在核对整组进程及两个监听已消失后显式释放其记录。
  for (const resource of persisted) await ledger.release(resource.id)
  assert.deepEqual(await ledger.listByPreview('phase0-process'), [])
  console.log(JSON.stringify({
    platform: 'macOS', hostSigkill: 'verified', orphanRecordSurvives: 'verified',
    wrongIdentityNotSignalled: 'verified', processGroupTerminated: 'verified',
    fileLedgerAfterHostSigkill: '4 records preserved and reported', runnerLifecycle: 'not-implemented',
  }))
} finally {
  if (host.pid && hostStart && await readProcessStartTime(host.pid) === hostStart) {
    host.kill('SIGKILL')
    await hostExited
  }
  // 如果测试在读取账本前失败，仍从本次临时目录恢复自己的记录。
  if (!entry) {
    try { entry = parseRecord(JSON.parse(await readFile(ledgerPath, 'utf8'))) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  if (entry && await anyStillOwned(entry)) {
    assert.equal(await terminateRecorded(entry), true, `Disposable service cleanup failed; record retained at ${ledgerPath}`)
  }
  await rm(dir, { recursive: true })
}

async function terminateRecorded(saved: RecordedProcess): Promise<boolean> {
  if (saved.pid !== saved.pgid) throw new Error('Probe only signals its own detached process group')
  if (await readProcessStartTime(saved.pid) !== saved.startTime) return false
  process.kill(-saved.pgid, 'SIGTERM')
  const deadline = Date.now() + 2000
  while (await anyStillOwned(saved) && Date.now() < deadline) await delay(25)
  if (await anyStillOwned(saved)) {
    process.kill(-saved.pgid, 'SIGKILL')
    const killDeadline = Date.now() + 2000
    while (await anyStillOwned(saved) && Date.now() < killDeadline) await delay(25)
  }
  return !await anyStillOwned(saved)
}

async function anyStillOwned(saved: RecordedProcess): Promise<boolean> {
  return await readProcessStartTime(saved.pid) === saved.startTime ||
    await readProcessStartTime(saved.childPid) === saved.childStartTime
}

function parseRecord(value: unknown): RecordedProcess {
  if (typeof value !== 'object' || value === null || !('pid' in value) || !('pgid' in value) ||
      !('startTime' in value) || !('port' in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
      value.pid !== value.pgid || typeof value.startTime !== 'string' || !value.startTime ||
      !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
    throw new Error('Invalid disposable process record')
  }
  if (!('childPid' in value) || !Number.isSafeInteger(value.childPid) || Number(value.childPid) < 1 ||
      !('childStartTime' in value) || typeof value.childStartTime !== 'string' || !value.childStartTime ||
      !('childPort' in value) || !Number.isSafeInteger(value.childPort) || Number(value.childPort) < 1 || Number(value.childPort) > 65535) {
    throw new Error('Invalid disposable descendant record')
  }
  return { pid: Number(value.pid), pgid: Number(value.pgid), startTime: value.startTime, port: Number(value.port),
    childPid: Number(value.childPid), childStartTime: value.childStartTime, childPort: Number(value.childPort) }
}
