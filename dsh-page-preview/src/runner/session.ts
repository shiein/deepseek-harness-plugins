/**
 * Runner 内单个预览会话的运行时状态（方案 §9.2）。
 * 状态迁移必须经过 shared/state-machine；freshness 独立于状态。
 */

import { join, relative, sep } from 'node:path'
import type { Diagnostic, Freshness, PageTextObservation, PreviewPlan, ReadinessEvidence, SessionState } from '../shared/contracts.ts'
import { PAGE_TEXT_LIMIT } from '../shared/contracts.ts'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'
import { collectEnvPairs, createRedactor, envSecrets } from '../shared/redact.ts'
import type { Redactor } from '../shared/redact.ts'
import type { RunnerToHost } from '../shared/ipc.ts'
import { assertTransition } from '../shared/state-machine.ts'
import type { Adapter, RunEvent, RunningHandle, StartContext, UpdateOutcome } from '../adapters/types.ts'
import { readProcessStartTime } from './ledger.ts'
import { ManagedProcessError } from './process-tree.ts'
import { UnmatchedRequestLog } from './unmatched-log.ts'
import { prepareScenarioUpdate } from './scenario-reload.ts'
import { isWithinRoot } from '../shared/config/paths.ts'

const unverified = { status: 'unverified' } as const
export type SessionContext = Omit<StartContext, 'previewId' | 'plan' | 'signal' | 'deadline' | 'emit'>
type StopOutcome = { residual: string[] }

export { RunnerSessionError } from '../shared/errors.ts'

/**
 * 会话上下文之外的场景更新凭据（R3-2）：Runner 在 prepareScenarioUpdate 用它们重读配置来源
 * 并核对执行指纹；不含敏感值（configFile 是路径，approvalFingerprint 是哈希）。
 */
export interface ScenarioReloadBinding {
  dataDir: string
  configFile?: string
  approvalFingerprint?: string
  /** 启动时实际加载的项目 handler 模块声明路径；场景更新不允许改变这个绑定。 */
  initialHandlers?: string
}

export class RunnerSession {
  state: SessionState = 'preparing'
  freshness: Freshness = 'unverified'
  /** 最近一次目标文档的文本观察；已在回传通道边界脱敏。 */
  pageText: PageTextObservation | undefined
  readiness: ReadinessEvidence = {
    serviceReachable: { ...unverified },
    documentLoaded: { ...unverified },
    targetMounted: { ...unverified },
  }
  readonly diagnostics: Diagnostic[] = []
  residual: string[] = []
  /** 保留内部根因供 Runner 调试；不放进 IPC/模型可见诊断。 */
  lastCleanupError: unknown
  private handle: RunningHandle | undefined
  readonly previewId: string
  readonly plan: PreviewPlan
  /** updating 之前的可展示状态，用于编译失败后恢复。 */
  private stateBeforeUpdate: SessionState | undefined
  private readonly listeners = new Set<(message: RunnerToHost) => void>()
  private readonly cleanupTimeoutMs: number
  private readonly control = new AbortController()
  private context: SessionContext | undefined
  private startup: Promise<void> | undefined
  private startupSettled = false
  private startupError: unknown
  private cleanupTask: Promise<StopOutcome> | undefined
  private handleCleanup: Promise<StopOutcome> | undefined
  private updateTask: Promise<UpdateOutcome> | undefined
  /** updating 期间到达的 inputs-changed 路径（R3-5）；更新落定后统一再判。 */
  private readonly pendingInputs = new Set<string>()
  private flushingInputs = false
  private explicitStop = false
  private failure: RunnerSessionError | undefined
  private stageTimer: ReturnType<typeof setTimeout> | undefined
  private readonly service = deferred()
  private readonly target = deferred()
  /** start 时由 Controller 注入；场景更新用它重读配置并核对批准。 */
  reloadBinding: ScenarioReloadBinding | undefined
  /** §13 第 8 条：Runner 侧统一脱敏点；secrets 在 start 时按 runtime.env 与项目 env 文件装配，启动成功后并入回传通道 nonce。 */
  private redactor: Redactor = createRedactor()
  /** redactor 对应的密钥清单；调试日志等会话外写点经 RunnerWorkspace.redactionSecrets 复用同一来源。 */
  private secrets: readonly string[] = []
  /** 本预览的未命中业务请求汇总（R3-1）；场景切换/重载（R3-2）清空。 */
  private readonly unmatchedLog = new UnmatchedRequestLog()

