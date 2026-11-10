/**
 * Host/Runner 共用资源账本（方案 §9.2）；不执行项目代码。
 * 先写账本再返回资源；Host/Runner 被强制结束后，下次启动按账本对账。
 * PID 仍存在且进程启动时间一致才视为同一进程（防 PID 复用）；不按进程名/命令行模糊匹配。
 * v1.4：对账必须包含回收——核对归属后主动回收；只有确实无法核对才保留为残留。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, rename, rm, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DiagnosticCode, RunnerSessionError } from '../errors.ts'
import { findListeningPids } from './port-ownership.ts'
import { procProcessStartTime } from './procfs.ts'
import {
  groupMembersOf, hasLiveParent, processTable, signalGroup, signalPid, usesProcessGroups,
} from './process-table.ts'
import type { ProcessGroup, ProcessIdentity } from './process-table.ts'
import { winProcessStartTime } from './winproc.ts'

const execFileAsync = promisify(execFile)

export type LedgerResource =
  | { kind: 'process'; pid: number; pgid?: number; startTime: string; command: string }
  | { kind: 'port'; port: number; pid?: number }
  | { kind: 'path'; path: string }

export interface LedgerEntry {
  id: string
  previewId: string
  ownerSessionId: string
  workspaceRoot: string
  resource: LedgerResource
  createdAt: string
}

export interface ReconcileReport {
  /** 已核对归属并回收（终止进程、删除自有临时路径），或确认资源已消失的登记项。 */
  reclaimed: Array<{ entry: LedgerEntry; action: string }>
  /** 无法核对归属或回收失败的条目；恢复入口可把记录归档以解除工作区占用。
   * `active` 标记表示资源仍被活着的持有进程使用（仍属有效登记），恢复入口不归档也不发信号。 */
  residual: Array<{ entry: LedgerEntry; reason: string; active?: boolean }>
  /** 无法解析的账本记录文件；与残留一样阻止新的分配。 */
  corrupt: Array<{ name: string; reason: string }>
  /** archiveResidual 时被移出活动账本的记录文件名，只报告、不静默。 */
  archived: string[]
}

export interface ReconcileOptions {
  /** 恢复入口使用：回收后仍无法核对的记录移入 residual-archive，工作区不得被永久锁死。 */
  archiveResidual?: boolean
}

export interface ResourceLedger {
  record(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): Promise<LedgerEntry>
  release(entryId: string): Promise<void>
  listByPreview(previewId: string): Promise<LedgerEntry[]>
  /** 核对并回收本插件拥有的资源；确实无法核对的保留为残留并报告，不碰账本以外的资源。 */
  reconcile(options?: ReconcileOptions): Promise<ReconcileReport>
}

/**
 * 每个资源一个不可变文件，避免多个会话读改写同一 JSON 导致记录丢失。
 * 临时文件写完后 rename 发布；对账逐条核对归属并回收，残留供生命周期层提示。
 */
