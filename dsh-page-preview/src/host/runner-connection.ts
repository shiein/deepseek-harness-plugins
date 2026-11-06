/**
 * 单个已派生 Runner 的 IPC 通信（方案 §6.5、§9.2）。
 * 握手核对 fork 的 PID；请求按 requestId 关联，超时/取消只停止等待，不冒充停止进程。
 * 本模块不启动进程或执行项目代码；进程、账本与会话生命周期由 RunnerClient 接入。
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Diagnostic } from '../shared/contracts.ts'
import type { HostToRunner, RunnerAck, RunnerRequest, RunnerToHost } from '../shared/ipc.ts'
import { parseRunnerMessage } from '../shared/ipc-validation.ts'

type FailureReason = 'startup-timeout' | 'request-timeout' | 'protocol' | 'disconnected' | 'exited' | 'send' | 'disposed' | 'rejected'

export class RunnerConnectionError extends Error {
  readonly reason: FailureReason
  readonly diagnostics: Diagnostic[]
  readonly result: RunnerAck['result']

  constructor(reason: FailureReason, message: string, diagnostics: Diagnostic[] = [], cause?: unknown, result?: RunnerAck['result']) {
    super(message, { cause })
    this.name = 'RunnerConnectionError'
    this.reason = reason
    this.diagnostics = diagnostics
    this.result = result
  }
}

interface Pending {
  resolve(ack: RunnerAck): void
  reject(error: unknown): void
  cleanup(): void
}

export class RunnerConnection {
  private readonly child: ChildProcess
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(message: RunnerToHost) => void>()
  private readonly failureListeners = new Set<(error: RunnerConnectionError) => void>()
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: unknown) => void
  private readonly startupTimer: ReturnType<typeof setTimeout>
  private readyReceived = false
  private failure: RunnerConnectionError | undefined

  constructor(child: ChildProcess, options: { startupTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
    this.child = child
    this.requestTimeoutMs = timeout(options.requestTimeoutMs ?? 10000)
    const startupTimeoutMs = timeout(options.startupTimeoutMs ?? 10000)
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // 退出可以早于调用者开始等待 ready；错误仍由 ready/request 和 onFailure 明确暴露。
    void this.readyPromise.catch(() => {})
    this.startupTimer = setTimeout(() => this.fail(new RunnerConnectionError('startup-timeout', 'Runner handshake timed out')), startupTimeoutMs)
    child.on('message', this.receive)
    child.on('error', this.childError)
    child.on('disconnect', this.disconnected)
    child.on('exit', this.exited)
    // fork 启动错误异步到达；保留监听到实际退出/启动失败。Node 24 显式 disconnect 后不一定发 close。
    child.once('exit', this.finished)
    child.once('close', this.finished)
    if (!child.connected) this.disconnected()
  }

  ready(): Promise<void> { return this.readyPromise }

  onMessage(listener: (message: RunnerToHost) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: RunnerConnectionError) => void): () => void {
    if (this.failure) { listener(this.failure); return () => {} }
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  async request(command: RunnerRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RunnerAck> {
    const timeoutMs = timeout(options.timeoutMs ?? this.requestTimeoutMs)
    await cancellable(this.readyPromise, options.signal)
    options.signal?.throwIfAborted()
    if (this.failure) throw this.failure
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => this.reject(requestId, options.signal?.reason)
      const timer = setTimeout(() => this.reject(requestId, new RunnerConnectionError('request-timeout', 'Runner request timed out')), timeoutMs)
      this.pending.set(requestId, { resolve, reject, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) } })
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.child.send({ ...command, requestId }, error => { if (error) this.reject(requestId, new RunnerConnectionError('send', 'Unable to send Runner request', [], error)) })
      } catch (error) { this.reject(requestId, new RunnerConnectionError('send', 'Unable to send Runner request', [], error)) }
    })
  }

  /**
   * 单向通知（inputs-changed：无 requestId/ack，R3-5）。发送失败不升级为连接故障——
   * 通知丢失等价于本次不刷新，Runner 掉线由 checked/exit 通道如实上报。
   */
  notify(command: Extract<HostToRunner, { type: 'inputs-changed' }>): void {
    if (this.failure || !this.child.connected) return
    try { this.child.send(command, () => {}) } catch { /* 通知不追踪送达 */ }
  }

  /** 只释放 IPC 监听与等待者；调用方仍须负责 shutdown、进程退出和账本对账。 */
  dispose(): void {
    this.fail(new RunnerConnectionError('disposed', 'Runner connection disposed'), false)
    this.listeners.clear()
    this.failureListeners.clear()
  }

  private readonly receive = (raw: unknown) => {
    let message: RunnerToHost
    try { message = parseRunnerMessage(raw) }
    catch (error) { this.fail(new RunnerConnectionError('protocol', 'Runner sent an invalid IPC message', [], error)); return }
    if (message.type === 'ready-for-commands') {
      if (this.readyReceived || message.pid !== this.child.pid) { this.fail(new RunnerConnectionError('protocol', 'Runner handshake identity did not match')); return }
      this.readyReceived = true
      clearTimeout(this.startupTimer)
      this.resolveReady()
    } else if (!this.readyReceived) {
      this.fail(new RunnerConnectionError('protocol', 'Runner sent a message before its handshake'))
      return
    }
    if (message.type === 'ack') {
      const pending = this.pending.get(message.requestId)
      if (pending) {
        this.pending.delete(message.requestId)
        pending.cleanup()
        if (message.ok) pending.resolve(message)
        else pending.reject(new RunnerConnectionError('rejected', 'Runner rejected the request', message.diagnostics, undefined, message.result))
      }
    }
    for (const listener of this.listeners) listener(message)
  }

  private readonly childError = (error: Error) => {
    this.fail(new RunnerConnectionError('send', 'Runner process reported an error', [], error))
    if (!this.child.pid) this.finished()
  }
  private readonly disconnected = () => this.fail(new RunnerConnectionError('disconnected', 'Runner IPC disconnected'))
  private readonly exited = (code: number | null, signal: string | null) => this.fail(new RunnerConnectionError('exited', `Runner exited (code=${code}, signal=${signal})`))
  private readonly finished = () => {
    this.child.off('error', this.childError)
    this.child.off('exit', this.finished)
    this.child.off('close', this.finished)
  }

  private reject(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    pending.cleanup()
    pending.reject(error)
  }

  private fail(error: RunnerConnectionError, notify = true): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.startupTimer)
    this.rejectReady(error)
    for (const id of this.pending.keys()) this.reject(id, error)
    this.child.off('message', this.receive)
    this.child.off('disconnect', this.disconnected)
    this.child.off('exit', this.exited)
    if (notify) for (const listener of this.failureListeners) listener(error)
  }
}

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Invalid Runner IPC timeout')
  return value
}

function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