  constructor(previewId: string, plan: PreviewPlan, options: { cleanupTimeoutMs?: number } = {}) {
    this.previewId = previewId
    this.plan = structuredClone(plan)
    this.cleanupTimeoutMs = validTimeout(options.cleanupTimeoutMs ?? 5000)
  }

  onMessage(listener: (message: RunnerToHost) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 本预览的脱敏密钥（env 值 + 回传通道 nonce）；与 record() 的诊断脱敏同源。 */
  get redactionSecrets(): readonly string[] {
    return this.secrets
  }

  snapshot(): Extract<RunnerToHost, { type: 'state' }> {
    const unmatched = this.unmatchedLog.snapshot()
    return {
      type: 'state', previewId: this.previewId, state: this.state, freshness: this.freshness,
      readiness: structuredClone(this.readiness),
      ...(this.pageText ? { pageText: structuredClone(this.pageText) } : {}),
      ...(this.handle ? { url: this.handle.url } : {}),
      ...(this.plan.scenario === undefined ? {} : { scenario: this.plan.scenario }),
      ...((unmatched.entries.length || unmatched.dropped) ? { unmatched } : {}),
    }
  }

  transition(to: SessionState) {
    assertTransition(this.state, to)
    if (to === 'updating') this.stateBeforeUpdate = this.state
    this.state = to
    this.publish(this.snapshot())
  }

  /** 仅在 Runner 调用；调用方须先完成计划与执行授权。返回不把未知目标当作 ready。 */
  async start(adapter: Pick<Adapter, 'id' | 'version' | 'strategies' | 'start'>, context: SessionContext, signal?: AbortSignal): Promise<void> {
    if (this.state !== 'preparing') throw new Error('Preview session has already started or stopped')
    const { serviceMs, targetMs } = this.validateStart(adapter, context)
    this.context = context
    this.secrets = envSecrets(context.config.project.runtime.env, [])
    this.redactor = createRedactor({ secrets: this.secrets })
    const abort = () => this.control.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    this.transition('starting')
    const deadline = Date.now() + serviceMs
    this.stageTimer = setTimeout(() => this.control.abort(sessionError(DiagnosticCode.startTimeout, 'start', 'Service readiness deadline exceeded')), serviceMs)
    this.startup = (async () => {
      if (signal?.aborted) abort()
      this.control.signal.throwIfAborted()
      if ((await context.ledger.listByPreview(this.previewId)).length) throw sessionError(DiagnosticCode.cleanupFailed, 'ledger', 'Preview ID still has persisted resources')
      this.control.signal.throwIfAborted()
      this.secrets = envSecrets(context.config.project.runtime.env, await collectEnvPairs(context.appRoot))
      this.redactor = createRedactor({ secrets: this.secrets })
      this.handle = await adapter.start({ ...context, previewId: this.previewId, plan: this.plan, signal: this.control.signal, deadline, emit: event => this.accept(event) })
      // 回传通道 nonce 只在启动成功后可知；并入同一脱敏来源，诊断与日志都不再以明文记录它。
      // 同时上报 Host（channel-secrets）：Host 只把它装进脱敏密钥集，不进快照/工具输出。
      if (this.handle.channelSecrets?.length) {
        this.secrets = [...new Set([...this.secrets, ...this.handle.channelSecrets])]
        this.redactor = createRedactor({ secrets: this.secrets })
        this.publish({ type: 'channel-secrets', previewId: this.previewId,
          secrets: [...this.handle.channelSecrets] })
      }
      const url = new URL(this.handle.url)
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || (this.plan.process.kind === 'attach' && url.origin !== new URL(this.plan.process.origin).origin)) throw sessionError(DiagnosticCode.ownershipUnverified, 'start', 'Adapter returned an unexpected preview origin')
      this.advance()
    })().catch(error => { this.startupError = error; throw error }).finally(() => { this.startupSettled = true })
    try {
      await cancellable(Promise.all([this.startup, this.service.promise]), this.control.signal)
      this.clearTimer()
      if (this.plan.readiness.assertions?.length) {
        this.stageTimer = setTimeout(() => this.control.abort(sessionError(DiagnosticCode.targetNotReady, 'ready', 'Target readiness deadline exceeded')), targetMs)
        await cancellable(this.target.promise, this.control.signal)
      }
    } catch (error) {
      if (!this.explicitStop) this.markFailure(error instanceof RunnerSessionError ? error : sessionError(DiagnosticCode.runtimeError, 'start', 'Adapter startup failed or was cancelled', error))
      this.control.abort(error)
      await this.cleanup()
      throw error
    } finally {
      this.clearTimer()
      signal?.removeEventListener('abort', abort)
    }
  }

