/** Runner 命令分派（方案 §6.5、§8、§9.2）：共用适配器注册，执行前核对随 start 携带的批准指纹。 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigLoadError } from '../shared/config/loader.ts'
import type { EffectiveProjectConfig } from '../shared/config/loader.ts'
import { collectExecutionItems, executionFingerprint, requiresExecutionApproval } from '../shared/config/fingerprint.ts'
import { loadWorkspaceProjects } from '../shared/config/projects.ts'
import { ProjectReadError } from '../shared/profile.ts'
import { resolveProjectPath } from '../shared/config/paths.ts'
import { fingerprintJson } from '../shared/fingerprint.ts'
import { DiagnosticCode } from '../shared/errors.ts'
import type { Diagnostic, PreviewPlan } from '../shared/contracts.ts'
import type { HostToRunner, RunnerAck, RunnerReply, RunnerToHost } from '../shared/ipc.ts'
import { getAdapter } from '../adapters/registry.ts'
import { createDebugLog, runnerLogFile } from '../shared/debug-log.ts'
import type { DebugLog } from '../shared/debug-log.ts'
import { collectEnvPairs, createRedactor, envSecrets } from '../shared/redact.ts'
import { createFileLedger } from './ledger.ts'
import { RunnerWorkspace } from './workspace.ts'
import { RunnerSessionError } from './session.ts'
import type { RunnerSession } from './session.ts'

export class RunnerController {
  private readonly workspaceRoot: string
  private readonly dataDir: string
  private readonly ledger: ReturnType<typeof createFileLedger>
  private readonly workspace: RunnerWorkspace
  private readonly emit: (message: RunnerToHost) => void
  private recovery: string[] = []
  private readonly debugLog: DebugLog
  private constructor(workspaceRoot: string, dataDir: string, servicesDir: string,
    emit: (message: RunnerToHost) => void, debugLog?: DebugLog) {
    this.workspaceRoot = workspaceRoot
    this.dataDir = dataDir
    this.emit = emit
    this.debugLog = debugLog ?? createDebugLog(runnerLogFile(dataDir, workspaceRoot), createRedactor())
    this.ledger = createFileLedger(servicesDir)
    this.workspace = new RunnerWorkspace(workspaceRoot)
    this.workspace.onMessage(emit)
  }
  static async create(workspaceRoot: string, dataDir: string, servicesDir: string,
    emit: (message: RunnerToHost) => void, debugLog?: DebugLog): Promise<RunnerController> {
    const controller = new RunnerController(await realpath(workspaceRoot), dataDir, servicesDir, emit, debugLog)
    await controller.reconcile()
    return controller
  }
  async handle(message: HostToRunner): Promise<RunnerAck | undefined> {
    // R3-5：单向通知（无 ack）。owner/状态门禁在 session 内；分级处理（执行项→restart 诊断、
    // 场景数据→就地重载、其余→适配器裁量）不阻塞消息循环，内部失败如实经 diagnostic 上报。
    if (message.type === 'inputs-changed') {
      const session = this.workspace.get(message.previewId, message.ownerSessionId)
      void session?.inputsChanged(message.paths).catch(error => {
        // 与该预览诊断同一脱敏来源：env 值与回传 nonce 不得经错误文本进入模型可见输出。
        const redactor = createRedactor({ secrets: [...(session?.redactionSecrets ?? [])] })
        this.emit({ type: 'diagnostic', previewId: message.previewId, diagnostic: {
          code: DiagnosticCode.runtimeError, phase: 'update',
          message: 'Preview could not apply the changed inputs: '
            + redactor.text(error instanceof Error ? error.message : String(error)),
          hint: 'Call page_preview_status to check state, or stop and re-open the preview',
        } })
      })
      return undefined
    }
    const reply = (result: RunnerReply, diagnostics: Diagnostic[] = []): RunnerAck => ({ type: 'ack', requestId: message.requestId, ok: result.status === 'ok', result, ...(diagnostics.length ? { diagnostics } : {}) })
    let startProject: EffectiveProjectConfig['project'] | undefined
    try {
      if (message.type === 'shutdown') return reply(await this.shutdown())
      if (message.type === 'start') {
        if (await realpath(message.workspaceRoot) !== this.workspaceRoot) throw problem(DiagnosticCode.ownershipUnverified, 'plan', 'Command workspace does not match this Runner')
        if (this.recovery.length) {
          await this.reconcile()
          if (this.recovery.length) return reply({ status: 'error', residual: [...this.recovery] }, [diag(DiagnosticCode.cleanupFailed, 'ledger', 'Previous resources require explicit ownership verification')])
        }
        const projects = await loadWorkspaceProjects(this.workspaceRoot, message.configFile, { dataDir: this.dataDir })
        const selected = projects.find(value => value.config.project.id === message.plan.projectId)
        if (!selected) throw problem(DiagnosticCode.configInvalid, 'config', 'Configured project was not found')
        const { config, profile } = selected
        startProject = config.project
        const runtime = config.project.runtime
        await this.verifyApproval(config, message.approval, message.plan.generatedSetup?.hash)
        if (fingerprintJson(config.project) !== message.plan.fingerprints.config) throw problem(DiagnosticCode.configInvalid, 'config', 'Configuration changed; create a new plan before starting')
        const adapter = getAdapter(message.plan.adapter.id)
        const processKind = message.plan.strategy === 'attach' ? 'attach' : message.plan.strategy === 'project' ? 'managed' : 'in-runner'
        if (!adapter || !adapter.strategies.includes(message.plan.strategy) || message.plan.process.kind !== processKind) throw problem(DiagnosticCode.unsupportedCapability, 'plan', 'No registered execution path matches this strategy and process ownership')
        // R3-0（P2-3）：按适配器声明的 AdapterFeatures 判定，不再按 adapter.id 写死分支。
        const features = adapter.features
        const isolatedRequested = message.plan.requirements.includes('isolated-target')
          || Boolean(runtime.entry) || Boolean(runtime.styles?.length)
        const unsupported = !features.scenarios && message.plan.scenario
          || !features.targetAssertions && message.plan.readiness.assertions?.length
          || !features.isolatedTarget && isolatedRequested
        if (unsupported) {
          throw problem(DiagnosticCode.unsupportedCapability, 'plan',
            'Requested initialization, isolated rendering or target assertion is not implemented on this command path')
        }
        const appRoot = await resolveProjectPath(this.workspaceRoot, config.project.root)
        const result = await this.workspace.open(message.previewId, message.plan, adapter, {
          workspaceRoot: this.workspaceRoot, appRoot, ownerSessionId: message.ownerSessionId, config, profile, ledger: this.ledger,
          buildCacheRoot: join(this.dataDir, 'build-cache',
            createHash('sha256').update(appRoot).digest('hex').slice(0, 32)),
          verifyExecution: () => this.verifyCurrentExecution(message.plan, message.configFile, message.approval),
        })
        if (result.kind === 'created' || result.kind === 'reused') {
          // R3-2：场景更新凭据只挂会话，不进适配器可见的 StartContext。
          // initialHandlers 记录本预览启动时实际加载的 handler 声明路径，供更新期绑定不变量核对。
          const boundHandlers = message.plan.scenario === undefined
            ? undefined : config.project.scenarios?.[message.plan.scenario]?.handlers
          result.session.reloadBinding = { dataDir: this.dataDir,
            ...(message.configFile === undefined ? {} : { configFile: message.configFile }),
            ...(message.approval?.fingerprint === undefined
              ? {} : { approvalFingerprint: message.approval.fingerprint }),
            ...(boundHandlers === undefined ? {} : { initialHandlers: boundHandlers }) }
          return reply({ status: 'ok', previewId: result.session.previewId, previews: [snapshot(result.session)],
            ...(result.kind === 'created' && result.takenOver !== undefined ? { takenOver: result.takenOver } : {}) })
        }
        if (result.kind === 'busy') {
          const same = result.occupant.ownerSessionId === message.ownerSessionId
          return reply({ status: 'busy', occupant: { previewId: result.occupant.session.previewId, state: result.occupant.session.state, projectId: result.occupant.session.plan.projectId, targetId: result.occupant.session.plan.targetId, sameOwner: same } },
            [{ code: DiagnosticCode.previewBusy, phase: 'start', message: same ? 'An unfinished preview owned by this session still occupies the workspace' : 'A preview owned by another session occupies this workspace', hint: same ? 'Stop the occupying preview with page_preview_stop (previewId or all: true, or recover: true), then retry page_preview_open' : 'Ask the user to stop the preview owned by the other session, then retry page_preview_open' }])
        }
        return reply({ status: 'not_found' }, [{ code: DiagnosticCode.runtimeError, phase: 'start', message: 'The workspace did not accept the preview; it may be closing or already terminal', hint: 'Call page_preview_status, then retry page_preview_open' }])
      }
      const session = 'previewId' in message && message.previewId ? this.workspace.get(message.previewId, message.ownerSessionId) : undefined
      if (message.type === 'status') {
        if (message.previewId && !session) return reply({ status: 'not_found' })
        return reply({ status: 'ok', previews: (session ? [session] : this.workspace.list(message.ownerSessionId)).map(snapshot) })
      }
      if (!session) return reply({ status: 'not_found' })
      if (message.type === 'stop') {
        const result = await this.workspace.stop(message.previewId, message.ownerSessionId)
        return reply({ status: result?.residual.length ? 'error' : 'ok', previewId: message.previewId, residual: result?.residual ?? [], previews: [snapshot(session)] })
      }
      if (message.type === 'refresh') {
        // R3-2：有场景上下文（显式 scenario 或预览已选场景）走场景重载；否则纯文档重载。
        if (message.scenario !== undefined || session.plan.scenario !== undefined) {
          await session.switchScenario(message.scenario)
        } else {
          await session.refresh()
        }
        return reply({ status: 'ok', previewId: message.previewId, previews: [snapshot(session)] })
      }
      throw problem(DiagnosticCode.unsupportedCapability, 'scenario', 'Unsupported Runner command')
    } catch (error) {
      const diagnostic = error instanceof RunnerSessionError ? error.diagnostic
        : error instanceof ConfigLoadError ? diag(DiagnosticCode.configInvalid, 'config', 'Invalid preview configuration: ' + error.issues.map(issue => issue.path + ': ' + issue.message).join('; '))
        : error instanceof ProjectReadError ? diag(DiagnosticCode.configInvalid, 'detect', 'Invalid or inaccessible project metadata; no fallback configuration was used')
        : this.unexpectedDiagnostic()
      // R4-1 收尾：原始错误（含 cause 之外的 message/stack）按归属脱敏——可归属会话用该预览
      // env 值与通道 nonce；无法归属用全部存活会话密钥并集，另加 start 目标项目的 env。
      const session = 'previewId' in message && message.previewId
        ? this.workspace.get(message.previewId, message.ownerSessionId) : undefined
      const secrets = session === undefined
        ? await this.logSecrets(startProject).catch(() => this.workspace.redactionSecrets())
        : session.redactionSecrets
      this.debugLog.write({ level: 'error', scope: 'runner', event: 'command.failed', code: diagnostic.code,
        error }, createRedactor({ secrets: [...secrets] }))
      return reply({ status: diagnostic.code === DiagnosticCode.unsupportedCapability ? 'unsupported' : 'error' }, [diagnostic])
    }
  }
  async shutdown(): Promise<RunnerReply> {
    const sessions = await this.workspace.shutdown()
    await this.reconcile()
    const residual = [...new Set([...sessions.flatMap(value => value.residual), ...this.recovery])]
    return { status: residual.length ? 'error' : 'ok', residual }
  }
  /**
   * R2-1：一次性批准不落盘——Host 把用户批准的指纹随 start 消息带来；
   * Runner 只核对它与当前执行项指纹一致（文件/配置此刻未变），不读取任何持久记录。
   */
  private async verifyApproval(
    config: EffectiveProjectConfig, approval?: { fingerprint: string }, generatedSetupHash?: string,
  ): Promise<void> {
    if (!requiresExecutionApproval(config.project, generatedSetupHash)) return
    const appRoot = await resolveProjectPath(this.workspaceRoot, config.project.root)
    const fingerprint = executionFingerprint(await collectExecutionItems(appRoot, config.project), generatedSetupHash)
    if (approval?.fingerprint !== fingerprint) {
      throw problem(DiagnosticCode.configChangedNeedsApproval, 'config',
        'Execution items have no matching user-approved fingerprint')
    }
  }
  private async verifyCurrentExecution(
    plan: PreviewPlan, configFile: string | undefined, approval?: { fingerprint: string },
  ): Promise<void> {
    const selected = (await loadWorkspaceProjects(this.workspaceRoot, configFile, { dataDir: this.dataDir })).find(value => value.config.project.id === plan.projectId)
    if (!selected) throw problem(DiagnosticCode.configInvalid, 'config', 'Configured project disappeared before execution')
    await this.verifyApproval(selected.config, approval, plan.generatedSetup?.hash)
    if (fingerprintJson(selected.config.project) !== plan.fingerprints.config) throw problem(DiagnosticCode.configInvalid, 'config', 'Configuration changed before execution; create a fresh plan')
  }
  /** 无法归属到单个会话的命令失败的脱敏来源：全部存活会话密钥并集，加 start 目标项目的 env 值。 */
  private async logSecrets(startProject: EffectiveProjectConfig['project'] | undefined): Promise<string[]> {
    const secrets = this.workspace.redactionSecrets()
    if (startProject === undefined) return secrets
    const appRoot = await resolveProjectPath(this.workspaceRoot, startProject.root).catch(() => undefined)
    const pairs = appRoot === undefined ? [] : await collectEnvPairs(appRoot)
    return [...new Set([...secrets, ...envSecrets(startProject.runtime.env, pairs)])]
  }

  /** 意外失败诊断（P2-8）：与 diag() 同一文案与可执行建议，另附调试日志位置或其不可用状态。 */
  private unexpectedDiagnostic(): Diagnostic {
    const file = this.debugLog.file
    const suffix = file === undefined ? ''
      : this.debugLog.available ? '; details are in ' + file : '; the debug log at ' + file + ' is unavailable'
    return {
      code: DiagnosticCode.runtimeError, phase: 'start',
      message: 'Runner command failed; inspect the selected configuration and local runtime',
      hint: 'Fix the reported condition in project configuration or source, then retry; do not relax the requested '
        + 'strategy or requirements' + suffix,
    }
  }

  private async reconcile(): Promise<void> {
    const report = await this.ledger.reconcile()
    this.recovery = [
      ...report.residual.map(value => 'Persisted ' + value.entry.resource.kind + ' ' + value.entry.id),
      ...report.corrupt.map(value => 'Unreadable persisted resource ' + value.name),
    ]
  }
}
function snapshot(session: RunnerSession) {
  const { type: _type, ...value } = session.snapshot()
  return value
}
function diag(code: string, phase: Diagnostic['phase'], message: string): Diagnostic { return { code, phase, message, hint: 'Fix the reported condition in project configuration or source, then retry; do not relax the requested strategy or requirements' } }
function problem(code: string, phase: Diagnostic['phase'], message: string): RunnerSessionError { return new RunnerSessionError(diag(code, phase, message)) }
