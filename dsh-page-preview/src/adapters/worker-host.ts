/** 自有 worker 宿主运行时（方案 §6.5、§6.9、§9.2）：Vue/React 各宿主共用的所有权、就绪编排与清理；项目代码仅在托管子进程执行。 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnManaged } from '../runner/process-tree.ts'
import type { ManagedProcess } from '../runner/process-tree.ts'
import { assertionEvidence } from '../runner/response-layer/assertions.ts'
import { observePageText } from '../runner/response-layer/page-text.ts'
import { findListeningPids } from '../runner/port-ownership.ts'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'
import { fingerprintJson } from '../shared/fingerprint.ts'
import type { BrowserReport } from '../runner/response-layer/report-channel.ts'
import type { PreviewPlan } from '../shared/contracts.ts'
import type { RunningHandle, StartContext } from './types.ts'

export interface WorkerHostApi {
  send(message: object): Promise<void>
  active(): boolean
  onFail(fn: (error: unknown) => void): void
}

/** Vite/CLI worker 输出共有的消息面；适配器自有的扩展消息经 classify 分流到 onExtra。 */
export type SharedWorkerMessage =
  | { type: 'booted'; pid: number }
  | { type: 'verify-handlers'; pid: number }
  | { type: 'ready'; pid: number; origin: string; nonce: string }
  | { type: 'report'; report: BrowserReport }
  | { type: 'compile-error'; message?: string; file?: string; line?: number; column?: number; frame?: string }
  | { type: 'compiled' }
  | { type: 'applied' }
  | { type: 'http-diagnostic'; code: DiagnosticCode; method?: string; origin?: string; path?: string
      queryKeys?: string[] }
  // R3-2：场景更新应答；stale=入口重建/编译未成功（已换绑），
  // applied:false=更新在 worker 内未生效、未换绑（R5-0b），error=worker 侧拒绝（Runner 已预检，属防御）。
  | { type: 'scenario-ack'; stale?: boolean; applied?: boolean; error?: string }
  | { type: 'failed'; code: DiagnosticCode; message?: string; stack?: string }