  /** 切换目标前复用同一份纯校验，不能先停旧页面再发现新计划本身无效。 */
  validateStart(adapter: Pick<Adapter, 'id' | 'version' | 'strategies'>, context: SessionContext): { serviceMs: number; targetMs: number } {
    if (!this.previewId || !context.ownerSessionId || context.config.project.id !== this.plan.projectId || adapter.id !== this.plan.adapter.id || adapter.version !== this.plan.adapter.version || !adapter.strategies.includes(this.plan.strategy) || this.plan.missing.length) {
      throw sessionError(DiagnosticCode.configInvalid, 'plan', 'Session context does not match an executable preview plan')
    }
    return { serviceMs: validTimeout(this.plan.readiness.serviceDeadlineMs), targetMs: validTimeout(this.plan.readiness.targetDeadlineMs) }
  }

  /** 重复/并发停止复用同一次清理；attach 句柄负责脱离，不由会话层终止任何服务。 */
  stop(): Promise<StopOutcome> {
    if (this.state === 'stopped') return Promise.resolve({ residual: [] })
    this.explicitStop = true
    this.control.abort(new Error('Preview stop requested'))
    this.clearTimer()
    if (this.state !== 'stopping') this.transition('stopping')
    return this.cleanup()
  }

  refresh(): Promise<UpdateOutcome> {
    const refresh = this.handle?.refresh
    // §0.3：unknown 不等于不能执行——机制存在（handle.refresh）且未声明 unsupported 时允许；
    // 结果如实以 unverified/stale 上报，不据此提升能力等级。
    if (!refresh || this.plan.capabilities.refresh.status === 'unsupported') {
      return Promise.reject(sessionError(
        DiagnosticCode.unsupportedCapability, 'update', 'This preview does not support refresh'))
    }
    return this.runUpdate(async () => refresh.call(this.handle!))
  }

  /**
   * 场景重新加载/切换（§7.4、R3-2）：name 缺省时重新读取当前场景数据。
   * 与 refresh 共用 updateTask 互斥；成功后更新 plan.scenario/fingerprints.scenario、
   * 清空 unmatchedLog，freshness 回到 unverified（不清理用户 Cookie/Storage）。
   * 预检（重读配置/执行指纹/场景存在性/handler 绑定）在进 updating 之前完成：
   * config_invalid/config_changed_needs_approval 只拒绝本次更新，当前预览不受影响。
   */
  switchScenario(name?: string): Promise<UpdateOutcome> {
    const switcher = this.handle?.switchScenario
    if (!switcher) {
      return Promise.reject(sessionError(
        DiagnosticCode.unsupportedCapability, 'scenario', 'This preview does not support scenario updates'))
    }
    const binding = this.reloadBinding
    if (!binding || !this.context) {
      return Promise.reject(sessionError(
        DiagnosticCode.runtimeError, 'scenario', 'Preview scenario binding is missing'))
    }
    const prepared = prepareScenarioUpdate({
      workspaceRoot: this.context.workspaceRoot, dataDir: binding.dataDir,
      ...(binding.configFile === undefined ? {} : { configFile: binding.configFile }),
      plan: this.plan, ...(name === undefined ? {} : { scenario: name }),
      ...(binding.approvalFingerprint === undefined ? {} : { approval: { fingerprint: binding.approvalFingerprint } }),
      ...(binding.initialHandlers === undefined ? {} : { initialHandlers: binding.initialHandlers }),
    })
    return prepared.then(update => this.runUpdate(async () => {
      const outcome = await switcher.call(this.handle!, update)
      if (outcome.kind === 'updated' && !this.control.signal.aborted) {
        this.plan.scenario = update.name
        this.plan.fingerprints.scenario = update.fingerprint
        this.unmatchedLog.clear()
      }
      return outcome
    }))
  }

