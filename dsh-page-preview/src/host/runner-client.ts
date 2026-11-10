/** Host 侧 Runner 管理（方案 §6.5、§9.2）；一规范工作区一子进程，Host 不调用适配器 start 或执行项目代码。 */
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { canonicalPath } from '../shared/config/paths.ts'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Diagnostic, PreviewPlan } from '../shared/contracts.ts'
import { DiagnosticCode } from '../shared/errors.ts'
import type { RunnerReply, RunnerRequest, RunnerSnapshot, RunnerToHost } from '../shared/ipc.ts'
import { createFileLedger, readProcessStartTime } from '../shared/runner/ledger.ts'
import type { LedgerEntry } from '../shared/runner/ledger.ts'
import { runnerPaths } from '../shared/runner/paths.ts'
import { RunnerConnection, RunnerConnectionError } from './runner-connection.ts'
import { resolveNodeRuntime } from './node-runtime.ts'
import { platformBaseEnv } from '../shared/runner/platform-env.ts'
import { previewsToEvict, type RetainedPreview } from './snapshot-retention.ts'

export type RunnerListener = (message: RunnerToHost) => void
export const MAX_RECENT_DIAGNOSTICS = 32
export interface PreviewInspection {
  plan: PreviewPlan
  snapshot: RunnerSnapshot
  diagnostics: Diagnostic[]
  diagnosticsTruncated: number
}
export interface RunnerClientOptions {
  dataDir?: string
  nodeExecutable?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
}

interface Worker {
  root: string
  child: ChildProcess
  connection: RunnerConnection
  exited: Promise<void>
  checked: Promise<void>
  identity?: { pid: number; startTime: string }
  entry?: LedgerEntry
  closing: boolean
  dead: boolean
}
/**
 * 插件 dataDir 缺失时 Agent 无法自行修复（它属于 DSH profile 配置）：hint 给出用户要加的确切配置段。
 * 2026-11-03 实机：profile 的 cordis.patch.yml 被改写后 dataDir 丢失，审批静默跳过、Agent 误读源码十分钟。
 */
export const MISSING_DATA_DIR_HINT = 'Ask the user to add this entry to the DSH profile patch '
  + '(~/.dsh/profiles/<profile>/cordis.patch.yml) and restart DSH: '
  + '"- id: page-preview / name: dsh-page-preview / config: dataDir: <absolute path such as /Users/<name>/.dsh/'
  + 'page-preview>"; until then no approval can be requested and no preview can start'

export class RunnerClientError extends Error {
  readonly diagnostic: Diagnostic
  constructor(code: string, message: string, cause?: unknown,
    hint = 'Call page_preview_stop with recover: true to reclaim persisted plugin resources') {
    super(message, { cause })
    this.name = 'RunnerClientError'
    this.diagnostic = { code, phase: 'ledger', message, hint }
  }
}

export class RunnerClient {
  private readonly listeners = new Set<RunnerListener>()
  private readonly workers = new Map<string, Promise<Worker>>()
  private readonly live = new Set<Worker>()
  private readonly bindings = new Map<string, { root: string; owner: string; plan: PreviewPlan }>()
  /** previewId → 回传通道 nonce（channel-secrets 消息）；仅作日志/诊断脱敏密钥，不进入任何输出。 */
  private readonly secrets = new Map<string, Set<string>>()
  private readonly snapshots = new Map<string, RunnerSnapshot>()
  private readonly diagnostics = new Map<string, { items: Diagnostic[]; dropped: number }>()
  private readonly terminalAt = new Map<string, number>()
  private readonly residualByRoot = new Map<string, string[]>()
  private readonly options: RunnerClientOptions
  private closed = false
  private disposing: Promise<{ residual: string[] }> | undefined

  constructor(options: RunnerClientOptions = {}) {
    for (const value of [options.startupTimeoutMs, options.requestTimeoutMs, options.shutdownTimeoutMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)) throw new Error('Invalid Runner lifecycle timeout')
    this.options = options
  }