export function createFileLedger(dataDir: string): ResourceLedger {
  if (!isAbsolute(dataDir)) throw new Error('Ledger data directory must be absolute')
  const dir = join(dataDir, 'ledger')
  const archive = join(dataDir, 'residual-archive')
  const file = (id: string) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid ledger entry ID')
    return join(dir, id + '.json')
  }
  const list = async () => {
    let names: string[]
    try { names = await readdir(dir) }
    catch (error) {
      if (missing(error)) return []
      throw error
    }
    const entries: LedgerEntry[] = []
    for (const name of names.sort()) {
      // 未完成的写入不对调用者可见；失败/被强制结束的写入不伪装成已登记资源。
      if (name.endsWith('.tmp')) continue
      if (!name.endsWith('.json')) throw new Error('Unexpected file in resource ledger')
      const id = name.slice(0, -5)
      try {
        const entry = parseEntry(JSON.parse(await readFile(file(id), 'utf8')))
        if (entry.id !== id) throw new Error('Ledger entry identity does not match filename')
        entries.push(entry)
      } catch (error) {
        // 其他调用者已正常 release 的文件可以消失；损坏记录和权限错误必须暴露。
        if (!missing(error)) throw error
      }
    }
    return entries
  }
  const release = async (id: string) => { await rm(file(id), { force: true }) }
  return {
    async record(input) {
      const entry = parseEntry({ ...input, id: randomUUID(), createdAt: new Date().toISOString() })
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const destination = file(entry.id)
      const temporary = destination + '.tmp'
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(entry))
          await handle.sync()
        } finally { await handle.close() }
        await rename(temporary, destination)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      return entry
    },
    release,
    async listByPreview(previewId) { return (await list()).filter((entry) => entry.previewId === previewId) },
    async reconcile(options = {}) {
      const report: ReconcileReport = { reclaimed: [], residual: [], corrupt: [], archived: [] }
      // 对账允许单条记录损坏：损坏记录计入 corrupt，不中断对其余记录的核对回收。
      const scanned = await scan(dir)
      report.corrupt.push(...scanned.corrupt)
      const groups: Record<LedgerResource['kind'], LedgerEntry[]> = { process: [], port: [], path: [] }
      for (const entry of scanned.entries) groups[entry.resource.kind].push(entry)
      const settle = async (entry: LedgerEntry, outcome: ReclaimOutcome) => {
        if ('reason' in outcome) report.residual.push({ entry, reason: outcome.reason, ...(outcome.active ? { active: true } : {}) })
        else {
          await release(entry.id)
          report.reclaimed.push({ entry, action: outcome.action })
        }
      }
      // 先终止核对的进程持有者，再核对端口与路径。
      let table: Map<number, ProcessIdentity> | undefined
      for (const entry of groups.process) {
        try {
          table = await processTable()
          await settle(entry, await reclaimProcess(entry.resource as Extract<LedgerResource, { kind: 'process' }>, table))
        } catch (error) {
          report.residual.push({ entry, reason: 'Process inspection failed: ' + describe(error) })
        }
      }
      for (const entry of groups.port) {
        try { await settle(entry, await reclaimPort(entry.resource as Extract<LedgerResource, { kind: 'port' }>)) }
        catch (error) { report.residual.push({ entry, reason: 'Port inspection failed: ' + describe(error) }) }
      }
      for (const entry of groups.path) {
        try { await settle(entry, await reclaimPath(entry.resource as Extract<LedgerResource, { kind: 'path' }>)) }
        catch (error) { report.residual.push({ entry, reason: 'Path reclamation failed: ' + describe(error) }) }
      }
      if (options.archiveResidual && (report.residual.length || report.corrupt.length)) {
        await mkdir(archive, { recursive: true, mode: 0o700 })
        const move = async (name: string) => {
          try {
            await rename(join(dir, name), join(archive, name))
            report.archived.push(name)
          } catch (error) {
            if (!missing(error)) throw error
          }
        }
        for (const item of report.residual) if (!item.active) await move(item.entry.id + '.json')
        for (const item of report.corrupt) await move(item.name)
      }
      return report
    },
  }
}

type ReclaimOutcome = { action: string } | { reason: string; active?: boolean }

/**
 * 存活且启动时间一致的进程只有在成为孤儿（父进程已退出：POSIX 被 reparent 到 PID 1，Windows 父 PID
 * 已不存在或被更晚创建的进程复用）时才回收：父进程仍活着说明资源属于一个仍在运行的持有者（例如另一个
 * Host 存活的 Runner），归为 active 残留——不终止、不归档，与方案 §15.3「不终止原进程」一致。
 */
async function reclaimProcess(
  resource: Extract<LedgerResource, { kind: 'process' }>,
  table: Map<number, ProcessIdentity>,
): Promise<ReclaimOutcome> {
  const self = table.get(resource.pid)
  if (!self) {
    if (resource.pgid === undefined) return { action: 'recorded process is gone' }
    return reclaimOrphanGroup(recordedGroup(resource)!, table)
  }
  if (self.startTime !== resource.startTime) {
    return { reason: 'Recorded PID is used by a different process; ownership is unverified' }
  }
  if (hasLiveParent(self, table)) {
    return { reason: 'Process is alive under a live parent; still owned', active: true }
  }
  const signaled = signaledGroup(resource, self)
  if (signaled) signalGroup(signaled, groupMembersOf(table, signaled), 'SIGTERM')
  else signalPid(resource.pid, 'SIGTERM')
  const reasons: string[] = []
  const outcome = await settleSignaled(resource, signaled)
  if (outcome) reasons.push(outcome)
  if (resource.pgid !== undefined && resource.pgid !== signaled?.pgid) {
    const orphan = await reclaimOrphanGroup(recordedGroup(resource)!, table)
    if ('reason' in orphan) reasons.push(orphan.reason)
  }
  if (reasons.length) return { reason: reasons.join('; ') }
  return { action: 'terminated verified process' }
}

/** 登记的进程组；组长自身的登记项带组长启动时间（Windows 判定后代需要）。 */
function recordedGroup(resource: Extract<LedgerResource, { kind: 'process' }>): ProcessGroup | undefined {
  if (resource.pgid === undefined) return undefined
  return resource.pgid === resource.pid
    ? { pgid: resource.pgid, leaderStart: resource.startTime }
    : { pgid: resource.pgid }
}