  /**
   * R3-5（§9.1）：turn/end 后 Host 通知本预览工作区输入变化（工作区相对路径）。
   * 分级：声明的执行输入（setup/handlers、.env*、配置文件）无法就地生效 → 如实 stale +
   * restart/approval 诊断，不重载（重载拿不到新批准）；当前场景 bodyFile → 就地场景重载
   * （bodyFile 惰性读取，坏文件只影响对应请求）；其余应用内路径 → 适配器 inputsChanged 裁量。
   * updating 中到达的先排队，更新落定后统一再判；任何失败都以诊断呈现，不静默吞掉。
   */
  async inputsChanged(paths: string[]): Promise<void> {
    if (this.state === 'updating') {
      for (const path of paths) this.pendingInputs.add(path)
      return
    }
    const context = this.context
    const handle = this.handle
    if (!context || !handle || !['reachable', 'ready', 'degraded'].includes(this.state)) return
    const project = context.config.project
    // detected 来源无配置文件；explicit/repo/local 的 file 是工作区外也可的绝对路径。
    const sourceFile = 'file' in context.config.source ? context.config.source.file : undefined
    const configRel = sourceFile !== undefined && isWithinRoot(context.workspaceRoot, sourceFile)
      ? relative(context.workspaceRoot, sourceFile).split(sep).join('/') : undefined
    const configHit = configRel !== undefined && paths.includes(configRel)
    const inApp: string[] = []
    for (const path of paths) {
      const absolute = join(context.workspaceRoot, path.split('/').join(sep))
      if (isWithinRoot(context.appRoot, absolute)) inApp.push(relative(context.appRoot, absolute).split(sep).join('/'))
    }
    if (!inApp.length && !configHit) return
    // 执行项文件集合（setup/场景 handlers）：与批准指纹同一口径。
    const execFiles = new Set<string>()
    if (project.runtime.setup) execFiles.add(project.runtime.setup)
    for (const scenario of Object.values(project.scenarios ?? {}))
      if (scenario.handlers) execFiles.add(scenario.handlers)
    const scene = this.plan.scenario === undefined ? undefined : project.scenarios?.[this.plan.scenario]
    const fixtureFiles = new Set((scene?.http ?? []).flatMap(fixture =>
      fixture.response.bodyFile === undefined ? [] : [fixture.response.bodyFile]))
    const approval: string[] = []
    const restart: string[] = configRel !== undefined && configHit ? [configRel] : []
    const fixtureHit: string[] = []
    const rest: string[] = []
    // 配置文件在应用根内时已进 restart，不再交给适配器二次裁量。
    const configAppRel = configHit && sourceFile !== undefined && isWithinRoot(context.appRoot, sourceFile)
      ? relative(context.appRoot, sourceFile).split(sep).join('/') : undefined
    for (const path of inApp) {
      if (path === configAppRel) continue
      if (execFiles.has(path)) { approval.push(path); continue }
      if (/^\.env(?:\.|$)/.test(path.split('/').pop() ?? path)) { restart.push(path); continue }
      if (fixtureFiles.has(path)) { fixtureHit.push(path); continue }
      rest.push(path)
    }
    if (approval.length || restart.length) {
      this.freshness = 'stale'
      this.publish(this.snapshot())
      if (approval.length) this.record({ code: DiagnosticCode.configChangedNeedsApproval, phase: 'update',
        message: 'Preview execution inputs changed (' + approval.join(', ')
          + '); the running preview keeps its approved state',
        hint: 'Stop this preview and call page_preview_open to apply them; the new plan requires fresh approval' })
      if (restart.length) this.record({ code: DiagnosticCode.previewNeedsRestart, phase: 'update',
        message: 'Preview inputs changed that cannot take effect in place (' + restart.join(', ') + ')',
        hint: 'Stop this preview and call page_preview_open to apply the changed configuration/environment inputs' })
      return
    }
    if (fixtureHit.length) {
      try { await this.switchScenario() }
      catch (error) {
        this.record({ code: DiagnosticCode.runtimeError, phase: 'update',
          message: 'Scenario data changed but in-place reload failed: '
            + (error instanceof RunnerSessionError ? error.diagnostic.message
              : error instanceof Error ? error.message : String(error)),
          hint: 'Fix the changed scenario fixture, or stop and re-open the preview' })
      }
    }
    if (!rest.length) return
    if (!handle.inputsChanged) {
      // 无裁量通道（attach/static/自定义命令）：不假定已覆盖，如实记 stale。
      this.freshness = 'stale'
      this.publish(this.snapshot())
      return
    }
    const decision = await handle.inputsChanged(rest)
    if (decision.kind === 'refresh') { await this.refresh(); return }
    if (decision.kind === 'restart-required') {
      this.freshness = 'stale'
      this.publish(this.snapshot())
      this.record({ code: DiagnosticCode.previewNeedsRestart, phase: 'update',
        message: 'Preview inputs changed and require a restart: ' + decision.reason,
        hint: 'Stop this preview and call page_preview_open to apply the changes' })
    }
  }
  /** refresh/switchScenario 共用更新通道：互斥、state 进出 updating、失败统一 fail。 */
  private runUpdate(task: () => Promise<UpdateOutcome>): Promise<UpdateOutcome> {
    if (this.updateTask) return this.updateTask
    if (!['reachable', 'ready', 'degraded'].includes(this.state)) return Promise.reject(sessionError(DiagnosticCode.runtimeError, 'update', 'Preview is not in a refreshable state'))
    this.transition('updating')
    this.updateTask = (async () => {
      try {
        const outcome = await task()
        // stop/失败之后到达的更新不得恢复旧状态或覆盖 freshness。
        if (!this.control.signal.aborted) this.applyUpdateResult(outcome)
        return outcome
      } catch (error) {
        if (!this.control.signal.aborted) await this.fail(error instanceof RunnerSessionError ? error : sessionError(DiagnosticCode.runtimeError, 'update', 'Preview update failed', error))
        throw error
      }
    })().finally(() => {
      this.updateTask = undefined
      // inputs-changed 在更新期间排队（R3-5）：落定后统一再判，不并入旧更新的结果。
      if (this.pendingInputs.size && !this.flushingInputs) {
        this.flushingInputs = true
        const queued = [...this.pendingInputs]
        this.pendingInputs.clear()
        void this.inputsChanged(queued).catch(error => this.record({
          code: DiagnosticCode.runtimeError, phase: 'update',
          message: 'Queued input changes could not be applied: '
            + (error instanceof Error ? error.message : String(error)),
          hint: 'Call page_preview_refresh to retry applying the latest inputs',
        })).finally(() => { this.flushingInputs = false })
      }
    })
    return this.updateTask
  }