  onMessage(listener: RunnerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(
    previewId: string, plan: PreviewPlan, workspaceRoot: string,
    options: { ownerSessionId: string; configFile?: string; approvalFingerprint?: string; signal?: AbortSignal },
  ): Promise<RunnerReply> {
    if (this.closed) throw new Error('Runner client is disposed')
    if (!options.ownerSessionId) throw new Error('Validated caller session ID is required')
    options.signal?.throwIfAborted()
    const prepared = structuredClone(plan)
    const root = await realpath(workspaceRoot)
    const worker = await this.ensure(root)
    const previous = this.bindings.get(previewId)
    if (previous && (previous.owner !== options.ownerSessionId || previous.root !== root)) return { status: 'not_found' }
    this.bindings.set(previewId, { root, owner: options.ownerSessionId, plan: prepared })
    try {
      const request: RunnerRequest = {
        type: 'start', previewId, plan: prepared, workspaceRoot: root,
        ownerSessionId: options.ownerSessionId,
        ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
        ...(options.approvalFingerprint === undefined
          ? {}
          : { approval: { fingerprint: options.approvalFingerprint } }),
      }
      const ack = await worker.connection.request(request, options.signal ? { signal: options.signal } : {})
      if (!ack.result) throw new Error('Runner start result is missing')
      if (ack.result.previewId && ack.result.previewId !== previewId) {
        this.bindings.delete(previewId)
        this.bindings.set(ack.result.previewId, { root, owner: options.ownerSessionId, plan: prepared })
      }
      return ack.result
    } catch (error) {
      if (previous) this.bindings.set(previewId, previous)
      else if (error instanceof RunnerConnectionError && error.reason === 'rejected') this.bindings.delete(previewId)
      // 请求超时/取消并不停止已经受理的启动，保留调用者绑定以便 status/stop 找回。
      throw error
    }
  }

  async status(workspaceRoot: string, ownerSessionId: string, previewId?: string): Promise<RunnerReply> {
    const root = await canonicalPath(workspaceRoot)
    const binding = previewId ? this.bindings.get(previewId) : undefined
    if (previewId && (!binding || binding.owner !== ownerSessionId || binding.root !== root)) return { status: 'not_found' }
    const pending = this.workers.get(root)
    if (!pending) {
      const previews = this.cached(root, ownerSessionId, previewId)
      return { status: previewId && !previews.length ? 'not_found' : 'ok', previews }
    }
    const worker = await pending
    const result = await worker.connection.request({ type: 'status', ownerSessionId, ...(previewId === undefined ? {} : { previewId }) })
    if (!result.result) throw new Error('Runner status result is missing')
    return result.result
  }

  /** 仅投影已受理预览的计划与 Runner 事实；查询不生成会话或修复资源。 */
  async inspect(workspaceRoot: string, ownerSessionId: string, previewId?: string): Promise<{ status: RunnerReply['status']; previews: PreviewInspection[] }> {
    const root = await canonicalPath(workspaceRoot)
    const result = await this.status(root, ownerSessionId, previewId)
    const previews = (result.previews ?? []).map(snapshot => {
      const binding = this.bindings.get(snapshot.previewId)
      if (!binding || binding.root !== root || binding.owner !== ownerSessionId) throw new RunnerClientError(DiagnosticCode.ownershipUnverified, 'Runner snapshot has no matching caller binding')
      const diagnostics = this.diagnostics.get(snapshot.previewId)
      return structuredClone({ plan: binding.plan, snapshot, diagnostics: diagnostics?.items ?? [], diagnosticsTruncated: diagnostics?.dropped ?? 0 })
    })
    return { status: result.status, previews }
  }

  /** 仅对调用者已绑定预览下发 refresh；Runner 侧仍做 owner 与状态门禁（R2-P0-2、R3-2）。 */
  async refresh(previewId: string, ownerSessionId: string, scenario?: string): Promise<RunnerReply> {
    const binding = this.bindings.get(previewId)
    if (!binding || binding.owner !== ownerSessionId) return { status: 'not_found' }
    const pending = this.workers.get(binding.root)
    if (!pending) return { status: 'not_found' }
    const worker = await pending
    const result = await worker.connection.request({ type: 'refresh', previewId, ownerSessionId,
      ...(scenario === undefined ? {} : { scenario }) })
    if (!result.result) throw new Error('Runner refresh result is missing')
    return result.result
  }

  /**
   * R3-5：turn/end 后通知 Runner 本预览应用内输入已变化；单向消息（无 ack），
   * owner/状态仍由 Runner 侧门禁，未绑定/进程缺席如实不送达。
   */
  inputsChanged(previewId: string, ownerSessionId: string, paths: readonly string[]): void {
    const binding = this.bindings.get(previewId)
    if (!binding || binding.owner !== ownerSessionId || !paths.length) return
    const pending = this.workers.get(binding.root)
    if (!pending) return
    void pending.then(worker => worker.connection.notify(
      { type: 'inputs-changed', previewId, ownerSessionId, paths: [...paths] })).catch(() => undefined)
  }

  async stop(previewId: string, ownerSessionId: string): Promise<RunnerReply> {
    const binding = this.bindings.get(previewId)
    if (!binding || binding.owner !== ownerSessionId) return { status: 'not_found' }
    const pending = this.workers.get(binding.root)
    if (!pending) {
      const report = await createFileLedger(this.paths(binding.root).services).reconcile()
      this.rememberResidual(binding.root, blocked(report))
      const residual = report.residual.filter(value => value.entry.previewId === previewId).map(value => 'Persisted resource ' + value.entry.id)
      residual.push(...report.corrupt.map(value => 'Unreadable persisted resource ' + value.name))
      const snapshot = this.snapshots.get(previewId)
      if (snapshot) this.emit({ type: 'state', ...snapshot, state: residual.length ? 'cleanup_failed' : 'stopped' })
      return { status: residual.length ? 'error' : 'ok', residual, previews: this.cached(binding.root, ownerSessionId, previewId) }
    }
    const worker = await pending
    const result = await worker.connection.request({ type: 'stop', previewId, ownerSessionId })
    if (!result.result) throw new Error('Runner stop result is missing')
    return result.result
  }

  dispose(): Promise<{ residual: string[] }> {
    if (this.disposing) return this.disposing
    this.closed = true
    this.disposing = (async () => {
      await Promise.allSettled([...this.workers.values()])
      const residual = [...new Set([...(await Promise.all([...this.live].map(worker => this.closeWorker(worker)))).flat(), ...[...this.residualByRoot.values()].flat()])]
      this.listeners.clear()
      this.secrets.clear()
      return { residual }
    })()
    return this.disposing
  }

  private async ensure(root: string): Promise<Worker> {
    if (this.closed) throw new Error('Runner client is disposed')
    let pending = this.workers.get(root)
    if (!pending) {
      pending = this.launch(root)
      this.workers.set(root, pending)
      void pending.catch(() => { if (![...this.live].some(worker => worker.root === root)) this.workers.delete(root) })
    }
    return pending
  }

  private paths(root: string) {
    if (!this.options.dataDir || !isAbsolute(this.options.dataDir)) {
      throw new RunnerClientError(DiagnosticCode.configInvalid,
        'The plugin dataDir is not configured as an absolute path; no Runner was started', undefined,
        MISSING_DATA_DIR_HINT)
    }
    return runnerPaths(this.options.dataDir, root)
  }

  /** 恢复入口（方案 §9.2）：列出并回收持久化资源；无法核对的记录归档，工作区不得被永久锁死。 */
  async recover(workspaceRoot: string): Promise<{ reclaimed: string[]; residual: string[]; archived: string[] }> {
    const root = await canonicalPath(workspaceRoot)
    const paths = this.paths(root)
    const reclaimed: string[] = []
    const residual: string[] = []
    const archived: string[] = []
    for (const scope of [paths.control, paths.services]) {
      const report = await createFileLedger(scope).reconcile({ archiveResidual: true })
      reclaimed.push(...report.reclaimed.map(value => scope + ': ' + value.entry.resource.kind + ' ' + value.entry.id + ' (' + value.action + ')'))
      residual.push(...report.residual.map(value => scope + ': ' + value.entry.resource.kind + ' ' + value.entry.id + ' (' + value.reason + ')'))
      residual.push(...report.corrupt.map(value => scope + ': unreadable record ' + value.name + ' (' + value.reason + ')'))
      archived.push(...report.archived)
    }
    // 已归档的记录不再阻止分配；残留清单只返回给调用方，不重新记为本工作区占用。
    this.rememberResidual(root, [])
    return { reclaimed, residual, archived }
  }

  private async launch(root: string): Promise<Worker> {
    const paths = this.paths(root)
    const ledger = createFileLedger(paths.control)
    const report = await ledger.reconcile()
    if (report.residual.length || report.corrupt.length) throw new RunnerClientError(DiagnosticCode.cleanupFailed, 'A prior Runner still requires ownership verification')
    await readProcessStartTime(process.pid)
    if (this.closed) throw new Error('Runner client is disposed')
    const { executable } = await resolveNodeRuntime(this.options.nodeExecutable)
    if (this.closed) throw new Error('Runner client is disposed')
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../runner/main.ts' : '../runner/main.js', import.meta.url))
    // windowsHide：Windows 上 detached 的 Runner 默认会弹出一个控制台窗口。
    const child = fork(entry, [root, this.options.dataDir!], {
      execPath: executable, cwd: root, env: platformBaseEnv(), execArgv: [], detached: true, windowsHide: true,
      serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const exited = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.once('error', () => { if (!child.pid) resolve() })
    })
    const connection = new RunnerConnection(child, { ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }), ...(this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }) })
    const worker: Worker = { root, child, connection, exited, checked: Promise.resolve(), closing: false, dead: false }
    this.live.add(worker)
    connection.onMessage(message => this.emit(message))
    let registration: Promise<void>
    registration = (async () => {
      if (!child.pid) throw new Error('Runner PID unavailable')
      const startTime = await readProcessStartTime(child.pid)
      if (!startTime) throw new Error('Runner exited before resource registration')
      worker.identity = { pid: child.pid, startTime }
      worker.entry = await ledger.record({ previewId: '__runner__', ownerSessionId: '__host__', workspaceRoot: root, resource: { kind: 'process', pid: child.pid, startTime, command: executable } })
    })()
    worker.checked = exited.then(async () => {
      worker.dead = true
      await registration.catch(() => {}) // 启动调用方仍收到原始拒绝；此处只等账本写入落定。
      try {
        if (worker.entry) await ledger.release(worker.entry.id)
        const report = await createFileLedger(paths.services).reconcile()
        this.rememberResidual(root, blocked(report))
        if (!worker.closing) for (const [previewId, binding] of this.bindings) {
          const snapshot = this.snapshots.get(previewId)
          if (binding.root !== root || !snapshot || ['failed', 'stopped'].includes(snapshot.state)) continue
          const remaining = report.residual.some(value => value.entry.previewId === previewId)
          this.emit({ type: 'diagnostic', previewId, diagnostic: { code: remaining ? DiagnosticCode.cleanupFailed : DiagnosticCode.runtimeError, phase: 'ledger', message: 'Runner exited; persisted resources were checked' } })
          this.emit({ type: 'state', ...snapshot, state: remaining ? 'cleanup_failed' : snapshot.state === 'stopping' || snapshot.state === 'cleanup_failed' ? 'stopped' : 'failed' })
        }
      } catch (error) {
        this.rememberResidual(root, ['Unable to verify Runner exit resources'])
        for (const [previewId, binding] of this.bindings) if (binding.root === root) {
          const snapshot = this.snapshots.get(previewId)
          if (snapshot && snapshot.state !== 'stopped') this.emit({ type: 'state', ...snapshot, state: 'cleanup_failed' })
        }
        worker.connection.dispose()
        throw new RunnerClientError(DiagnosticCode.cleanupFailed, 'Unable to verify Runner exit resources', error)
      } finally {
        this.live.delete(worker)
        this.workers.delete(root)
        connection.dispose()
      }
    })
    void worker.checked.catch(() => {}) // status/dispose 与启动失败路径等待 checked 并暴露核对错误。
    try {
      await bounded(Promise.all([registration, connection.ready()]), this.options.startupTimeoutMs ?? 10000)
      if (this.closed) throw new Error('Runner client is disposed')
      return worker
    } catch (error) {
      worker.closing = true
      if (child.connected) child.disconnect()
      try { await bounded(worker.checked, this.options.shutdownTimeoutMs ?? 7000) }
      catch { throw new RunnerClientError(DiagnosticCode.cleanupFailed, 'Failed Runner startup has unverified residual resources', error) }
      throw error
    }
  }

  private async closeWorker(worker: Worker): Promise<string[]> {
    worker.closing = true
    const timeout = this.options.shutdownTimeoutMs ?? 7000
    try { if (!worker.dead) await worker.connection.request({ type: 'shutdown' }, { timeoutMs: timeout }) }
    catch { if (worker.child.connected) worker.child.disconnect() }
    try { await bounded(worker.checked, timeout) }
    catch (error) {
      const identity = worker.identity
      if (!worker.dead && worker.entry && identity && await readProcessStartTime(identity.pid) === identity.startTime) {
        process.kill(identity.pid, 'SIGKILL')
        try { await bounded(worker.checked, timeout) } catch { return ['Runner exit cleanup remains unverified'] }
      } else return ['Runner ownership or exit cleanup remains unverified']
    }
    const report = await createFileLedger(this.paths(worker.root).services).reconcile()
    const residual = blocked(report)
    this.rememberResidual(worker.root, residual)
    return residual
  }

  private rememberResidual(root: string, residual: string[]): void {
    if (residual.length) this.residualByRoot.set(root, residual)
    else this.residualByRoot.delete(root)
  }

  /**
   * 本进程已收到的回传通道 nonce 并集；只用于日志/意外诊断脱敏。
   * 给出 workspaceRoot 时按绑定归属过滤；无法归属（或绑定已回收）的密钥仍并入——宁可多删不漏。
   */
  channelSecrets(workspaceRoot?: string): string[] {
    const union = new Set<string>()
    for (const [previewId, values] of this.secrets) {
      const root = this.bindings.get(previewId)?.root
      if (workspaceRoot !== undefined && root !== undefined && root !== workspaceRoot) continue
      for (const value of values) union.add(value)
    }
    return [...union]
  }

  private cached(root: string, owner: string, previewId?: string): RunnerSnapshot[] {
    return [...this.snapshots.values()].filter(value => {
      const binding = this.bindings.get(value.previewId)
      return binding?.root === root && binding.owner === owner && (!previewId || value.previewId === previewId)
    }).map(value => structuredClone(value))
  }
  private emit(message: RunnerToHost): void {
    if (message.type === 'state') {
      const { type: _type, ...snapshot } = message
      this.snapshots.set(message.previewId, structuredClone(snapshot))
      if (snapshot.state === 'stopped' || snapshot.state === 'failed') {
        if (!this.terminalAt.has(message.previewId)) this.terminalAt.set(message.previewId, Date.now())
        this.evictSnapshots()
      }
    }
    if (message.type === 'channel-secrets') {
      // 只入脱敏密钥集，不向监听器转发——nonce 不进入任何 Host 输出面。
      this.secrets.set(message.previewId, new Set(message.secrets))
      return
    }
    if (message.type === 'diagnostic') {
      const history = this.diagnostics.get(message.previewId) ?? { items: [], dropped: 0 }
      history.items.push(structuredClone(message.diagnostic))
      if (history.items.length > MAX_RECENT_DIAGNOSTICS) {
        history.items.shift()
        history.dropped++
      }
      this.diagnostics.set(message.previewId, history)
    }
    for (const listener of this.listeners) listener(message)
  }

  /** P2-9：每个 owner 只保留最近若干终态预览；回收连同 bindings/diagnostics 删除，查询即 not_found。 */
  private evictSnapshots(): void {
    const previews: RetainedPreview[] = []
    for (const snapshot of this.snapshots.values()) {
      const binding = this.bindings.get(snapshot.previewId)
      if (!binding) continue
      const terminalAt = this.terminalAt.get(snapshot.previewId)
      previews.push({
        previewId: snapshot.previewId, owner: binding.owner, state: snapshot.state,
        ...(terminalAt === undefined ? {} : { terminalAt }),
      })
    }
    for (const previewId of previewsToEvict(previews)) {
      this.snapshots.delete(previewId)
      this.diagnostics.delete(previewId)
      this.bindings.delete(previewId)
      this.secrets.delete(previewId)
      this.terminalAt.delete(previewId)
    }
  }
}

/** 对账后仍阻止分配的持久化记录：无法核对的残留与无法解析的记录。 */
function blocked(report: { residual: Array<{ entry: { id: string } }>; corrupt: Array<{ name: string }> }): string[] {
  return [
    ...report.residual.map(value => 'Persisted resource ' + value.entry.id),
    ...report.corrupt.map(value => 'Unreadable persisted resource ' + value.name),
  ]
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Runner exit deadline exceeded')), ms) })]) }
  finally { clearTimeout(timer) }
}
