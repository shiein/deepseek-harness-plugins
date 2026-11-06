/**
 * 托管进程与进程树终止（方案 §9.2）。
 * - POSIX：detached 新进程组；停止时对 -pgid 发 SIGTERM，超时后 SIGKILL
 * - 当前只启用已实测的 macOS；Windows/Linux 在分配资源前明确拒绝
 * - npm run 等包装进程不一定转发信号，不能只杀直接子进程
 * - setsid 脱离进程组的后代无法覆盖，列为残留
 * - 先登记账本再返回句柄
 */

import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DiagnosticCode } from '../shared/errors.ts'
import { processTable, requireSupportedPlatform, signalPid } from '../shared/runner/process-table.ts'
import type { ProcessIdentity } from '../shared/runner/process-table.ts'
import { readProcessStartTime } from './ledger.ts'
import type { ResourceLedger } from './ledger.ts'

export interface ManagedProcessSpec {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** 仅用于插件拥有的执行器协议；原始 stdout/stderr 不作为协议通道。 */
  ipc?: true
}

export interface ManagedIpc {
  send(message: object): Promise<void>
  /** 首次订阅前保留启动消息；订阅取消后不积累无消费者的运行消息。 */
  onMessage(listener: (message: unknown) => void): () => void
}

export interface ManagedProcess {
  pid: number
  pgid: number
  startTime: string
  /** 退出时 resolve。 */
  exited: Promise<{ code: number | null; signal: string | null }>
  stdout: AsyncIterable<string>
  stderr: AsyncIterable<string>
  ipc?: ManagedIpc
  /** 仅完整停止后释放进程账本；有残留时保留记录，可重复调用重试。 */
  stop(graceMs?: number): Promise<number[]>
}

export class ManagedProcessError extends Error {
  readonly code: string
  readonly residualPids: number[]

  constructor(message: string, code: string, residualPids: number[], cause?: unknown) {
    super(message, { cause })
    this.name = 'ManagedProcessError'
    this.code = code
    this.residualPids = residualPids
  }
}

/** env 只使用调用者明确传入的值；signal 只取消本次启动，不绑定已返回预览的整个生命周期。 */
export async function spawnManaged(
  spec: ManagedProcessSpec,
  ledger: ResourceLedger,
  owner: { previewId: string; ownerSessionId: string; workspaceRoot: string },
  signal?: AbortSignal,
): Promise<ManagedProcess> {
  requireSupportedPlatform()
  signal?.throwIfAborted()
  if (!spec.executable || !isAbsolute(spec.cwd) || !isAbsolute(owner.workspaceRoot)) throw new Error('Managed process requires an executable and absolute working directories')
  // 先确认当前运行环境能检查进程身份；例如沙箱拒绝 ps 时不能先启动再留下无法核对的服务。
  await processTable()
  signal?.throwIfAborted()
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, detached: true, stdio: spec.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] })
  const listeners = new Set<(message: unknown) => void>()
  const initialMessages: unknown[] = []
  let subscribed = false
  if (spec.ipc) child.on('message', (message: unknown) => {
    if (!subscribed) initialMessages.push(message)
    else for (const listener of listeners) listener(message)
  })
  const ipc: ManagedIpc = {
    send(message) {
      return new Promise<void>((resolve, reject) => {
        if (!child.connected || !child.send) { reject(new Error('Managed IPC channel is disconnected')); return }
        child.send(message, error => error ? reject(error) : resolve())
      })
    },
    onMessage(listener) {
      listeners.add(listener)
      if (!subscribed) {
        subscribed = true
        for (const message of initialMessages.splice(0)) listener(message)
      }
      return () => listeners.delete(listener)
    },
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // spawn 失败可先于调用者取得句柄；拒绝由下面的启动等待处理，不留下未观察拒绝。
  void exited.catch(() => {})
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const pid = child.pid
  if (!pid) throw new Error('Spawn succeeded without a process id')
  let startTime: string | undefined
  let entryId: string | undefined
  try {
    startTime = await readProcessStartTime(pid)
    if (!startTime) throw new Error('Managed process exited before ownership registration')
    const entry = await ledger.record({ ...owner, resource: { kind: 'process', pid, pgid: pid, startTime, command: spec.executable } })
    entryId = entry.id
    signal?.throwIfAborted()
  } catch (error) {
    if (!startTime) {
      const residual = [...(await processTable()).values()].filter(process => process.pgid === pid).map(process => process.pid)
      if (residual.length) throw new ManagedProcessError('Startup identity unavailable; no unverified process was signalled', DiagnosticCode.cleanupFailed, residual, error)
      throw error
    }
    const residual = await killTree({ pid, pgid: pid, startTime }, 1000)
    if (residual.length) throw new ManagedProcessError('Startup failed with remaining owned resources', DiagnosticCode.cleanupFailed, residual, error)
    if (entryId) await ledger.release(entryId)
    throw error
  }
  if (!child.stdout || !child.stderr || !entryId) throw new Error('Managed process pipes or ledger entry unavailable')
  const identity = { pid, pgid: pid, startTime }
  const id = entryId
  let stopped = false
  let stopping: Promise<number[]> | undefined
  const knownResidual = new Map<number, { identity: ProcessIdentity; entryId?: string }>()
  return {
    ...identity, exited, stdout: textOutput(child.stdout), stderr: textOutput(child.stderr), ...(spec.ipc ? { ipc } : {}),
    stop(graceMs = 5000) {
      if (stopped) return Promise.resolve([])
      if (stopping) return stopping
      stopping = (async () => {
        const remaining = await stopGroup(identity, graceMs, async (escaped) => {
          // 在组长终止前落盘，停止期间 Host 被强制结束也不会丢掉已观察到的逃逸身份。
          for (const process of escaped) {
            let saved = knownResidual.get(process.pid)
            if (!saved) { saved = { identity: process }; knownResidual.set(process.pid, saved) }
            if (!saved.entryId) {
              try {
                const entry = await ledger.record({ ...owner, resource: { kind: 'process', pid: process.pid, pgid: process.pgid, startTime: process.startTime, command: 'observed descendant of ' + spec.executable } })
                saved.entryId = entry.id
              } catch (error) { throw new ManagedProcessError('Unable to persist observed residual process; no signal was sent', DiagnosticCode.cleanupFailed, [pid, ...escaped.map(process => process.pid)], error) }
            }
          }
        })
        const residual = new Set(remaining.map(process => process.pid))
        // 组长消失后仍保留已观察到的逃逸进程；只做身份核对，不向逃逸进程发信号。
        for (const [pid, saved] of knownResidual) {
          if (await readProcessStartTime(pid) === saved.identity.startTime) {
            residual.add(pid)
          } else {
            if (saved.entryId) await ledger.release(saved.entryId)
            knownResidual.delete(pid)
          }
        }
        if (!residual.size) { await ledger.release(id); stopped = true }
        return [...residual].sort((a, b) => a - b)
      })().finally(() => { stopping = undefined })
      return stopping
    },
  }
}