  /**
   * 更新结果落地（§9.2）：编译失败不是终态——回到原状态，freshness=stale；
   * 需要重启时由调用方决定重启或进入 failed。
   */
  applyUpdateResult(outcome: UpdateOutcome) {
    if (this.state !== 'updating') throw new Error('Update result requires an updating session')
    const previous = this.stateBeforeUpdate ?? 'reachable'
    switch (outcome.kind) {
      case 'updated':
        this.freshness = outcome.freshness
        this.transition(previous)
        break
      case 'compile-error':
        this.freshness = 'stale'
        for (const diagnostic of outcome.diagnostics.length ? outcome.diagnostics : [{ code: DiagnosticCode.compileError, phase: 'update' as const, message: 'Adapter reported a compile error without details', hint: 'Call page_preview_status with detail: true for the forwarded compile message and location' }]) this.record(diagnostic)
        this.transition(previous)
        break
      case 'restart-required':
        this.freshness = 'stale'
        throw sessionError(DiagnosticCode.runtimeError, 'update', 'Preview update requires a new plan and restart: ' + outcome.reason)
    }
    this.stateBeforeUpdate = undefined
    if (outcome.kind === 'updated') this.advance()
  }

  private accept(event: RunEvent): void {
    if (this.control.signal.aborted) return
    switch (event.type) {
      case 'diagnostic': this.record(event.diagnostic); return
      case 'unmatched':
        this.unmatchedLog.record(event.request)
        this.publish(this.snapshot())
        return
      case 'page-text':
        // 转发的 url 同样去 query/userinfo；text 已是限长文本，仍过同一值替换。
        this.pageText = { ...event.observation, text: this.redactor.text(event.observation.text, PAGE_TEXT_LIMIT), url: this.redactor.url(event.observation.url) }
        this.publish(this.snapshot())
        return
      case 'freshness': this.freshness = event.freshness; this.publish(this.snapshot()); return
      case 'exited':
        void this.fail(sessionError(DiagnosticCode.runtimeError, this.state === 'updating' ? 'update' : this.state === 'starting' ? 'start' : 'ready', `Preview process exited (code=${event.code}, signal=${event.signal})`))
        return
      case 'evidence':
        // 适配器未给 at 时补 Runner 接收时间：与 pageText.receivedAt 同一时钟，
        // Host 才能判断文本观测是否晚于挂载信号（R5-0a，决策 P-A）。
        this.readiness[event.layer] = { at: new Date().toISOString(), ...event.evidence }
        if (event.evidence.status === 'failed') {
          void this.fail(sessionError(DiagnosticCode.targetNotReady, 'ready', 'Preview readiness evidence failed: ' + event.layer))
        } else {
          this.advance()
          this.publish(this.snapshot())
        }
    }
  }