/**
 * 本次信号的目标组。POSIX：登记后进程换组时，-pgid 会命中无关进程组，此时只终止进程本身，登记组另按
 * 孤儿组核对。Windows：没有换组，组长登记项即按其后代成组。
 */
function signaledGroup(
  resource: Extract<LedgerResource, { kind: 'process' }>,
  self: ProcessIdentity,
): ProcessGroup | undefined {
  if (!usesProcessGroups()) return resource.pgid === resource.pid ? recordedGroup(resource) : undefined
  if (resource.pgid !== undefined && self.pgid === resource.pgid) return { pgid: resource.pgid }
  if (self.pid === self.pgid) return { pgid: self.pid }
  return undefined
}

/** 组长已退出（或换组）的登记进程组：成员仍是本组号才终止，同号新组长视为归属无法核对。 */
async function reclaimOrphanGroup(
  group: ProcessGroup,
  table: Map<number, ProcessIdentity>,
): Promise<ReclaimOutcome> {
  const members = groupMembersOf(table, group)
  if (!members.length) return { action: 'recorded process group is gone' }
  // 登记的组长 PID 被新组长复用时，组内成员归属无法区分，不向任何成员发信号。
  if (members.some(process => process.pid === group.pgid)) {
    return { reason: 'Process group has a live leader whose identity cannot be verified' }
  }
  for (const member of members) signalPid(member.pid, 'SIGTERM')
  const remaining = await waitForMembers(group, 1500)
  for (const member of remaining) signalPid(member.pid, 'SIGKILL')
  if (remaining.length) await delay(500)
  const left = await groupMembers(group)
  if (left.length) return { reason: 'Process group members could not be terminated: ' + left.join(', ') }
  return { action: 'terminated recorded process group' }
}

/** 等待已发信号的对象消失；SIGKILL 升级只作用于信号目标集合内的存活成员。 */
async function settleSignaled(
  resource: Extract<LedgerResource, { kind: 'process' }>,
  signaled: ProcessGroup | undefined,
): Promise<string | undefined> {
  const deadline = Date.now() + 1500
  while (true) {
    const left = await signaledSurvivors(resource, signaled)
    if (!left.length) return undefined
    if (Date.now() >= deadline) break
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
  }
  const left = await signaledSurvivors(resource, signaled)
  for (const process of left) signalPid(process.pid, 'SIGKILL')
  await delay(500)
  const still = await signaledSurvivors(resource, signaled)
  if (still.length) return 'Verified process could not be fully terminated: ' + still.map(value => value.pid).join(', ')
  return undefined
}

/** 信号目标集合内的存活进程：进程组目标按组收集，单 PID 目标只核对启动时间。 */
async function signaledSurvivors(
  resource: Extract<LedgerResource, { kind: 'process' }>,
  signaled: ProcessGroup | undefined,
): Promise<ProcessIdentity[]> {
  const table = await processTable()
  if (signaled !== undefined) return groupMembersOf(table, signaled)
  const self = table.get(resource.pid)
  return self?.startTime === resource.startTime ? [self] : []
}

async function groupMembers(group: ProcessGroup): Promise<number[]> {
  return groupMembersOf(await processTable(), group).map(process => process.pid)
}

async function waitForMembers(group: ProcessGroup, graceMs: number): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + graceMs
  while (true) {
    const left = groupMembersOf(await processTable(), group)
    if (!left.length || Date.now() >= deadline) return left
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
  }
}

async function reclaimPort(resource: Extract<LedgerResource, { kind: 'port' }>): Promise<ReclaimOutcome> {
  // 端口记录不含启动时间，不能对监听者发信号；持有者已在进程回收阶段处理。
  for (let attempt = 0; attempt < 3; attempt++) {
    const pids = await findListeningPids(resource.port)
    if (!pids.length) return { action: 'port has no listener' }
    if (attempt < 2) await delay(300)
  }
  return { reason: 'Port still has a listener whose ownership is unverified' }
}