export interface WorkerHostSpec<Out extends { type: string }> {
  adapterId: string
  /** 执行器标签（Vite/Vue CLI/React Vite）；诊断与证据文案使用。 */
  label: string
  /** 框架标签（Vue/React）；浏览器侧信号与错误的文案使用。 */
  framework: string
  workerScript: string
  tmpPrefix: string
  pagePath: string
  compileLabel: string
  blockedBinding: string
  unverifiedFacts(toolchain: Record<string, string>): string[]
  /**
   * 执行前按当前源/配置重算计划用于绑定漂移核对；返回 undefined 表示计划已无法成立
   * （按 'plan' 分量漂移上报）。实现不得放宽审批时已核对的约束。
   */
  verifyBindings(ctx: StartContext, plan: PreviewPlan): Promise<PreviewPlan | undefined>
  parseOutput(raw: unknown): Out
  classify(message: Out): { kind: 'shared'; message: SharedWorkerMessage } | { kind: 'extra'; message: Out }
  onExtra?(message: Out, api: WorkerHostApi): void
  extend?(api: WorkerHostApi): Partial<RunningHandle>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function problem(code: string, message: string, cause?: unknown) {
  return new RunnerSessionError({ code, phase: 'start', message,
    hint: 'Verify the configured target/entry bindings and installed toolchain in package.json, then retry; ' +
      'no dependencies were installed or requirements relaxed',
  }, cause)
}

function emitCompileError(ctx: StartContext, spec: { compileLabel: string },
  message: Extract<SharedWorkerMessage, { type: 'compile-error' }>,
) {
  // §13 第 8 条：编译错误转发 message/文件/行列/frame，敏感值已由 worker 统一脱敏。
  const where = message.file === undefined ? ''
    : ' ' + message.file
      + (message.line === undefined ? '' : ':' + message.line)
      + (message.column === undefined ? '' : ':' + message.column)
  ctx.emit({ type: 'freshness', freshness: 'stale' })
  ctx.emit({ type: 'diagnostic', diagnostic: {
    code: DiagnosticCode.compileError, phase: 'update',
    message: spec.compileLabel + ' compilation failed' + where
      + (message.message ? ': ' + message.message : '')
      + (message.frame ? '\n' + message.frame : ''),
    ...(message.file === undefined ? {} : {
      location: { file: message.file, ...(message.line === undefined ? {} : { line: message.line }) },
    }),
    hint: 'Fix the reported file in the target source; the preview recompiles on the next change',
  } })
}

function emitHttpDiagnostic(ctx: StartContext, blockedBinding: string,
  message: Extract<SharedWorkerMessage, { type: 'http-diagnostic' }>, previewOrigin: string | undefined,
) {
  const messages: Partial<Record<DiagnosticCode, string>> = {
    [DiagnosticCode.unmatchedRequest]: 'No scenario HTTP response matched; no real backend was contacted',
    [DiagnosticCode.blockedRequest]: 'A connection or Upgrade was rejected outside ' + blockedBinding,
    [DiagnosticCode.configInvalid]: 'Several scenario HTTP fixtures matched; no response was selected',
    [DiagnosticCode.unsupportedCapability]:
      'Static fixture response does not update the scenario store for later reads',
    [DiagnosticCode.projectMockUnavailable]:
      'The declared vite-plugin-mock could not be loaded; its requests fall through to unmatched',
    [DiagnosticCode.protocolViolation]:
      'A client WebSocket frame exceeded the 1 MiB fixture limit; the connection was closed '
        + 'with RFC 6455 code 1009',
  }
  const hints: Partial<Record<DiagnosticCode, string>> = {
    [DiagnosticCode.unmatchedRequest]:
      'Declare a matching scenario fixture or business path; unmatched requests are never forwarded',
    [DiagnosticCode.blockedRequest]:
      'Remove the cross-origin/upgrade attempt or declare the required channel; blocked requests are never forwarded',
    [DiagnosticCode.projectMockUnavailable]:
      'Install vite-plugin-mock in the project dependencies or declare the needed responses as scenario fixtures',
    [DiagnosticCode.protocolViolation]:
      'Keep client WebSocket messages under 1 MiB or split them into smaller messages; '
        + 'oversized frames are never processed',
  }
  // R3-1：未命中除诊断外另发结构化事件，供 RunnerSession 的 UnmatchedRequestLog 汇总。
  // 事件的 origin 只记跨源——同源未命中的 origin 即预览自身，带上会让草稿误归 crossOrigin；
  // 诊断 location 仍按 §13 第 8 条原样展示 method+origin+path。
  if (message.code === DiagnosticCode.unmatchedRequest && message.path !== undefined) {
    ctx.emit({ type: 'unmatched', request: {
      method: message.method ?? 'UNKNOWN',
      ...(message.origin === undefined || message.origin === previewOrigin ? {} : { origin: message.origin }),
      path: message.path,
      ...(message.queryKeys === undefined ? {} : { queryKeys: message.queryKeys }),
    } })
  }
  ctx.emit({ type: 'diagnostic', diagnostic: {
    code: message.code, phase: 'scenario',
    message: messages[message.code] ?? 'Scenario HTTP response failed',
    ...(message.path === undefined ? {} : {
      location: { request: [message.method, (message.origin ?? '') + message.path].filter(Boolean).join(' ') },
    }),
    hint: hints[message.code] ?? 'Fix the reported scenario fixture or handler; do not relax requirements',
  } })
}

function emitBrowserReport(
  ctx: StartContext, plan: StartContext['plan'], spec: { pagePath: string; label: string; framework: string },
  report: BrowserReport, origin: string | undefined,
) {
  const text = origin ? observePageText(report, origin + spec.pagePath) : undefined
  if (text) { ctx.emit({ type: 'page-text', observation: text }); return }
  const evidence = origin ? assertionEvidence(plan.readiness.assertions, report, origin + spec.pagePath) : undefined
  if (evidence) { ctx.emit({ type: 'evidence', layer: 'targetMounted', evidence }); return }
  if (report.kind === 'document-loaded' && origin) {
    const url = new URL(report.url)
    if (url.origin === origin && url.pathname === spec.pagePath && !url.search && !url.hash) {
      ctx.emit({ type: 'evidence', layer: 'documentLoaded',
        evidence: { status: 'proven', detail: 'Owned ' + spec.label + ' preview document reported loading' } })
    }
    return
  }
  if (report.kind === 'target-mounted' && !plan.readiness.assertions?.length) {
    ctx.emit({ type: 'evidence', layer: 'targetMounted', evidence: { status: 'unverified',
      detail: spec.framework + ' mounted signal received; target assertions are not configured on this path' } })
    return
  }
  if (report.kind === 'runtime-error' || report.kind === 'unhandled-rejection') {
    ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.runtimeError, phase: 'ready',
      message: spec.framework + ' preview reported a runtime error: ' + report.message
        + (report.stack ? '\n' + report.stack : ''),
      ...(report.kind === 'runtime-error' && report.source ? { location: { request: report.source } } : {}),
      hint: 'Fix the reported error in the target source; forwarded message and stack frames are redacted project text',
    } })
    return
  }
  if (report.kind === 'csp-violation') ctx.emit({ type: 'diagnostic', diagnostic: {
    code: DiagnosticCode.blockedRequest, phase: 'ready',
    message: spec.framework + ' preview resource/connection was blocked by its controlled response policy: '
      + report.directive,
    location: { request: report.blockedURI },
    hint: 'Declare the required data source as a same-origin scenario fixture; blocked requests are never forwarded',
  } })
}