  private advance(): void {
    if (this.control.signal.aborted || !this.handle) return
    if (this.readiness.serviceReachable.status === 'proven') {
      if (this.state === 'starting') this.transition('reachable')
      this.service.resolve()
    }
    if (Object.values(this.readiness).every(evidence => evidence.status === 'proven')) {
      if (this.state === 'reachable') this.transition('ready')
      this.target.resolve()
    }
  }

  private async fail(error: RunnerSessionError): Promise<void> {
    this.markFailure(error)
    this.control.abort(error)
    this.clearTimer()
    await this.cleanup()
  }

  private markFailure(error: RunnerSessionError): void {
    if (this.failure) return
    this.failure = error
    this.record(error.diagnostic)
  }

  private cleanup(): Promise<StopOutcome> {
    if (this.state === 'stopped' || (this.state === 'failed' && !this.handle && !this.residual.length)) return Promise.resolve({ residual: [] })
    if (this.cleanupTask) return this.cleanupTask
    this.cleanupTask = (async () => {
      const deadline = Date.now() + this.cleanupTimeoutMs
      const residual: string[] = []
      if (this.startup && !this.startupSettled) {
        try { await beforeDeadline(this.startup, deadline) }
        catch (error) {
          if (error instanceof CleanupTimeout) { residual.push('Adapter startup is still pending'); this.retryAfter(this.startup) }
          // start 的拒绝由 start() 报告；账本与 ManagedProcessError 另行核对，不能当作无残留。
        }
      }
      if (this.handle) {
        this.handleCleanup ??= Promise.resolve().then(() => this.handle!.stop())
        const task = this.handleCleanup
        try {
          residual.push(...(await beforeDeadline(task, deadline)).residual)
          this.handleCleanup = undefined
        } catch (error) {
          this.lastCleanupError = error
          if (error instanceof CleanupTimeout) { residual.push('Adapter cleanup is still pending'); this.retryAfter(task) }
          else { residual.push('Adapter cleanup failed'); this.handleCleanup = undefined }
          this.record({ code: DiagnosticCode.cleanupFailed, phase: 'stop', message: 'Adapter cleanup did not complete', hint: 'Retry page_preview_stop; residual resources are listed in the stop result' })
        }
      }
      if (this.startupError instanceof ManagedProcessError) {
        for (const pid of this.startupError.residualPids) {
          try { if (await readProcessStartTime(pid)) residual.push('Unverified residual process ' + pid) }
          catch (error) { this.lastCleanupError = error; residual.push('Unable to inspect residual process ' + pid) }
        }
      }
      if (this.context) {
        try {
          for (const entry of await beforeDeadline(this.context.ledger.listByPreview(this.previewId), deadline)) residual.push('Ledger resource ' + entry.resource.kind + ' ' + entry.id)
        } catch (error) {
          this.lastCleanupError = error
          residual.push('Unable to verify resource ledger')
          this.record({ code: DiagnosticCode.cleanupFailed, phase: 'ledger', message: 'Resource cleanup could not be verified', hint: 'Retry page_preview_stop; run it with recover: true if the preview was abandoned' })
        }
      }
      this.residual = [...new Set(residual)]
      if (this.residual.length) {
        if (this.state !== 'stopping') this.transition('stopping')
        this.transition('cleanup_failed')
      } else if (this.explicitStop && !this.failure) {
        this.handle = undefined
        if (this.state !== 'stopping') this.transition('stopping')
        this.transition('stopped')
      } else {
        // 曾记录失败的会话终态仍是 failed：清理完成只证明资源已释放，不改写失败证据（P1-5）。
        this.handle = undefined
        this.transition('failed')
      }
      const result = { residual: [...this.residual] }
      if (this.state === 'stopped') this.publish({ type: 'stopped', previewId: this.previewId, ...result })
      // 同步清除：状态消息先于 .finally 发布，复用已 settle 的任务会让会话停在 stopping。
      this.cleanupTask = undefined
      return result
    })().finally(() => { this.cleanupTask = undefined })
    return this.cleanupTask
  }

