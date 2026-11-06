/**
 * 单个工作区内的 Runner 会话编排（方案 §9.2）。
 * 启动/切换/停止串行登记，保证先释放旧目标再创建新目标；异步启动不阻塞状态查询。
 * 仅用于 Runner，调用方须先完成配置、能力和执行授权；不生成批准或操作其他工作区。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { PreviewPlan } from '../shared/contracts.ts'
import { DiagnosticCode } from '../shared/errors.ts'
import type { RunnerToHost } from '../shared/ipc.ts'
import { RunnerSession, RunnerSessionError } from './session.ts'
import type { SessionContext } from './session.ts'

export type WorkspaceOpenResult =
  // takenOver：新会话接管了另一 DSH 会话的预览（旧预览已按账本完整清理，2026-11-03 Aesc 决策）。
  | { kind: 'created' | 'reused'; session: RunnerSession; started: Promise<void>; takenOver?: string }
  | { kind: 'busy'; occupant: Entry }
  | { kind: 'not-found' | 'closed' }

export interface Entry {
  ownerSessionId: string
  session: RunnerSession
  started: Promise<void>
}

export class RunnerWorkspace {
  private readonly root: string
  private canonicalRoot: Promise<string> | undefined
  private readonly cleanupTimeoutMs: number
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(message: RunnerToHost) => void>()
  private mutations: Promise<void> = Promise.resolve()
  private closing = false
  private shutdownTask: Promise<Array<{ previewId: string; state: RunnerSession['state']; residual: string[] }>> | undefined

  constructor(workspaceRoot: string, options: { cleanupTimeoutMs?: number } = {}) {
    if (!isAbsolute(workspaceRoot)) throw new Error('Runner workspace must be absolute')
    this.root = workspaceRoot
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000
  }

  onMessage(listener: (message: RunnerToHost) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(previewId: string, plan: PreviewPlan, adapter: Parameters<RunnerSession['start']>[0], context: SessionContext, signal?: AbortSignal): Promise<WorkspaceOpenResult> {
    return this.mutate(async () => {
      if (this.closing) return { kind: 'closed' }
      signal?.throwIfAborted()
      if (!previewId || !context.ownerSessionId) throw new RunnerSessionError({ code: DiagnosticCode.configInvalid, phase: 'plan', message: 'Preview and owner IDs are required', hint: 'Use the validated caller context' })
      if (!isAbsolute(context.workspaceRoot)) throw new RunnerSessionError({ code: DiagnosticCode.ownershipUnverified, phase: 'start', message: 'Session workspace must be absolute', hint: 'Use the validated workspace context' })
      this.canonicalRoot ??= realpath(this.root)
      const [workspace, supplied] = await Promise.all([this.canonicalRoot, realpath(context.workspaceRoot)])
      if (workspace !== supplied) throw new RunnerSessionError({ code: DiagnosticCode.ownershipUnverified, phase: 'start', message: 'Session belongs to a different workspace', hint: 'Use the Runner assigned to the validated workspace' })
      if (this.closing) return { kind: 'closed' }
      signal?.throwIfAborted()
      const candidate = new RunnerSession(previewId, plan, { cleanupTimeoutMs: this.cleanupTimeoutMs })
      candidate.validateStart(adapter, context)
      const existing = this.entries.get(previewId)
      if (existing) {
        if (existing.ownerSessionId !== context.ownerSessionId || ['failed', 'stopped'].includes(existing.session.state)) return { kind: 'not-found' }
        if (existing.session.state === 'cleanup_failed' || !isDeepStrictEqual(existing.session.plan, plan)) return { kind: 'busy', occupant: existing }
        return { kind: 'reused', session: existing.session, started: existing.started }
      }
      const active = [...this.entries.values()].find(entry => !['failed', 'stopped'].includes(entry.session.state))
      let takenOver: string | undefined
      if (active) {
        if (active.session.state === 'cleanup_failed') return { kind: 'busy', occupant: active }
        const sameOwner = active.ownerSessionId === context.ownerSessionId
        if (sameOwner && isDeepStrictEqual(active.session.plan, plan)) {
          return { kind: 'reused', session: active.session, started: active.started }
        }
        // 计划/场景变化一律停旧启新（P1-4）；另一 DSH 会话的预览由新会话接管（2026-11-03 Aesc 决策：桌面端
        // 各会话同属一个用户，旧会话中止后其预览不应锁住工作区）。都先按账本完整清理旧预览，残留时如实 busy。
        if ((await active.session.stop()).residual.length) return { kind: 'busy', occupant: active }
        if (!sameOwner) takenOver = active.session.previewId
      }
      if (this.closing) return { kind: 'closed' }
      signal?.throwIfAborted()
      // 先登记，再异步调用适配器；事件消费者查询时不会遇到尚未登记的 previewId。
      const session = candidate
      session.onMessage(message => { for (const listener of this.listeners) listener(message) })
      const started = Promise.resolve().then(() => session.start(adapter, { ...context, workspaceRoot: workspace }, signal))
      // 即使调用方只轮询状态，启动失败仍由会话诊断/终态暴露；原 Promise 保留拒绝供等待者读取。
      void started.catch(() => {})
      this.entries.set(previewId, { ownerSessionId: context.ownerSessionId, session, started })
      return { kind: 'created', session, started, ...(takenOver === undefined ? {} : { takenOver }) }
    })
  }

  get(previewId: string, ownerSessionId: string): RunnerSession | undefined {
    const entry = this.entries.get(previewId)
    return entry?.ownerSessionId === ownerSessionId ? entry.session : undefined
  }

  list(ownerSessionId: string): RunnerSession[] {
    return [...this.entries.values()].filter(entry => entry.ownerSessionId === ownerSessionId).map(entry => entry.session)
  }

  /** 无法归属到单个会话的写点（如 Runner 级命令失败）的脱敏兜底：全部存活会话的密钥并集。 */
  redactionSecrets(): string[] {
    const live = [...this.entries.values()].filter(entry => !['failed', 'stopped'].includes(entry.session.state))
    return [...new Set(live.flatMap(entry => [...entry.session.redactionSecrets]))]
  }

  stop(previewId: string, ownerSessionId: string): Promise<{ residual: string[] } | undefined> {
    return this.mutate(async () => this.get(previewId, ownerSessionId)?.stop())
  }

  /** Host 断开/Runner 退出时由控制器调用，收束本实例拥有的全部会话；有残留时允许重试。 */
  shutdown(): Promise<Array<{ previewId: string; state: RunnerSession['state']; residual: string[] }>> {
    this.closing = true
    if (this.shutdownTask) return this.shutdownTask
    this.shutdownTask = this.mutate(async () => Promise.all([...this.entries].map(async ([previewId, entry]) => {
      const result = await entry.session.stop()
      return { previewId, state: entry.session.state, ...result }
    }))).finally(() => { this.shutdownTask = undefined })
    return this.shutdownTask
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action)
    // 只恢复队列的调度能力；调用方收到的 result 仍明确拒绝，不能让一次错误永久锁住工作区。
    this.mutations = result.then(() => {}, () => {})
    return result
  }
}