export async function startWorkerHost<Out extends { type: string }>(
  ctx: StartContext, spec: WorkerHostSpec<Out>,
): Promise<RunningHandle> {
  const label = spec.label
  const plan = ctx.plan
  if (plan.strategy !== 'isolated' || plan.adapter.id !== spec.adapterId || plan.process.kind !== 'in-runner') {
    throw problem(DiagnosticCode.configInvalid, label + ' execution requires its isolated owned plan')
  }
  const unverified = spec.unverifiedFacts(plan.toolchain)
  if (unverified.length) ctx.emit({ type: 'diagnostic', diagnostic: {
    code: DiagnosticCode.unverifiedToolchain, phase: 'start',
    message: label + ' execution proceeds on an unverified combination: ' + unverified.join('; '),
    hint: 'Capabilities stay unknown for this combination; treat failures as unverified evidence, ' +
      'not as declared incompatibility',
  } })
  const check = (): void => {
    ctx.signal.throwIfAborted()
    if (Date.now() >= ctx.deadline) {
      throw problem(DiagnosticCode.startTimeout, label + ' service startup deadline expired')
    }
  }
  const beforeDeadline = async <T>(promise: Promise<T>): Promise<T> => {
    check()
    let timer: ReturnType<typeof setTimeout> | undefined
    let aborted: (() => void) | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(problem(DiagnosticCode.startTimeout,
            label + ' worker did not reach its startup condition before the deadline')),
          Math.max(1, ctx.deadline - Date.now()))
        aborted = () => reject(ctx.signal.reason)
        ctx.signal.addEventListener('abort', aborted, { once: true })
      })])
    } finally { if (timer) clearTimeout(timer); if (aborted) ctx.signal.removeEventListener('abort', aborted) }
  }
  const verifyPlan = async () => {
    const checked = await spec.verifyBindings(ctx, plan)
    // 如实指出漂移的分量（config/sources/toolchain），便于定位执行前被改动的绑定面。
    const drifted: string[] = []
    if (checked === undefined) drifted.push('plan')
    else {
      for (const key of Object.keys(plan.fingerprints) as (keyof typeof plan.fingerprints)[]) {
        if (checked.fingerprints[key] !== plan.fingerprints[key]) drifted.push('fingerprints.' + key)
      }
      if (fingerprintJson(checked.toolchain) !== fingerprintJson(plan.toolchain)) drifted.push('toolchain')
    }
    if (drifted.length) {
      throw problem(DiagnosticCode.configInvalid,
        label + ' source/config/toolchain bindings changed before execution: ' + drifted.join(', '))
    }
  }
  await verifyPlan()
  if (!ctx.verifyExecution) {
    throw problem(DiagnosticCode.configChangedNeedsApproval, 'The Runner execution verifier is not connected')
  }
  const verifyExecution = ctx.verifyExecution.bind(ctx)
  await verifyExecution()
  check()
  let directory: string | undefined
  let pathEntry: string | undefined
  let managed: ManagedProcess | undefined
  let port: number | undefined
  let portEntry: string | undefined
  let off: (() => void) | undefined
  let started = false
  let stopping = false
  let stopped = false
  let stoppingTask: Promise<{ residual: string[] }> | undefined
  const drains: Promise<void>[] = []
  const boot = deferred<void>()
  const ready = deferred<Extract<SharedWorkerMessage, { type: 'ready' }>>()
  const failCleanups: ((error: unknown) => void)[] = []
  let origin: string | undefined
  let executorFailure: unknown
  let handlerVerificationRequested = false
  let scenarioWaiter: {
    resolve: (value: { stale: boolean; applied: boolean }) => void
    reject: (error: unknown) => void
  } | undefined
  const api: WorkerHostApi = {
    send: message => {
      if (!managed?.ipc) return Promise.reject(new Error(label + ' executor IPC is not available'))
      return managed.ipc.send(message)
    },
    active: () => started && !stopping && !stopped,
    onFail: fn => { failCleanups.push(fn) },
  }
  const stop = (): Promise<{ residual: string[] }> => {
    if (stopped) return Promise.resolve({ residual: [] })
    if (stoppingTask) return stoppingTask
    stopping = true
    stoppingTask = (async () => {
      const residual: string[] = []
      // 宽限 3s：worker 的优雅关闭自身有界（≤1.5s）；异常挂起由 SIGKILL 兜底。
      // 与会话 cleanupTimeoutMs（默认 5s）留出余量，避免清理整体超时被误判残留。
      try { if (managed) residual.push(...(await managed.stop(3000)).map(pid => label + ' process ' + pid)) }
      catch { residual.push(label + ' process ownership/cleanup could not be confirmed') }
      if (!residual.length) await Promise.all(drains)
      if (port !== undefined && portEntry) {
        try {
          if ((await findListeningPids(port)).length) residual.push(label + ' listener ' + port)
          else { await ctx.ledger.release(portEntry); portEntry = undefined }
        }
        catch { residual.push(label + ' listener cleanup could not be checked') }
      }
      if (!residual.length && directory) {
        try {
          await rm(directory, { recursive: true, force: true })
          if (pathEntry) { await ctx.ledger.release(pathEntry); pathEntry = undefined }
        }
        catch { residual.push(label + ' temporary entry cleanup failed') }
      }
      if (!residual.length) { stopped = true; off?.() }
      return { residual }
    })().finally(() => { stoppingTask = undefined })
    return stoppingTask
  }
  const fail = (error: unknown) => {
    executorFailure ??= error
    boot.reject(error); ready.reject(error)
    scenarioWaiter?.reject(error); scenarioWaiter = undefined
    for (const fn of failCleanups.splice(0)) {
      try { fn(error) } catch { /* fail hooks must not mask the original error */ }
    }
    if (started && !stopping) ctx.emit({ type: 'evidence', layer: 'serviceReachable',
      evidence: { status: 'failed', detail: label + ' executor protocol/lifecycle failed' } })
  }
  try {
    directory = await realpath(await mkdtemp(join(tmpdir(), spec.tmpPrefix)))
    pathEntry = (await ctx.ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId,
      workspaceRoot: ctx.workspaceRoot, resource: { kind: 'path', path: directory } })).id
    managed = await spawnManaged({
      executable: process.execPath, args: [spec.workerScript], cwd: ctx.appRoot,
      env: { ...ctx.config.project.runtime.env }, ipc: true,
    }, ctx.ledger, ctx, ctx.signal)
    const worker = managed
    if (!worker.ipc) throw new Error(label + ' executor IPC was not created')
    for (const output of [worker.stdout, worker.stderr]) drains.push((async () => {
      try {
        // Raw project output can contain credentials; never persist or forward.
        for await (const _chunk of output) { /* drained */ }
      }
      catch {
        if (!stopping) ctx.emit({ type: 'diagnostic', diagnostic: {
          code: DiagnosticCode.runtimeError, phase: 'start',
          message: label + ' output stream failed; raw output is not forwarded',
        } })
      }
    })())
    void worker.exited.then(value => {
      fail(problem(DiagnosticCode.runtimeError, label + ' executor exited before or during preview'))
      if (started && !stopping) ctx.emit({ type: 'exited', ...value })
    }, fail)
    off = worker.ipc.onMessage(raw => {
      try {
        const classified = spec.classify(spec.parseOutput(raw))
        if (classified.kind === 'extra') { spec.onExtra?.(classified.message, api); return }
        const message = classified.message
        if (message.type === 'booted' || message.type === 'ready') {
          if (message.pid !== worker.pid) throw new Error(label + ' executor PID mismatch')
          if (message.type === 'booted') boot.resolve(); else ready.resolve(message)
        } else if (message.type === 'verify-handlers') {
          const unexpected = message.pid !== worker.pid || started || handlerVerificationRequested
            || plan.scenario === undefined || !ctx.config.project.scenarios?.[plan.scenario]?.handlers
          if (unexpected) throw new Error('Unexpected handler verification request')
          handlerVerificationRequested = true
          void (async () => {
            await verifyExecution()
            await verifyPlan()
            check()
            if (executorFailure) throw executorFailure
            await api.send({ type: 'handlers-verified' })
          })().catch(fail)
        } else if (message.type === 'failed') {
          const detail = [message.message, message.stack].filter(value => value !== undefined).join('\n')
          fail(problem(message.code,
            detail || label + ' executor could not load/compile the selected project; no alternative path was used'))
        } else if (message.type === 'scenario-ack') {
          const waiter = scenarioWaiter
          scenarioWaiter = undefined
          if (!waiter) throw new Error('Unexpected ' + label + ' scenario acknowledgement')
          if (message.error !== undefined) waiter.reject(problem(DiagnosticCode.runtimeError, message.error))
          else waiter.resolve({ stale: message.stale === true, applied: message.applied !== false })
        } else if (message.type === 'compile-error') emitCompileError(ctx, spec, message)
        else if (message.type === 'compiled') ctx.emit({ type: 'freshness', freshness: 'unverified' })
        // 浏览器已证明加载/应用了最近一次成功编译的版本，freshness 才推进 current（P1-6）。
        else if (message.type === 'applied') ctx.emit({ type: 'freshness', freshness: 'current' })
        else if (message.type === 'http-diagnostic') emitHttpDiagnostic(ctx, spec.blockedBinding, message, origin)
        else emitBrowserReport(ctx, plan, spec, message.report, origin)
      } catch (error) { fail(error) }
    })
    await beforeDeadline(boot.promise)
    await verifyExecution()
    await verifyPlan()
    check()
    await api.send({ type: 'start', previewId: ctx.previewId, workspaceRoot: ctx.workspaceRoot,
      appRoot: ctx.appRoot, temporaryRoot: directory, project: ctx.config.project, plan,
      ...(ctx.buildCacheRoot === undefined ? {} : { buildCacheRoot: ctx.buildCacheRoot }) })
    const announced = await beforeDeadline(ready.promise)
    check()
    origin = announced.origin
    port = Number(new URL(origin).port)
    const listeners = await findListeningPids(port)
    if (listeners.length !== 1 || listeners[0] !== worker.pid) {
      throw problem(DiagnosticCode.ownershipUnverified, label + ' listener is not owned by the registered executor')
    }
    portEntry = (await ctx.ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId,
      workspaceRoot: ctx.workspaceRoot, resource: { kind: 'port', port, pid: worker.pid } })).id
    const probe = await fetch(origin + '/__dsh_preview/health?nonce=' + announced.nonce, {
      redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))]),
    })
    const body: unknown = await probe.json()
    const owned = probe.ok && !!body && typeof body === 'object'
      && 'previewId' in body && body.previewId === ctx.previewId
    if (!owned) throw problem(DiagnosticCode.ownershipUnverified, label + ' authenticated listener probe failed')
    await verifyExecution()
    await verifyPlan()
    check()
    if (executorFailure) throw executorFailure
    started = true
    ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven',
      detail: 'Registered ' + label + ' executor owns the loopback listener and passed its authenticated probe' } })
    return {
      // R5-4：声明 viewport 时打开插件自有外层框架页（固定尺寸 iframe 内嵌预览文档）。
      url: plan.viewport === undefined ? new URL(spec.pagePath, origin).href
        : origin + '/__dsh_preview/frame',
      // 会话级脱敏（诊断/调试日志）需要知道回传 nonce；不返回给模型。
      channelSecrets: [announced.nonce],
      // R3-2：场景更新经专用 IPC 交 worker 原子替换；stale 如实回报，不走 HMR 保状态。
      switchScenario(update) {
        if (!api.active()) return Promise.reject(problem(DiagnosticCode.runtimeError,
          label + ' executor is not in an updatable state'))
        if (scenarioWaiter) return Promise.reject(problem(DiagnosticCode.runtimeError,
          'A ' + label + ' scenario update is already in flight'))
        const outcome = new Promise<{ stale: boolean; applied: boolean }>((resolve, reject) => {
          scenarioWaiter = { resolve, reject }
        })
        void api.send({ type: 'scenario-update', name: update.name, scenario: update.scenario }).catch(error => {
          const waiter = scenarioWaiter
          scenarioWaiter = undefined
          waiter?.reject(error)
        })
        return outcome.then(result => {
          // R5-0b（决策①）：worker 报告入口未生效（未换绑）时按可恢复的 compile-error 落地——
          // 会话回原状态、freshness=stale、plan.scenario 保持旧场景；编译错误详情已由
          // compile-error 通道单独上报，本诊断只陈述"更新未应用"。
          if (!result.applied) return { kind: 'compile-error' as const, diagnostics: [{
            code: DiagnosticCode.compileError, phase: 'update' as const,
            message: label + ' preview entry did not become servable within its deadline; '
              + 'the scenario update was not applied and the previous scenario keeps serving',
            hint: 'Fix the reported compile error or the watched-entry condition, '
              + 'then call page_preview_refresh with the scenario again',
          }] }
          return { kind: 'updated' as const,
            freshness: result.stale ? 'stale' as const : 'unverified' as const }
        })
      },
      ...(spec.extend ? spec.extend(api) : {}),
      stop,
    }
  } catch (error) {
    if ((await stop()).residual.length) {
      throw problem(DiagnosticCode.cleanupFailed,
        label + ' startup rollback left resources requiring ownership checks', error)
    }
    throw error
  }
}