  private retryAfter(task: Promise<unknown>): void {
    const retry = async () => {
      // 迟到操作可能在当前清理结束前完成；先等结果落地，再判断是否需要重试。
      await this.cleanupTask
      if (this.state === 'cleanup_failed') return this.stop()
    }
    void task.then(retry, retry)
  }

  private record(diagnostic: Diagnostic): void {
    // 统一脱敏：适配器可能把项目值带进任何文本字段；结构化 location 各自过同一规则。
    const location = diagnostic.location === undefined ? undefined : {
      ...(diagnostic.location.file === undefined ? {} : { file: this.redactor.text(diagnostic.location.file) }),
      ...(diagnostic.location.line === undefined ? {} : { line: diagnostic.location.line }),
      ...(diagnostic.location.request === undefined ? {} : { request: this.redactor.text(diagnostic.location.request) }),
    }
    const redacted: Diagnostic = { ...diagnostic, message: this.redactor.text(diagnostic.message),
      ...(diagnostic.hint === undefined ? {} : { hint: this.redactor.text(diagnostic.hint) }),
      ...(location === undefined ? {} : { location }) }
    this.diagnostics.push(structuredClone(redacted))
    this.publish({ type: 'diagnostic', previewId: this.previewId, diagnostic: structuredClone(redacted) })
  }

  private publish(message: RunnerToHost): void { for (const listener of this.listeners) listener(message) }
  private clearTimer(): void { clearTimeout(this.stageTimer); this.stageTimer = undefined }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function sessionError(code: string, phase: Diagnostic['phase'], message: string, cause?: unknown): RunnerSessionError {
  return new RunnerSessionError({ code, phase, message, hint: 'Call page_preview_status with detail: true for diagnostics, then retry page_preview_open' }, cause)
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Invalid preview lifecycle deadline')
  return value
}

class CleanupTimeout extends Error {
  constructor() { super('Cleanup deadline exceeded'); this.name = 'CleanupTimeout' }
}
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CleanupTimeout()), Math.max(0, deadline - Date.now())) })])
  } finally { clearTimeout(timer) }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}