/** 组长身份有效时停止新进程组；组长已消失时不猜测整组归属，返回残留。 */
export async function killTree(proc: Pick<ManagedProcess, 'pid' | 'pgid' | 'startTime'>, graceMs = 5000): Promise<number[]> {
  return (await stopGroup(proc, graceMs)).map(process => process.pid).sort((a, b) => a - b)
}

async function stopGroup(proc: Pick<ManagedProcess, 'pid' | 'pgid' | 'startTime'>, graceMs: number, recordEscaped?: (processes: ProcessIdentity[]) => Promise<void>): Promise<ProcessIdentity[]> {
  requireSupportedPlatform()
  if (!Number.isSafeInteger(proc.pid) || proc.pid < 1 || proc.pgid !== proc.pid || !proc.startTime || !Number.isFinite(graceMs) || graceMs < 0) throw new RangeError('Invalid managed process identity or grace period')
  const initial = await processTable()
  const leader = initial.get(proc.pid)
  const members = [...initial.values()].filter(process => process.pgid === proc.pgid)
  if (!leader) return members
  if (leader.startTime !== proc.startTime || leader.pgid !== proc.pgid) throw new ManagedProcessError('Process identity changed; no signal was sent', DiagnosticCode.ownershipUnverified, [proc.pid])
  const escaped = [...initial.values()].filter(process => process.pgid !== proc.pgid && descendant(process.pid, proc.pid, initial))
  if (recordEscaped && escaped.length) {
    await recordEscaped(escaped)
    if (await readProcessStartTime(proc.pid) !== proc.startTime) throw new ManagedProcessError('Process identity changed while recording descendants; no signal was sent', DiagnosticCode.ownershipUnverified, [proc.pid, ...escaped.map(process => process.pid)])
  }
  signalPid(-proc.pgid, 'SIGTERM')
  let current = await waitForGroup(proc.pgid, graceMs)
  // SIGTERM 后组长可能先退出；只对初始快照中启动时间仍匹配的成员升级信号。
  for (const member of members) {
    const alive = current.get(member.pid)
    if (alive?.startTime === member.startTime && alive.pgid === proc.pgid) signalPid(member.pid, 'SIGKILL')
  }
  if ([...current.values()].some(process => process.pgid === proc.pgid)) current = await waitForGroup(proc.pgid, 1000)
  const residual = [...current.values()].filter(process => process.pgid === proc.pgid)
  for (const process of escaped) if (current.get(process.pid)?.startTime === process.startTime) residual.push(process)
  return residual
}

async function waitForGroup(pgid: number, graceMs: number): Promise<Map<number, ProcessIdentity>> {
  const deadline = Date.now() + graceMs
  while (true) {
    const table = await processTable()
    if (![...table.values()].some(process => process.pgid === pgid) || Date.now() >= deadline) return table
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
  }
}

function descendant(pid: number, root: number, table: Map<number, ProcessIdentity>): boolean {
  const visited = new Set<number>()
  while (table.has(pid) && !visited.has(pid)) {
    if (pid === root) return true
    visited.add(pid)
    pid = table.get(pid)!.ppid
  }
  return false
}

async function* textOutput(stream: Readable): AsyncIterable<string> {
  stream.setEncoding('utf8')
  for await (const chunk of stream) {
    if (typeof chunk !== 'string') throw new Error('Managed process returned a non-text output chunk')
    yield chunk
  }
}