async function reclaimPath(resource: Extract<LedgerResource, { kind: 'path' }>): Promise<ReclaimOutcome> {
  try { await lstat(resource.path) }
  catch (error) {
    if (missing(error)) return { action: 'recorded path is gone' }
    throw error
  }
  // 只回收插件临时根目录下按固定前缀创建的自己登记的路径；其余位置一律不碰。
  // 父目录按 realpath 比较，避免 macOS 上 /var → /private/var 之类符号链接把合法记录误判为外部路径。
  const [root, parent] = await Promise.all([realpath(tmpdir()), realpath(dirname(resource.path))])
  if (parent !== root || !/^dsh-preview-/.test(basename(resource.path))) {
    return { reason: 'Recorded path is outside the plugin temporary root; ownership is unverified' }
  }
  await rm(resource.path, { recursive: true, force: true })
  try { await lstat(resource.path) }
  catch (error) {
    if (missing(error)) return { action: 'removed plugin temporary path' }
    throw error
  }
  return { reason: 'Plugin temporary path could not be removed' }
}

/** 对账专用扫描：无法解析的记录单独报告，不中断其余记录；严格视图仍由 list 提供。 */
async function scan(dir: string): Promise<{ entries: LedgerEntry[]; corrupt: Array<{ name: string; reason: string }> }> {
  let names: string[]
  try { names = await readdir(dir) }
  catch (error) {
    if (missing(error)) return { entries: [], corrupt: [] }
    throw error
  }
  const entries: LedgerEntry[] = []
  const corrupt: Array<{ name: string; reason: string }> = []
  for (const name of names.sort()) {
    if (name.endsWith('.tmp')) continue
    if (!name.endsWith('.json')) {
      corrupt.push({ name, reason: 'Unexpected file in resource ledger' })
      continue
    }
    try {
      const entry = parseEntry(JSON.parse(await readFile(join(dir, name), 'utf8')))
      if (entry.id !== name.slice(0, -5)) throw new Error('Ledger entry identity does not match filename')
      entries.push(entry)
    } catch (error) {
      if (!missing(error)) corrupt.push({ name, reason: describe(error) })
    }
  }
  return { entries, corrupt }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseEntry(value: unknown): LedgerEntry {
  if (!object(value) || !text(value.id) || !text(value.previewId) || !text(value.ownerSessionId) ||
      !text(value.workspaceRoot) || !isAbsolute(value.workspaceRoot) || !text(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) || !object(value.resource)) throw new Error('Invalid ledger entry')
  const resource = value.resource
  let parsed: LedgerResource
  if (resource.kind === 'process' && positive(resource.pid) && text(resource.startTime) && text(resource.command) &&
      (resource.pgid === undefined || positive(resource.pgid))) {
    parsed = { kind: 'process', pid: resource.pid, startTime: resource.startTime, command: resource.command,
      ...(resource.pgid === undefined ? {} : { pgid: resource.pgid }) }
  } else if (resource.kind === 'port' && positive(resource.port) && resource.port <= 65535 &&
      (resource.pid === undefined || positive(resource.pid))) {
    parsed = { kind: 'port', port: resource.port, ...(resource.pid === undefined ? {} : { pid: resource.pid }) }
  } else if (resource.kind === 'path' && text(resource.path) && isAbsolute(resource.path)) {
    parsed = { kind: 'path', path: resource.path }
  } else throw new Error('Invalid ledger resource')
  return { id: value.id, previewId: value.previewId, ownerSessionId: value.ownerSessionId,
    workspaceRoot: value.workspaceRoot, createdAt: value.createdAt, resource: parsed }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

/**
 * 读取进程启动时间，用于防 PID 复用。
 * macOS 用 ps lstart（已实测）；Linux 用 /proc/<pid>/stat 的 starttime jiffies（合成树单测，端到端待验）；
 * Windows 用 CIM CreationDate 的 FILETIME（合成输出单测，真实 Windows 未验）；
 * 其余平台返回 unsupported，不把未知归属当成进程不存在。
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('PID must be a positive integer')
  if (process.platform === 'linux') return procProcessStartTime(pid)
  if (process.platform === 'win32') return winProcessStartTime(pid)
  if (process.platform !== 'darwin') {
    throw new RunnerSessionError({
      code: DiagnosticCode.unsupportedCapability, phase: 'start',
      message: 'Process start-time inspection is not implemented on ' + process.platform,
      hint: 'Run on a supported platform (macOS, Linux or Windows); there is no ownership-check fallback',
    })
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'stat=,lstart=', '-p', String(pid)],
      { env: { LC_ALL: 'C' } })
    const match = /^(\S+)\s+(.+?)\s*$/.exec(stdout.trim())
    if (!match) throw new Error('ps returned no start time for a live process')
    // 已终止待回收（Z/X）视为已退出：不占用资源，也不作为身份证据。
    if (match[1]!.startsWith('Z') || match[1]!.startsWith('X')) return undefined
    return match[2]!
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1 &&
        'stdout' in error && error.stdout === '' && 'stderr' in error && error.stderr === '') return undefined
    throw error
  }
}
