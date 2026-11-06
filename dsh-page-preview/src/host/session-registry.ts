/**
 * Host 工具状态投影（方案 §4.2、§9.2、§10）：只读取 RunnerClient 已受理的计划与实际状态，不另建状态表。
 *
 * 首版约束：一个工作区最多一个托管 Runner、一个正在展示的目标；候选/最近目标保留 3 个。
 * 其他 DSH 会话占用时返回 busy，不替换其预览。
 */

import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { z } from 'zod'
import type {
  CaptureResult,
  Candidate,
  Diagnostic,
  OpenResult,
  PreviewOccupant,
  PreviewSummary,
  RefreshResult,
  SessionState,
  SetupDraftSummary,
  StatusResult,
  StopResult,
  ToolResultBase,
  WriteScenarioResult,
} from '../shared/contracts.ts'
import { DiagnosticCode } from '../shared/errors.ts'
import { collectEnvPairs, createRedactor, envSecrets } from '../shared/redact.ts'
import { ConfigLoadError } from '../shared/config/loader.ts'
import { writeSetupDraft } from '../shared/config/drafts.ts'
import type { EffectiveProjectConfig } from '../shared/config/loader.ts'
import { previewPlanSchema } from '../shared/plan-schema.ts'
import type { ExecutionApprovalResult } from './execution-approval.ts'
import { ExecutionApprovalError } from './execution-approval.ts'
import type { SetupWriteOutcome } from './setup-write-approval.ts'
import { loadWorkspaceProjects } from '../shared/config/projects.ts'
import type { WorkspaceProject } from '../shared/config/projects.ts'
import { ProjectReadError } from '../shared/profile.ts'
import { resolveProjectPath } from '../shared/config/paths.ts'
import {
  collectExecutionItems, executionComponentHashes, executionFingerprint,
} from '../shared/config/fingerprint.ts'
import { parseSelector, resolveTarget } from '../core/target/resolve.ts'
import { buildPlan } from '../core/plan/planner.ts'
import { adapters } from '../adapters/registry.ts'
import type { SetupDraftPayload } from '../adapters/types.ts'
import { createDebugLog, hostLogFile } from '../shared/debug-log.ts'
import type { DebugLog } from '../shared/debug-log.ts'
import { PreviewCallerError, resolvePreviewCaller } from './caller.ts'
import type { PreviewCaller } from './caller.ts'
import type { ImpactService } from './impact-service.ts'
import type { ImpactResult } from '../core/impact/types.ts'
import { DEFAULT_TRIGGER_MODE, decideTrigger } from './trigger.ts'
import type { TriggerMode } from './trigger.ts'
import { MISSING_DATA_DIR_HINT, RunnerClientError } from './runner-client.ts'
import type { PanelOpenReply, PanelPreview, PanelSnapshot, PanelStopReply } from '../client/protocol.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreviewInspection, RunnerClient } from './runner-client.ts'
import { ConfigWriteError, commitScenarioWrite, planScenarioWrite } from './config-write.ts'
import { containsPlaceholder } from '../shared/fixture-draft.ts'
import { scenarioConfigSchema } from '../shared/config/schema.ts'
import { RunnerConnectionError } from './runner-connection.ts'
import { truncateDiagnostics, visiblePlan } from './output.ts'
import { canonicalPath } from '../shared/config/paths.ts'
import type { RunnerReply, RunnerToHost } from '../shared/ipc.ts'
import { draftFixtures } from '../scenario/fixture-draft.ts'
import type { UnmatchedForDraft } from '../scenario/fixture-draft.ts'
import { collectFixtureSources } from '../scenario/fixture-sources.ts'
import { collectEnvelopeHint } from '../scenario/envelope-hint.ts'
import { collectCallSiteContext } from '../scenario/call-site-context.ts'
import type { UnmatchedRequestEntry } from '../shared/unmatched.ts'
import { postMountPageText } from './page-text.ts'

/** 受理后默认等待到就绪或 15 秒（可取消）；Runner 初始化/IPC 自身另有截止时间，未到目标就绪不能标 ready。 */
export const OPEN_WAIT_MS = 15_000
/**
 * 有 Client 在跟随调用者会话时（DSH 侧边栏会自动在 Browser 页签加载新预览），open 额外等待真实挂载证据的上限。
 * 2026-11-03 实机：没有浏览器证据时 Agent 自己开 Chrome 截图验证，单次耗时约 60 秒。
 */
export const BROWSER_MOUNT_WAIT_MS = 20_000
/** 面板一键打开的审批+启动总上限：审批对话框值得等满，但 open 不能无限挂起（R5-F5）。 */
export const PANEL_OPEN_BOUND_MS = 10 * 60_000
/** 仍在启动途中的状态；reachable 仅在配置了目标断言时才视为仍在向就绪推进。 */
const STARTING_STATES: readonly SessionState[] = ['preparing', 'starting', 'updating']
const id = z.string().min(1).refine(value => value.trim().length > 0)
const openRequestSchema = z.strictObject({
  projectId: id.exactOptional(), target: z.unknown().exactOptional(),
  scope: z.enum(['page', 'component', 'shell']).exactOptional(),
  strategy: z.enum(['auto', 'static', 'isolated', 'project', 'attach']).default('auto'),
  scenario: id.exactOptional(),
  viewport: z.strictObject({ width: z.int().positive(), height: z.int().positive() }).exactOptional(),
  requirements: z.array(z.enum(['isolated-target', 'mock-only'])).exactOptional(),
  writeSetupTo: id.exactOptional(),
})

export interface OpenArgs {
  projectId?: string
  target?: unknown
  scope?: string
  strategy?: string
  scenario?: string
  viewport?: { width: number; height: number }
  requirements?: string[]
  writeSetupTo?: string
}

/** 校验后的 open 请求与运行时 schema 同源。 */
export type OpenRequest = z.infer<typeof openRequestSchema>

export type CallerResolver = (exec: ToolRunContext) => Promise<PreviewCaller>
export interface SessionRegistryOptions {
  dataDir?: string
  openWaitMs?: number
  /** 面板一键打开的审批+启动总上限；缺省 PANEL_OPEN_BOUND_MS，测试可注入更小的上界。 */
  panelOpenBoundMs?: number
  /** previous 是同 owner 存活授权的组件哈希（无则 undefined）；返回一次性批准结果或拒绝原因。 */
  requestApproval?: (caller: PreviewCaller, config: EffectiveProjectConfig, exec: ToolRunContext,
    previous?: Record<string, string>, generated?: { entry: string, hash: string }) => Promise<ExecutionApprovalResult>
  /**
   * 调用者会话是否处于完全访问沙箱（danger-full-access：Full access 与 Auto 预设）。用户选了该权限时，
   * 执行项按其选择放行而不弹窗（2026-11-03 Aesc 决策）；读不到时按 false 处理，仍走官方审批。
   */
  fullAccess?: (exec: ToolRunContext) => boolean
  /** writeSetupTo 的官方用户确认；未提供时如实不写入项目（不以 Agent 自述的同意代替）。 */
  requestSetupWrite?: (caller: PreviewCaller, projectId: string, file: string, exec: ToolRunContext)
    => Promise<SetupWriteOutcome>
  /** R5-1a：场景写回 page-preview.config.json 的官方用户确认；未提供时如实不写入。 */
  requestConfigWrite?: (caller: PreviewCaller, projectId: string, scenario: string, exec: ToolRunContext)
    => Promise<SetupWriteOutcome>
  /** R3-4：open 省略 target 与 status 省略 previewId 时的本轮候选来源；缺省则退回 discover。 */
  impact?: ImpactService
  /** R3-5：轮次结束后的触发模式（插件配置 trigger，默认 smart）。 */
  triggerMode?: TriggerMode
  /** 测试注入的时间源；默认 Date.now（R6-F3：稳定信号 hint 的分支判定用它）。 */
  now?: () => number
  /** P2-8：意外失败调试日志；缺省按 dataDir 创建，测试可注入。 */
  debugLog?: DebugLog
}

/**
 * 会话级授权（2026-11-03 Aesc 决策，方案 §0.3）：用户在官方弹窗批准后，同一 DSH 会话对同一
 * workspace+项目、同一执行指纹持续有效；执行项变化（新指纹）、其他会话或 Host 重启都重新询问。
 * 只存于 Host 内存、不落盘；批准指纹随 start 消息发给 Runner，在执行前与当前指纹核对。
 */
interface ApprovalGrant {
  fingerprint: string
  hashes: Record<string, string>
}

/**
 * R6-F3：未命中列表"已稳定"的判定阈值——距最近一次新增未命中键达到该毫秒数后，
 * hint 从"再查一次"切换为"填草稿并写回"。取 2000ms：首屏请求集中在文档加载后
 * ~1s 内爆发（实测样本的 unmatched 时间戳间隔 << 1s），2s 足以覆盖偶发的慢请求，
 * 又不至于让 Agent 多等一轮。
 */
const UNMATCHED_SETTLE_MS = 2000

/** 稳定信号 hint：未达阈值建议稍后复查；达到阈值给出可执行的下一步（AGENTS §5 第 12 条）。 */
function unmatchedStabilityHint(sinceLastNewEntryMs: number, previewId: string): string {
  if (sinceLastNewEntryMs < UNMATCHED_SETTLE_MS) {
    return 'Call page_preview_status again shortly; fill fixtures once sinceLastNewEntryMs '
      + 'stops growing so first-screen requests have all been observed'
  }
  return "Fill fixtureDraft.configSnippet now and call page_preview_write_scenario with "
    + "mode 'merge' and applyTo '" + previewId + "' to append and apply the fixtures in place"
}

/** not_found 的下一步按选择器形态给出（AGENTS §5 第 12 条：必须可执行）。 */
function notFoundHint(kind: string): string {
  if (kind === 'url') {
    return 'A URL target needs a configured loopback origin: either retry with target {"kind": "file", "path": '
      + '"<page component file>"} for an isolated preview, or ask the user to add "strategy": "attach", '
      + '"origin": "<http://127.0.0.1:PORT of their running dev server>", "requirements": [] to the project runtime '
      + 'in page-preview.config.json (attach shows real backend data and never stops their server)'
  }
  return 'Retry with an existing file relative to the workspace (e.g. target {"kind": "file", "path": '
    + '"web/src/views/home/index.vue"}), or call page_preview_open without target to list candidates'
}

export class SessionRegistry {
  private readonly runner: RunnerClient
  private readonly resolveCaller: CallerResolver
  private readonly options: SessionRegistryOptions
  /** 会话级授权：workspace\0projectId\0owner → 最近一次批准（新批准替换旧指纹，旧指纹随之失效）。 */
  private readonly grants = new Map<string, ApprovalGrant>()
  private readonly debugLog: DebugLog
  /** ownerSessionId → 正在跟随该会话的 Client 面板流数量（侧边栏自动打开依赖它）。 */
  private readonly followers = new Map<string, number>()
  /** R3-5：Host 侧（非 Runner）触发诊断——auto-open unsupported、分析不完整提示；每轮替换，随 status/面板展示。 */
  private readonly hostDiagnostics = new Map<string, Diagnostic[]>()

  /** 面板订阅版本：只随 Runner 会话事实消息前进；快照本身始终来自 inspect 实时投影。 */
  private panelVersion = 0
  private readonly panelListeners = new Set<() => void>()

  constructor(runner: RunnerClient, resolveCaller: CallerResolver = exec => resolvePreviewCaller(exec.agent?.session), options: SessionRegistryOptions = {}) {
    if (options.openWaitMs !== undefined && (!Number.isSafeInteger(options.openWaitMs) || options.openWaitMs < 0 || options.openWaitMs > OPEN_WAIT_MS)) throw new Error('Invalid preview open wait window')
    if (options.panelOpenBoundMs !== undefined
      && (!Number.isSafeInteger(options.panelOpenBoundMs) || options.panelOpenBoundMs < 1)) {
      throw new Error('Invalid panel open bound')
    }
    this.runner = runner
    this.resolveCaller = resolveCaller
    this.options = options
    this.debugLog = options.debugLog ?? createDebugLog(hostLogFile(options.dataDir), createRedactor())
    this.runner.onMessage(message => {
      if (message.type === 'state' || message.type === 'diagnostic' || message.type === 'stopped') {
        this.panelVersion++
        for (const listener of this.panelListeners) listener()
      }
    })
  }

  private grantKey(workspaceRoot: string, projectId: string, ownerSessionId: string): string {
    return workspaceRoot + '\x00' + projectId + '\x00' + ownerSessionId
  }

  async open(args: OpenArgs, exec: ToolRunContext): Promise<OpenResult> {
    return this.openAttempt(args, exec, true)
  }

  private async openAttempt(args: OpenArgs, exec: ToolRunContext, canRequestApproval: boolean, justApproved?: { fingerprint: string; hashes: Record<string, string> }): Promise<OpenResult> {
    const parsed = openRequestSchema.safeParse(args)
    if (!parsed.success) return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'resolve', 'Invalid preview open arguments', 'Use one target selector, documented enums and positive integer viewport dimensions')] }
    const request = parsed.data
    const selector = request.target === undefined ? undefined : parseSelector(request.target)
    if (selector && 'error' in selector) return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'resolve', selector.error, 'Provide exactly one valid target selector')] }
    try {
      exec.signal.throwIfAborted()
      const caller = await this.caller(exec)
      const projects = await loadWorkspaceProjects(caller.workspaceRoot, undefined, this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir })
      const selectedProjects = request.projectId === undefined ? projects : projects.filter(value => value.config.project.id === request.projectId)
      if (!selectedProjects.length) return { status: request.projectId === undefined ? 'needs_configuration' : 'not_found', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'detect', 'No matching application was configured or discovered', 'Configure an application root, or provide a discovered project ID')] }
      if (!selector) {
        // R3-4：先取本轮影响分析候选（写完文件后 open 不带 target 的场景）；无候选才退回 discover。
        // 仍只返回候选（needs_selection），不自动选择，即使只有一个（R3-5 才决定自动动作）。
        if (this.options.impact !== undefined) {
          const impact = await this.options.impact.analyzeNow(caller.ownerSessionId)
          if (impact.candidates.length) {
            const result = selection(impact.candidates, 'Current-turn changes suggest these preview targets')
            if (impact.degraded.length) result.diagnostics.push(diagnostic(DiagnosticCode.impactIncomplete,
              'resolve', 'Impact analysis is incomplete: ' + truncate(impact.degraded.join('; '), 3),
              'The listed candidates may be partial; an explicit target selector is always authoritative'))
            return result
          }
        }
        const candidates = await discoverCandidates(selectedProjects, caller.workspaceRoot)
        return selection(candidates, 'No reliable task target was selected')
      }
      const resolved = await resolveTarget(selector, selectedProjects.map(value => value.config), caller.workspaceRoot, request.projectId)
      if (resolved.kind === 'ambiguous') return selection(resolved.candidates, 'Several application/target mappings match')
      if (resolved.kind === 'not-found') {
        return { status: 'not_found', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'resolve', resolved.reason,
          notFoundHint(selector!.kind))] }
      }
      const project = selectedProjects.find(value => value.config.project.id === resolved.target.projectId)!
      const target = { ...resolved.target, ...(request.scope === undefined ? {} : { scope: request.scope }) }
      const outcome = await buildPlan({ workspaceRoot: caller.workspaceRoot, ...project, target, strategy: request.strategy, adapters,
        // 一次性授权门禁：刚批准的指纹或仍在运行的授权链覆盖；其余一律需要重新询问。
        approvals: { isApproved: async (workspace, projectId, fingerprint) =>
          fingerprint === justApproved?.fingerprint
            || this.grants.get(this.grantKey(workspace, projectId, caller.ownerSessionId))?.fingerprint
              === fingerprint },
        ...(request.scenario === undefined ? {} : { scenario: request.scenario }),
        ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
        ...(request.requirements === undefined ? {} : { requirements: request.requirements }),
      })
      if (outcome.kind === 'unsupported') {
        const diagnostics = [diagnostic(DiagnosticCode.unsupportedCapability, 'plan', outcome.reason, 'Remove the unsupported option or choose an implemented adapter; requirements were not relaxed'), ...(outcome.diagnostics ?? [])]
        const setupDraft = outcome.setupDraft === undefined ? undefined
          : await this.draftSummary(outcome.setupDraft, diagnostics, caller, project.config.project, exec,
            request.writeSetupTo)
        return truncateDiagnostics({ status: 'unsupported', diagnostics, ...(setupDraft === undefined ? {} : { setupDraft }) })
      }
      if (outcome.kind === 'needs-configuration') {
        const approvalOnly = outcome.missing.length > 0
          && outcome.missing.every(value => value.code === DiagnosticCode.configChangedNeedsApproval)
        // 审批接缝随 dataDir 接通；缺失时如实说明是插件配置问题，而不是让 Agent 以为用户还没点批准。
        if (approvalOnly && canRequestApproval && this.options.dataDir === undefined) {
          return { status: 'needs_configuration', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'config',
            'Execution approval cannot be requested because the plugin dataDir is not configured; nothing was started',
            MISSING_DATA_DIR_HINT)] }
        }
        if (canRequestApproval && this.options.requestApproval && outcome.missing.length && outcome.missing.every(value => value.code === DiagnosticCode.configChangedNeedsApproval) && previewPlanSchema.safeParse(outcome.plan).success) {
          const key = this.grantKey(caller.workspaceRoot, project.config.project.id, caller.ownerSessionId)
          if (this.options.fullAccess?.(exec)) {
            const appRoot = await resolveProjectPath(caller.workspaceRoot, project.config.project.root)
            const items = await collectExecutionItems(appRoot, project.config.project)
            const generatedHash = outcome.plan?.generatedSetup?.hash
            const grant = {
              fingerprint: executionFingerprint(items, generatedHash),
              hashes: executionComponentHashes(items, generatedHash),
            }
            this.grants.set(key, grant)
            const result = await this.openAttempt(args, exec, false, grant)
            return { ...result, diagnostics: [diagnostic(DiagnosticCode.approvedByPermission, 'config',
              'Execution items were allowed by this session\'s full-access permission (Full access or Auto); '
                + 'no approval dialog was shown', 'No action needed; switch the session to workspace-write to be '
                + 'asked before project code runs'), ...result.diagnostics] }
          }
          const previous = this.grants.get(key)?.hashes
          const approval = await this.options.requestApproval(caller, project.config, exec, previous,
            outcome.plan?.generatedSetup)
          if (approval.outcome === 'approved') {
            // 批准即登记会话级授权（与本次启动成败无关：用户批准的是这组执行项）。
            this.grants.set(key, { fingerprint: approval.fingerprint, hashes: approval.hashes })
            return this.openAttempt(args, exec, false, approval)
          }
          if (approval.policy === 'never') {
            return { status: 'needs_configuration', diagnostics: [diagnostic(DiagnosticCode.configChangedNeedsApproval,
              'config', 'The DSH approval policy of this session is "never" (for example the Full access permission '
                + 'preset), so the execution approval was rejected automatically; no project command was started',
              'Ask the user to switch this session to a permission preset that asks for approval (for example '
                + '/permission workspace-write, or Auto), then retry page_preview_open; '
                + 'do not search for a workaround')] }
          }
          return { status: 'needs_configuration', diagnostics: [diagnostic(DiagnosticCode.configChangedNeedsApproval, 'config', 'Execution approval was ' + approval.outcome + '; no project command was started', 'Ask the user to approve the current execution items in the approval dialog, then retry page_preview_open; changes require a new grant')] }
        }
        const diagnostics = [...project.config.diagnostics, ...outcome.missing]
        // §6.9 v1.4：适配器给出待确认草稿时写入插件数据目录，结果只回传路径与分类项，不回传草稿原文。
        if (outcome.setupDraft !== undefined) return truncateDiagnostics({ status: 'needs_configuration', diagnostics,
          setupDraft: await this.draftSummary(outcome.setupDraft, diagnostics, caller, project.config.project, exec,
            request.writeSetupTo) })
        return truncateDiagnostics({ status: 'needs_configuration', diagnostics })
      }
      exec.signal.throwIfAborted()
      const previous = (await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId)).previews.find(value => !['failed', 'stopped'].includes(value.snapshot.state))
      exec.signal.throwIfAborted()
      const reply = await this.runner.start(randomUUID(), outcome.plan, caller.workspaceRoot, {
        ownerSessionId: caller.ownerSessionId, signal: exec.signal,
        ...(outcome.executionFingerprint === undefined ? {} : { approvalFingerprint: outcome.executionFingerprint }),
      })
      if (reply.status !== 'ok' || !reply.previewId) return { status: reply.status === 'ok' ? 'error' : reply.status, diagnostics: [], ...(reply.occupant === undefined ? {} : { occupant: reply.occupant }) }
      const previewId = reply.previewId
      let inspection = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, previewId)
      const preview = inspection.previews[0]
      // reachable 只有配置了目标断言才可能继续到 ready/degraded；无断言计划的就绪上限即 reachable（§805）。
      const awaitReady = outcome.plan.readiness.assertions !== undefined && outcome.plan.readiness.assertions.length > 0
      const pending = (state: SessionState) => STARTING_STATES.includes(state) || (state === 'reachable' && awaitReady)
      if (preview && pending(preview.snapshot.state)) {
        await this.waitForStart(previewId, exec.signal, pending)
        inspection = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, previewId)
      }
      // 侧边栏 Browser 会自动加载可达的新预览：等真实文档/挂载证据，省去 Agent 自行截图验证。
      const reached = inspection.previews[0]
      const followed = (this.followers.get(caller.ownerSessionId) ?? 0) > 0
      if (reached && followed
        && ['reachable', 'ready', 'degraded'].includes(reached.snapshot.state)
        && reached.snapshot.readiness.targetMounted.status === 'unverified') {
        await this.waitForMount(previewId, exec.signal)
        inspection = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, previewId)
      }
      const actual = inspection.previews[0]
      if (inspection.status !== 'ok' || !actual) return { status: inspection.status === 'ok' ? 'not_found' : inspection.status, diagnostics: [] }
      const summary = summarize(actual)
      const restarted = previous && previous.snapshot.previewId !== previewId ? [diagnostic(DiagnosticCode.previewRestarted, 'start', 'The changed preview plan replaced the previously owned preview after cleanup', 'Do not rely on the previous document state: it is not preserved and the restart does not isolate browser identity or storage')] : []
      if (followed && ['reachable', 'ready', 'degraded'].includes(summary.state)
        && actual.snapshot.readiness.documentLoaded.status === 'proven') {
        restarted.push(diagnostic(DiagnosticCode.shownInSidebar, 'ready',
          'The preview is open in the user\'s DSH sidebar Browser and its document has loaded',
          'Done: tell the user the preview is in the sidebar and finish; do not wait, poll status, sleep or '
            + 'take screenshots unless the user asks for verification'))
      }
      if (reply.takenOver !== undefined) {
        restarted.push(diagnostic(DiagnosticCode.previewTakenOver, 'start',
          'A preview owned by another DSH session (' + reply.takenOver + ') was stopped and cleaned up so this '
            + 'session could open its preview', 'No action needed; that session now sees its preview as stopped'))
      }
      const diagnostics = [
        ...project.config.diagnostics, ...(outcome.diagnostics ?? []),
        ...actual.diagnostics.map(value => withPreview(value, previewId)), ...restarted,
      ]
      // R5-0a（决策 P-A）：pageText 只投影可证明为挂载后的观测；早于挂载信号的首帧空文本
      // 不再当作页面文本，如实标注"尚未采集到"，不增加等待。仅响应层注入 bootstrap 的策略
      // （static/isolated）才补 pending 提示——其余路径本不产生 pageText。
      const pageText = postMountPageText(actual.snapshot, actual.plan.strategy)
      if (pageText === undefined && (actual.plan.strategy === 'static' || actual.plan.strategy === 'isolated')
        && !['failed', 'stopped', 'stopping', 'cleanup_failed'].includes(summary.state)) {
        diagnostics.unshift(withPreview(diagnostic(DiagnosticCode.pageTextPending, 'ready',
          'Page text has not been collected yet; observations earlier than the mounted signal '
            + 'are not reported as page text',
          // F7：与 preview_shown_in_sidebar 同结果共存时不得矛盾——条件化表述，
          // 需要核对页面内容才调一次 status，否则如实收尾（不轮询、不睡觉、不截图）。
          'Only if you need to verify the page content, call page_preview_status once with this '
            + 'previewId to read the latest observed page text; if the preview is shown in the '
            + 'sidebar, report it and stop'),
          previewId))
      }
      return truncateDiagnostics({
        status: ['failed', 'cleanup_failed'].includes(summary.state) ? 'error' : 'ok',
        preview: summary, diagnostics: diagnostics.reverse(),
        ...(actual.diagnosticsTruncated ? { diagnosticsTruncated: actual.diagnosticsTruncated } : {}),
        ...(pageText ? { pageText: structuredClone(pageText) } : {}),
      })
    } catch (error) { return this.failure(error, 'start', exec) }
  }

  /** 等待目标挂载证据落定（proven/failed）、文档失败或终态；窗口耗尽如实返回 unverified，不推断成功。 */
  private waitForMount(previewId: string, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const unsubscribe = this.runner.onMessage((message: RunnerToHost) => {
        if (message.type !== 'state' || message.previewId !== previewId) return
        // 侧边栏 Browser 加载了文档即返回（2026-11-03 Aesc：打开侧边栏就应结束，不等首次渲染文本）；
        // 已有可见文本或断言结论时一并带回。
        const settled = message.readiness.documentLoaded.status !== 'unverified'
          || message.readiness.targetMounted.status !== 'unverified'
        if (settled || message.readiness.documentLoaded.status === 'failed'
          || !['reachable', 'ready', 'degraded', 'updating'].includes(message.state)) finish()
      })
      timer = setTimeout(finish, Math.min(this.options.openWaitMs ?? BROWSER_MOUNT_WAIT_MS, BROWSER_MOUNT_WAIT_MS))
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  /** 等待状态离开 pending 谓词（就绪/降级/终态）或等待窗口耗尽；取消只停止等待，已受理预览仍由 status/stop 找回（§4.2）。 */
  private waitForStart(previewId: string, signal: AbortSignal, pending: (state: SessionState) => boolean): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const unsubscribe = this.runner.onMessage((message: RunnerToHost) => {
        if (message.type === 'state' && message.previewId === previewId && !pending(message.state)) finish()
      })
      timer = setTimeout(finish, this.options.openWaitMs ?? OPEN_WAIT_MS)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  async status(args: { previewId?: string; detail?: boolean }, exec: ToolRunContext): Promise<StatusResult> {
    if (!validId(args.previewId) || args.detail !== undefined && typeof args.detail !== 'boolean') return invalid('resolve')
    try {
      const caller = await this.caller(exec)
      const result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, args.previewId)
      if (result.status !== 'ok') return { status: result.status, diagnostics: [] }
      const previews = args.previewId ? result.previews : result.previews.slice(-3)
      const diagnostics = previews.flatMap(value => [...value.diagnostics].reverse().map(item => withPreview(item, value.snapshot.previewId)))
      const diagnosticsTruncated = previews.reduce((sum, value) => sum + value.diagnosticsTruncated, 0)
      const selected = previews[0]
      if (args.previewId && !selected) return { status: 'not_found', diagnostics: [] }
      const hostItems = args.previewId === undefined
        ? (this.hostDiagnostics.get(caller.ownerSessionId) ?? []) : []
      // R5-1b：项目数据来源（已有 mock 数据 → OpenAPI 显式 example）供草稿填真实响应体；
      // 只有 schema 可取样时给 shapeHints 提示。来源收集失败/不可达时草稿保持占位标记，不阻断 status。
      // R6-1c/d：同处解析场景已声明的 envelope（草稿只写 data 占位）；未声明时只读识别
      // 拦截器包装线索给出 envelopeHint 建议——不自动写入场景。
      // R6-2：同处并行收集调用点上下文（collectCallSiteContext）；收集失败或触顶产生可见诊断，不阻断 status。
      // R6-4：unmatched 输出附"距最近一次新增未命中条目的毫秒数"+可执行 hint，让 Agent 判断列表是否已稳定。
      // R6-F4（2026-11-04 实测）：三项收集各自有独立上限，不共享一个时间预算——
      //   collectFixtureSources/collectEnvelopeHint/collectCallSiteContext 的目录条目预算为
      //   5000/800/5000，另有单文件大小与文件数上限；只有 collectCallSiteContext 自带
      //   1500ms 墙钟截止时间。串行顺序：draftContext（sources+env）先行，然后 envelopeHint
      //   与 callSite 并行。单次 status detail 实测合计：real-traits 样本 ~3-5ms，
      //   3 万文件合成树 ~390-410ms（call-site 触 5000 条目预算置 limited）——低于 500ms
      //   缓存阈值，故不加按预览缓存；若日后实测超过阈值，失效条件应为"未命中键集合+源码树
      //   变更"（可复用 core/change 的既有跟踪，不要新写文件监听）。
      const draftContext = args.detail && args.previewId && selected?.snapshot.unmatched
        ? await this.draftContext(caller, selected).catch(() => undefined)
        : undefined
      const declaredEnvelope = draftContext?.scene?.envelope
      const unmatchedEntries = selected?.snapshot.unmatched?.entries ?? []
      const [envelopeHint, callSites] = draftContext === undefined ? [undefined, undefined] as const
        : await Promise.all([
            declaredEnvelope === undefined
              ? collectEnvelopeHint(draftContext.appRoot, { redact: draftContext.redact }).catch(() => undefined)
              : Promise.resolve(undefined),
            collectCallSiteContext(draftContext.appRoot,
              unmatchedEntries.map(entry => ({ method: entry.method, path: entry.path })),
              undefined, { redact: draftContext.redact })
              .then(result => ({ ...result, failed: false as const }),
                () => ({ contexts: new Map(), limited: false, failed: true as const })),
          ])
      const contextDiagnostics: Diagnostic[] = []
      if (callSites?.failed) {
        contextDiagnostics.push(diagnostic(DiagnosticCode.contextIncomplete, 'plan',
          'Call-site context collection failed; fixture drafts keep placeholders',
          'Fill fixtureDraft.configSnippet from the listed source files manually, or retry page_preview_status'))
      } else if (callSites?.limited) {
        contextDiagnostics.push(diagnostic(DiagnosticCode.contextIncomplete, 'plan',
          'Call-site context collection hit its scan budget; contexts are partial',
          'Treat fixtureDraft.contexts as a partial view; fill the remaining fixtures from source code directly'))
      }
      const output: StatusResult = {
        status: 'ok', diagnostics: [...diagnostics, ...contextDiagnostics, ...hostItems],
        ...(diagnosticsTruncated ? { diagnosticsTruncated } : {}),
        ...(args.previewId && selected ? { preview: summarize(selected) } : { previews: previews.map(summarize) }),
        ...(args.detail && args.previewId && selected ? { plan: visiblePlan(selected.plan) } : {}),
        ...(args.previewId && selected?.snapshot.pageText ? { pageText: structuredClone(selected.snapshot.pageText) } : {}),
        // R3-1：detail=true 且指定 previewId 时附 unmatched 汇总与 fixtureDraft；草稿仅生成，不写配置。
        // R6-4：输出时换算 sinceLastNewEntryMs——距最近一次新增未命中键的毫秒数（重复计数不算新增）。
        ...(args.detail && args.previewId && selected?.snapshot.unmatched
          ? {
              unmatched: {
                ...structuredClone(selected.snapshot.unmatched),
                ...(selected.snapshot.unmatched.lastNewEntryAt === undefined ? {} : {
                  sinceLastNewEntryMs: Math.max(0,
                    (this.options.now ?? Date.now)() - Date.parse(selected.snapshot.unmatched.lastNewEntryAt)),
                  hint: unmatchedStabilityHint(
                    Math.max(0, (this.options.now ?? Date.now)()
                      - Date.parse(selected.snapshot.unmatched.lastNewEntryAt)),
                    args.previewId),
                }),
              },
              fixtureDraft: draftFixtures(selected.snapshot.scenario ?? selected.plan.scenario ?? 'default',
                selected.snapshot.unmatched.entries.map(toDraftEntry), 20, draftContext?.resolve,
                {
                  ...(declaredEnvelope === undefined ? {} : { envelope: declaredEnvelope }),
                  ...(envelopeHint === undefined ? {} : { envelopeHint }),
                  ...(callSites === undefined || !callSites.contexts.size
                    ? {} : { contexts: [...callSites.contexts.values()] }),
                  ...(callSites?.limited ? { contextLimited: true } : {}),
                }),
            }
          : {}),
        // R3-4：省略 previewId 时附本轮 suggestions（最多 3 条 + omitted）；分析未跑过时字段缺失。
        ...(!args.previewId && this.options.impact !== undefined
          ? suggestionFields(this.options.impact.latest(caller.ownerSessionId))
          : {}),
      }
      return args.detail ? output : truncateDiagnostics(output)
    } catch (error) { return this.failure(error, 'resolve', exec) }
  }

  /**
   * R5-1a + R6-3：把 Agent 填好的场景定义写回工作区根 page-preview.config.json。
   * 顺序：参数与 schema 校验 → 占位标记拒绝 → 项目与来源核对 → 只读计划 → 官方审批 → 备份后写。
   * 同名场景绝不覆盖；local/explicit 来源的项目不写 repo 文件（会静默遮蔽既有配置），如实拒绝。
   * R6-3a `mode:'merge'`：目标场景必须已存在；http 只追加 (method, origin, path, query) 新键，
   * 其余场景级字段只能新增不能改写；任何冲突整体拒绝并列出冲突键。
   * R6-3b `applyTo`：写入成功后走既有 refresh+scenario 路径就地切换；预览不属于调用者或
   * 已停止时写入照常，应用部分如实报错，结果合并返回。审批与备份流程不变。
   */
  async writeScenario(args: { projectId?: string; scenario?: string; definition?: unknown;
    mode?: string; applyTo?: string },
    exec: ToolRunContext): Promise<WriteScenarioResult> {
    const refuse = (message: string, hint: string): WriteScenarioResult => ({
      status: 'error',
      diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'config', message, hint)],
    })
    if (typeof args.projectId !== 'string' || !args.projectId.trim()
      || typeof args.scenario !== 'string' || !args.scenario.trim()
      || typeof args.definition !== 'object' || args.definition === null || Array.isArray(args.definition)) {
      return refuse('Invalid scenario write arguments',
        'Pass projectId, a scenario name and a scenario object (e.g. a filled fixtureDraft.configSnippet entry)')
    }
    if (args.mode !== undefined && args.mode !== 'create' && args.mode !== 'merge') {
      return refuse('Invalid scenario write mode ' + JSON.stringify(args.mode),
        "Pass mode 'create' or 'merge', or omit it for the default create semantics")
    }
    if (args.applyTo !== undefined && !validId(args.applyTo)) {
      return refuse('Invalid applyTo previewId ' + JSON.stringify(args.applyTo),
        'Pass a previewId returned by page_preview_open or listed by page_preview_status')
    }
    const mode = args.mode ?? 'create'
    const parsed = scenarioConfigSchema.safeParse(args.definition)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return refuse('The scenario definition does not satisfy the config schema'
        + (first ? ': ' + first.path.join('.') + ' ' + first.message : ''),
        'Fix the reported field; copy the shape from a fixtureDraft.configSnippet scenario')
    }
    if (containsPlaceholder(args.definition)) {
      return refuse('The scenario still contains the fixture-draft placeholder and cannot be written',
        'Fill every fixture response body/header with real data and describe the source in provenance, then retry')
    }
    try {
      const caller = await this.caller(exec)
      const projects = await loadWorkspaceProjects(caller.workspaceRoot, undefined,
        this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir })
      const workspace = projects.find(value => value.config.project.id === args.projectId)
      if (!workspace) {
        return refuse('Project ' + JSON.stringify(args.projectId) + ' was not found in this workspace',
          'Call page_preview_status without previewId or page_preview_open to list the configured project ids')
      }
      const source = workspace.config.source
      if (source.kind === 'local' || source.kind === 'explicit') {
        return refuse('The project is configured by ' + source.kind + ' config (' + source.file
          + '); writing page-preview.config.json would silently shadow it',
          'Merge the scenario into that file manually, or move the project configuration to the workspace config file')
      }
      // 备份只放插件 dataDir（config-backups/<工作区哈希>/，F4）；dataDir 缺失时如实拒绝，
      // 与 open 的审批接缝要求一致，不回退到往项目目录里堆 .bak 文件。
      if (this.options.dataDir === undefined) {
        return refuse('Writing the scenario needs the plugin dataDir for backups, which is not configured; '
          + 'nothing was written',
          'Configure the plugin dataDir and retry, or merge the scenario into page-preview.config.json manually')
      }
      let plan
      try {
        plan = await planScenarioWrite(caller.workspaceRoot, workspace.config.project,
          args.scenario.trim(), parsed.data, this.options.dataDir, mode)
      } catch (error) {
        if (error instanceof ConfigWriteError) {
          return refuse(error.message,
            'Fix the reported problem or merge the scenario into page-preview.config.json manually')
        }
        throw error
      }
      let approval: SetupWriteOutcome | 'not confirmed (the approval service failed)' = 'unavailable'
      try {
        if (this.options.requestConfigWrite) {
          approval = await this.options.requestConfigWrite(caller, args.projectId, args.scenario.trim(), exec)
        }
      } catch (error) {
        this.debugLog.write({ level: 'error', scope: 'host', event: 'config_write.confirmation_failed',
          error }, createRedactor({ secrets: await this.workspaceSecrets(caller.workspaceRoot).catch(() => []) }))
        approval = 'not confirmed (the approval service failed)'
      }
      if (approval !== 'approved') {
        return refuse('Writing the scenario into ' + plan.file + ' was ' + approval + '; nothing was written',
          'Ask the user to approve the write in the DSH approval dialog and retry, or merge the scenario manually')
      }
      try {
        await commitScenarioWrite(plan)
      } catch (error) {
        if (error instanceof ConfigWriteError) {
          return refuse(error.message, error.stale
            ? 'Call page_preview_write_scenario again; a fresh plan is made from the current file contents'
            : 'Resolve the reported problem and retry the write')
        }
        throw error
      }
      // R6-3b：写入成功后按 applyTo 走既有 refresh+scenario 路径；应用失败不吞错、不改变写入结果。
      const applied = args.applyTo === undefined ? undefined
        : await this.refresh({ previewId: args.applyTo, scenario: args.scenario.trim() }, exec)
      return {
        status: 'ok',
        diagnostics: applied === undefined ? [] : applied.diagnostics,
        file: plan.file,
        ...(plan.backup === undefined ? {} : { backup: plan.backup }),
        projectId: args.projectId, scenario: args.scenario.trim(), mode: plan.mode,
        ...(applied === undefined ? {} : {
          applied: { previewId: args.applyTo!, status: applied.status },
        }),
      }
    } catch (error) { return this.failure(error, 'config', exec) }
  }

  async capture(args: { previewId: string; fullPage?: boolean }, exec: ToolRunContext): Promise<CaptureResult> {
    if (!args.previewId || !validId(args.previewId) || args.fullPage !== undefined && typeof args.fullPage !== 'boolean') return invalid('capture')
    try {
      const caller = await this.caller(exec)
      const result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, args.previewId)
      if (result.status !== 'ok' || !result.previews.length) return { status: result.status === 'ok' ? 'not_found' : result.status, diagnostics: [] }
      // TODO(phase2): 接入已经验证的 current-view 采集；当前没有该路径，不使用重放截图替代。
      return { status: 'unsupported', diagnostics: [diagnostic(DiagnosticCode.unsupportedCapability, 'capture', 'Current-view capture is not connected', 'Call page_preview_status with detail: true for readiness evidence and diagnostics; no screenshot was taken')] }
    } catch (error) { return this.failure(error, 'capture', exec) }
  }

  /** page_preview_refresh（R2-P0-2、R3-2）：只对调用者已绑定预览下发；Runner 侧再做 owner/状态门禁。 */
  async refresh(args: { previewId?: string; scenario?: string }, exec: ToolRunContext): Promise<RefreshResult> {
    if (!validId(args.previewId) || !validId(args.scenario)) return invalid('update')
    try {
      const caller = await this.caller(exec)
      const reply = await this.runner.refresh(args.previewId!, caller.ownerSessionId, args.scenario)
      if (reply.status !== 'ok') return { status: reply.status === 'busy' ? 'error' : reply.status, diagnostics: [] }
      const result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, args.previewId)
      const preview = result.status === 'ok' ? result.previews[0] : undefined
      if (!preview) return { status: 'not_found', diagnostics: [] }
      const diagnostics = [...preview.diagnostics].reverse().map(item => withPreview(item, preview.snapshot.previewId))
      return truncateDiagnostics({ status: 'ok', diagnostics, preview: summarize(preview) })
    } catch (error) { return this.failure(error, 'update', exec) }
  }

  async stop(args: { previewId?: string; all?: boolean; recover?: boolean }, exec: ToolRunContext): Promise<StopResult> {
    const exclusive = [args.previewId !== undefined, args.all === true, args.recover === true].filter(Boolean).length
    if (!validId(args.previewId) || args.all !== undefined && typeof args.all !== 'boolean' ||
        args.recover !== undefined && typeof args.recover !== 'boolean' || exclusive !== 1) return { ...invalid('stop'), stopped: [] }
    try {
      const caller = await this.caller(exec)
      if (args.recover === true) {
        const recovered = await this.runner.recover(caller.workspaceRoot)
        const unverified = recovered.residual.length
        const diagnostics: Diagnostic[] = unverified ? [diagnostic(DiagnosticCode.ownershipUnverified, 'ledger', unverified + ' persisted resource record(s) could not be ownership-verified and were archived; they were not signalled', 'Review the residual list in this result; run this recovery again if processes were replaced in the meantime')] : []
        return { status: 'ok', stopped: [], recovered, diagnostics }
      }
      const result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, args.previewId)
      if (result.status !== 'ok') return { status: result.status, stopped: [], diagnostics: [] }
      if (args.previewId && !result.previews.length) return { status: 'not_found', stopped: [], diagnostics: [] }
      const stopped: StopResult['stopped'] = []
      const diagnostics: Diagnostic[] = []
      let status: StopResult['status'] = 'ok'
      for (const preview of result.previews) {
        const outcome = await this.stopOne(caller, preview, exec)
        if (!outcome.ok) status = 'error'
        diagnostics.push(...outcome.diagnostics)
        stopped.push(outcome.stopped)
      }
      return truncateDiagnostics({ status, stopped, diagnostics })
    } catch (error) { return { ...await this.failure(error, 'stop', exec), stopped: [] } }
  }

  /** 面板流登记：返回注销函数。只计数，不保存任何会话内容。 */
  trackFollower(ownerSessionId: string): () => void {
    this.followers.set(ownerSessionId, (this.followers.get(ownerSessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.followers.get(ownerSessionId) ?? 1) - 1
      if (left > 0) this.followers.set(ownerSessionId, left)
      else this.followers.delete(ownerSessionId)
    }
  }

  /** 等待 since 之后的下一次会话事实变化；signal 中止时返回 undefined（§4.3 面板流）。 */
  panelChanges(since: number, signal: AbortSignal): Promise<number | undefined> {
    if (this.panelVersion !== since) return Promise.resolve(this.panelVersion)
    return new Promise(resolve => {
      const finish = (value: number | undefined) => {
        this.panelListeners.delete(wake)
        signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const wake = () => finish(this.panelVersion)
      const abort = () => finish(undefined)
      this.panelListeners.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** 面板快照：与 status 同一 inspect 投影的全部自有预览；不建第二份事实源（§10）。 */
  async panelSnapshot(caller: PreviewCaller): Promise<PanelSnapshot> {
    // Runner 退出/重启期间 inspect 可能抛错：面板流不能因此终止（否则侧边栏自动打开永久失效），如实给出诊断。
    let result: Awaited<ReturnType<RunnerClient['inspect']>>
    try { result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId) } catch (error) {
      const secrets = await this.workspaceSecrets(caller.workspaceRoot).catch(() => [] as string[])
      this.debugLog.write({ level: 'error', scope: 'host', event: 'panel.inspect_failed',
        error }, createRedactor({ secrets }))
      return { previews: [], diagnostics: [diagnostic(DiagnosticCode.runtimeError, 'ledger',
        'Preview state is temporarily unavailable while the Runner restarts',
        'Call page_preview_status again shortly')] }
    }
    if (result.status !== 'ok') return { previews: [], diagnostics: [] }
    const all = result.previews.flatMap(value => [...value.diagnostics].reverse().map(item => withPreview(item, value.snapshot.previewId)))
    const diagnosticsTruncated = result.previews.reduce((sum, value) => sum + value.diagnosticsTruncated, 0) + Math.max(0, all.length - 32)
    const hostItems = this.hostDiagnostics.get(caller.ownerSessionId) ?? []
    // R3-6：suggestions 与 status 同一份 ImpactService.latest 投影；selector 在此投影为摘要文本。
    const latest = this.options.impact?.latest(caller.ownerSessionId)
    const suggestions = latest?.candidates.slice(0, 3).map(candidate => ({
      projectId: candidate.projectId,
      selector: selectorLabel(candidate.selector),
      relation: candidate.relation.slice(0, 12),
      evidence: candidate.evidence,
      ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
      // R5-6：一键打开的调用载荷——真实 TargetSelector 经 JSON 编码随投影下发，
      // 面板点击原样回传；Host 仍按 openRequestSchema 严格校验后才进 openAttempt。
      open: { projectId: candidate.projectId, target: JSON.stringify(candidate.selector) },
    }))
    return {
      previews: result.previews.map(value => panelPreview(summarize(value))),
      diagnostics: [...all, ...hostItems].slice(0, 32),
      ...(diagnosticsTruncated ? { diagnosticsTruncated } : {}),
      ...(suggestions === undefined ? {} : { suggestions }),
      ...(latest?.omitted ? { suggestionsOmitted: latest.omitted } : {}),
    }
  }

  /**
   * 面板一键打开（R5-6、R5-F5，决策 D2-b）：点击即用户授权意图；执行项指纹审批不跳过——
   * session 是唯一身份源：caller/owner/审批会话全部由 exec.agent.session 解析与核对，
   * 不接受外部队属参数，无法解析即如实失败。官方审批弹窗照常经 requestApproval 请求。
   * agent 优先取 PanelService 经 ctx.get('agents') 找到的活动 Agent（scopeTarget 的正确
   * 载体）；缺失时退回 {id, session} 最小身份。signal 是面板取消与超时上限的并集。
   */
  async panelOpen(session: Session, request: { projectId: string, target: string },
    agent?: { id: string; session: Session }, signal?: AbortSignal): Promise<PanelOpenReply> {
    let target: unknown
    try { target = JSON.parse(request.target) } catch {
      return { status: 'error', diagnostics: [
        diagnostic(DiagnosticCode.configInvalid, 'resolve', 'The suggestion open payload is not valid JSON',
          'Use the open payload carried on the suggestion row without modification'),
      ] }
    }
    const callId = ToolCallId('panel-open-' + randomUUID())
    // 面板调用没有真实工具执行上下文：合成 exec 只提供该路径实际读取的字段。
    // 锁定版 @deepseek-ai/dsh-user-approval 0.2.1-rc.5 lib/index.js 的 request() 读取：
    // req.agent.session（L129，open-turn 检查与 approval/asked 落点）、toolName（L134）、
    // callId（L135）、reason（L136）、req.signal（L173 起 decide()：aborted→cancelled、
    // 与应答竞速，scopeTarget(req.agent, req.agent) 派发 approval/request 应答者）。
    // 本插件另读 exec.agent.session.id（execution-approval.ts:53、setup-write-approval.ts:53）、
    // exec.agent.session（caller.ts:18、plugin.ts sessionHasFullAccess）、exec.signal。
    // token/deferContext/concludeTurn 不被该路径触及，合成占位与既有测试合成 exec 同形。
    // 上限用 setTimeout+AbortController 而不是 AbortSignal.timeout：让 mock.timers 能验证
    // 超过 60 秒的等待不被打断（F5 测试要求）；unref 保证被遗弃的 panelOpen 不挂住进程。
    const bound = new AbortController()
    const boundTimer = setTimeout(() => bound.abort(), this.options.panelOpenBoundMs ?? PANEL_OPEN_BOUND_MS)
    boundTimer.unref()
    const exec = {
      callId, rootCallId: callId, name: 'pagePreview/open', arguments: request,
      agent: agent ?? { id: session.id, session },
      // 审批等待与启动共用这一条取消边：面板侧取消 + 10 分钟兜底（审批对话框值得等，
      // 但 open 不能无限挂起）；原 60s 会在用户正常看完说明前就中断（F5）。
      signal: signal === undefined ? bound.signal : AbortSignal.any([signal, bound.signal]),
      token: Symbol('panel-open') as ToolExecutionToken, deferContext() {}, concludeTurn() {},
    } as unknown as ToolRunContext
    try {
      const result = await this.openAttempt({ projectId: request.projectId, target }, exec, true)
      return {
        status: result.status === 'busy' ? 'busy' : result.status,
        ...(result.preview === undefined ? {} : {
          previewId: result.preview.previewId, state: result.preview.state,
          ...(result.preview.url === undefined ? {} : { url: result.preview.url }),
        }),
        diagnostics: result.diagnostics.slice(0, 16),
      }
    } catch (error) {
      const failure = await this.failure(error, 'start', exec)
      return { status: 'error', diagnostics: failure.diagnostics.slice(0, 16) }
    } finally { clearTimeout(boundTimer) }
  }

  /** 面板停止：与工具 stop 共用同一 owner 核对与清理终态检查；只释放本 owner 预览（§10）。 */
  async stopForOwner(caller: PreviewCaller, previewId: string): Promise<PanelStopReply> {
    const result = await this.runner.inspect(caller.workspaceRoot, caller.ownerSessionId, previewId)
    if (result.status !== 'ok') return { status: result.status === 'not_found' || result.status === 'busy' ? result.status : 'error', previewId, diagnostics: [] }
    const preview = result.previews[0]
    if (!preview) return { status: 'not_found', previewId, diagnostics: [] }
    const outcome = await this.stopOne(caller, preview, caller)
    return {
      status: outcome.ok ? 'ok' : 'error', previewId,
      ...(outcome.stopped.state === undefined ? {} : { state: outcome.stopped.state }),
      ...(outcome.stopped.residual === undefined ? {} : { residual: outcome.stopped.residual }),
      diagnostics: outcome.diagnostics,
    }
  }

  /** 单个预览的停止与清理核对；P1-5：曾失败的会话清理完成后终态为 failed（资源已核实释放）。 */
  private async stopOne(caller: PreviewCaller, preview: PreviewInspection,
    source?: ToolRunContext | PreviewCaller): Promise<{
      stopped: StopResult['stopped'][number]; diagnostics: Diagnostic[]; ok: boolean
    }> {
    const diagnostics: Diagnostic[] = []
    let reply: RunnerReply
    try { reply = await this.runner.stop(preview.snapshot.previewId, caller.ownerSessionId) }
    catch (error) {
      diagnostics.push(...(await this.failure(error, 'stop', source)).diagnostics)
      if (error instanceof RunnerConnectionError && error.result) reply = error.result
      else return { stopped: { previewId: preview.snapshot.previewId, state: preview.snapshot.state, residual: ['Stop could not be confirmed; query status before retrying'] }, diagnostics, ok: false }
    }
    const snapshot = reply.previews?.find(value => value.previewId === preview.snapshot.previewId)
    const residual = reply.residual ?? []
    const terminal = snapshot?.state === 'stopped' || (snapshot?.state === 'failed' && !residual.length)
    if (reply.status !== 'ok' || residual.length || !terminal) diagnostics.push(diagnostic(DiagnosticCode.cleanupFailed, 'stop', 'Preview cleanup is incomplete or unverified', 'Retry page_preview_stop for this preview; residual resources are listed in the result and ownership records stay'))
    return { stopped: { previewId: preview.snapshot.previewId, state: snapshot?.state ?? preview.snapshot.state, ...(residual.length ? { residual } : {}) }, diagnostics: diagnostics.map(value => withPreview(value, preview.snapshot.previewId)), ok: reply.status === 'ok' && !residual.length && terminal }
  }

  /**
   * TurnTracker 在轮次结束时调用（§9.1、R3-5）：decideTrigger 纯决策 → 受影响预览发
   * inputs-changed（单向通知，Runner 侧分级：执行项→restart 诊断、场景数据→就地重载、
   * 其余→适配器裁量）；recommend 只唤醒面板；auto-open 本轮无执行上下文，如实 unsupported。
   * Host 侧诊断随下一次 status/面板快照展示，下轮分析替换。
   */
  async onTurnAnalyzed(sessionId: string, impact: ImpactResult): Promise<void> {
    const diagnostics: Diagnostic[] = []
    if (impact.degraded.length) diagnostics.push(diagnostic(DiagnosticCode.impactIncomplete, 'resolve',
      'Impact analysis is incomplete: ' + truncate(impact.degraded.join('; '), 3),
      'Suggestions and notifications may be partial; an explicit target selector is always authoritative'))
    const workspaceRoot = this.options.impact?.workspaceOf(sessionId)
    const owned = workspaceRoot === undefined ? [] : await this.runner
      .inspect(workspaceRoot, sessionId).then(result => result.status === 'ok' ? result.previews : [], () => [])
    const views = owned.map(value => ({ previewId: value.snapshot.previewId,
      projectId: value.plan.projectId, state: value.snapshot.state }))
    for (const action of decideTrigger(this.options.triggerMode ?? DEFAULT_TRIGGER_MODE, impact, views)) {
      if (action.kind === 'notify-inputs') {
        this.runner.inputsChanged(action.previewId, sessionId, action.paths)
      } else if (action.kind === 'recommend') {
        // 面板唤醒：R3-6 在快照中呈现 suggestions；status 已可读到同一结果。
        this.panelVersion++
        for (const listener of this.panelListeners) listener()
      } else if (action.kind === 'auto-open') {
        diagnostics.push(diagnostic(DiagnosticCode.unsupportedCapability, 'plan',
          'A single high-confidence preview target was identified, but automatic open is not implemented '
            + '(turn-end triggers have no execution approval context)',
          'Call page_preview_open with an explicit target selector to open it; the suggestion is unchanged'))
      }
    }
    this.hostDiagnostics.set(sessionId, diagnostics)
  }
  /** session/disposed：释放 Host 侧触发诊断（ImpactService.forget 由 plugin 同步调用）。 */
  disposeSession(sessionId: string): void {
    this.hostDiagnostics.delete(sessionId)
  }

  /**
   * 草稿写插件数据目录并返回路径与分类摘要。writeSetupTo 是项目内相对路径（§6.9 例如 preview/setup.js）：
   * 写入前必须经官方审批弹窗由用户确认，且只创建新文件（wx），已有文件一律不覆盖；任何失败都以诊断说明，
   * 数据目录草稿仍可用。
   */
  private async draftSummary(payload: SetupDraftPayload, diagnostics: Diagnostic[], caller: PreviewCaller,
    project: EffectiveProjectConfig['project'], exec: ToolRunContext, writeSetupTo?: string,
  ): Promise<SetupDraftSummary> {
    const { source, ...summary } = payload
    const path = this.options.dataDir === undefined ? undefined
      : await writeSetupDraft(this.options.dataDir, caller.workspaceRoot, project.id, source)
    if (path === undefined) diagnostics.push(diagnostic(DiagnosticCode.configInvalid, 'config',
      'A setup draft was generated but could not be written because the plugin data directory is not configured',
      'Ask the user to configure the plugin data directory, then retry page_preview_open to obtain the draft path'))
    const installedTo = writeSetupTo === undefined ? undefined
      : await this.installDraft(source, diagnostics, caller, project, exec, writeSetupTo)
    return {
      ...(path === undefined ? {} : { path }),
      ...(installedTo === undefined ? {} : { installedTo }),
      configSnippet: '"setup": "' + (installedTo ?? 'preview/setup.js') + '"',
      ...summary,
    }
  }

  /** 返回实际写入的项目相对路径；越界、已存在、未获用户确认或写入失败均不写并追加诊断。 */
  private async installDraft(source: string, diagnostics: Diagnostic[], caller: PreviewCaller,
    project: EffectiveProjectConfig['project'], exec: ToolRunContext, writeSetupTo: string,
  ): Promise<string | undefined> {
    const refuse = (message: string, hint: string) => {
      diagnostics.push(diagnostic(DiagnosticCode.configInvalid, 'config', message, hint))
      return undefined
    }
    let appRoot: string
    let file: string
    try {
      appRoot = await resolveProjectPath(caller.workspaceRoot, project.root)
      file = await resolveProjectPath(appRoot, writeSetupTo)
    } catch {
      return refuse('The setup draft could not be written into the project at ' + JSON.stringify(writeSetupTo),
        'Pass a path relative to the application root such as preview/setup.js; the draft is still at setupDraft.path')
    }
    const relativePath = relative(appRoot, file)
    if (await stat(file).then(() => true, () => false)) {
      return refuse('The setup draft was not written: ' + relativePath + ' already exists and is never overwritten',
        'Retry page_preview_open with writeSetupTo pointing at a new file, or merge setupDraft.path into the '
          + 'existing file yourself')
    }
    let approval: SetupWriteOutcome | 'not confirmed (the approval service failed)' = 'unavailable'
    try {
      if (this.options.requestSetupWrite) {
        approval = await this.options.requestSetupWrite(caller, project.id, relativePath, exec)
      }
    } catch (error) {
      const secrets = [...envSecrets(project.runtime.env, await collectEnvPairs(appRoot)),
        ...this.runner.channelSecrets(caller.workspaceRoot)]
      this.debugLog.write({ level: 'error', scope: 'host', event: 'setup_write.confirmation_failed',
        error }, createRedactor({ secrets }))
      approval = 'not confirmed (the approval service failed)'
    }
    if (approval !== 'approved') {
      return refuse('Writing the setup draft into the project was ' + approval + '; no project file was created',
        'Ask the user to approve the write in the DSH approval dialog and retry, or copy setupDraft.path into the '
          + 'project yourself')
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source, { flag: 'wx' })
      return relativePath
    } catch (error) {
      const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST'
      return refuse('The setup draft could not be written into the project at ' + JSON.stringify(writeSetupTo)
        + (exists ? ': the file appeared concurrently and was not overwritten' : ''),
        'Retry page_preview_open with writeSetupTo pointing at a new file; the draft is still at setupDraft.path')
    }
  }

  private async caller(exec: ToolRunContext): Promise<PreviewCaller> {
    const caller = await this.resolveCaller(exec)
    if (!caller.ownerSessionId) throw new PreviewCallerError()
    return { ownerSessionId: caller.ownerSessionId, workspaceRoot: await canonicalPath(caller.workspaceRoot) }
  }

  /** P2-8：意外失败诊断的可执行后缀（§5 第 12 条）——日志可用给路径，写失败如实说明。 */
  private logSuffix(): string {
    const file = this.debugLog.file
    if (file === undefined) return ''
    return this.debugLog.available ? '; details are in ' + file : '; the debug log at ' + file + ' is unavailable'
  }

  /**
   * Host 侧意外失败/日志的脱敏来源：调用者工作区全部已配置/已识别项目的 env 值与 env 文件
   * 值并集（只读收集，不执行项目代码），加上 Runner 经 channel-secrets 上报的回传通道 nonce。
   */
  private async workspaceSecrets(workspaceRoot: string): Promise<string[]> {
    const secrets: string[] = [...this.runner.channelSecrets(workspaceRoot)]
    const projects = await loadWorkspaceProjects(workspaceRoot, undefined,
      this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir })
    for (const { config } of projects) {
      const appRoot = await resolveProjectPath(workspaceRoot, config.project.root).catch(() => undefined)
      secrets.push(...envSecrets(config.project.runtime.env,
        appRoot === undefined ? [] : await collectEnvPairs(appRoot)))
    }
    return secrets
  }

  /**
   * R5-1b + R6-1：解析预览对应项目的 appRoot、草稿数据来源、当前场景配置与源码片段脱敏器；
   * 找不到项目/根不可达时返回 undefined（草稿保持占位，不阻断 status）。
   */
  private async draftContext(caller: PreviewCaller, preview: PreviewInspection) {
    const projects = await loadWorkspaceProjects(caller.workspaceRoot, undefined,
      this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir })
    const project = projects.find(value => value.config.project.id === preview.plan.projectId)
    if (!project) return undefined
    const appRoot = await resolveProjectPath(caller.workspaceRoot, project.config.project.root)
    const sceneName = preview.snapshot.scenario ?? preview.plan.scenario ?? 'default'
    const scene = project.config.project.scenarios?.[sceneName]
    const sources = await collectFixtureSources(appRoot)
    const secrets = envSecrets(project.config.project.runtime.env, await collectEnvPairs(appRoot))
    const redactor = createRedactor({ secrets })
    return { appRoot, scene, resolve: sources.resolve,
      redact: (text: string, limit?: number) => redactor.text(text, limit) }
  }

  private async failure(error: unknown, phase: Diagnostic['phase'],
    source?: ToolRunContext | PreviewCaller): Promise<ToolResultBase & { occupant?: PreviewOccupant }> {
    if (error instanceof PreviewCallerError) return { status: 'needs_configuration', diagnostics: [diagnostic(DiagnosticCode.configInvalid, phase, error.message, 'Ask the user to reopen this workspace in DSH so the session carries a workspace cwd, then retry')] }
    if (error instanceof ConfigLoadError) return truncateDiagnostics({ status: 'needs_configuration', diagnostics: error.issues.map(issue => diagnostic(DiagnosticCode.configInvalid, 'config', issue.path + ': ' + issue.message, 'Edit the named configuration file to fix the reported issue; no fallback source was used')) })
    if (error instanceof ProjectReadError) return { status: 'needs_configuration', diagnostics: [diagnostic(DiagnosticCode.configInvalid, 'detect', error.message, 'Fix the reported project metadata file, then retry; no scripts or configuration modules were executed')] }
    if (error instanceof ExecutionApprovalError) return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.configChangedNeedsApproval, 'config', error.message, 'Retry inside an active Agent turn and use the official approval dialog; no grant or command execution was inferred')] }
    if (error instanceof RunnerConnectionError && error.reason === 'rejected') return truncateDiagnostics({ status: error.result?.status ?? 'error', diagnostics: error.diagnostics.map(value => ({ ...value, hint: value.hint ?? 'Call page_preview_status with detail: true for the plan, then retry the requested operation' })), ...(error.result?.occupant === undefined ? {} : { occupant: error.result.occupant }) })
    if (error instanceof RunnerClientError) return { status: 'error', diagnostics: [error.diagnostic] }
    // 引擎内置错误（栈溢出、类型错误等插件缺陷）与带 code 的 Node 系统错误必须转发原因（§13 第 8 条），
    // 经统一脱敏与限长；其余普通 Error 可能携带传输/项目值，保持不回显（见 stop 传输失败用例）。
    const systemError = error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    const builtin = error instanceof RangeError || error instanceof TypeError || error instanceof ReferenceError
      || error instanceof SyntaxError || systemError
    // 只记意外失败：上方已分类错误（configInvalid/Runner 拒绝等）的诊断本身可执行，无需调试日志；
    // 也让纯配置失败路径保持不产生插件数据目录。
    // 脱敏来源为该工作区项目 env 值 + 回传通道 nonce 并集（R4-1 收尾）；调用者不可解析时
    // 退回全部已上报 nonce（env 无从确定），仍优于仅去除认证头的兜底。
    const secrets = source === undefined ? this.runner.channelSecrets()
      : await (sourceIsCaller(source) ? Promise.resolve(source) : this.caller(source))
        .then(caller => this.workspaceSecrets(caller.workspaceRoot))
        .catch(() => this.runner.channelSecrets())
    const redactor = createRedactor({ secrets })
    this.debugLog.write({ level: 'error', scope: 'host', event: 'tool.failed', detail: phase,
      error }, redactor)
    if (!builtin) {
      return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.runtimeError, phase,
        'Preview operation could not be confirmed',
        'Call page_preview_status to query current state, then retry; no successful cleanup or readiness is implied'
          + this.logSuffix())] }
    }
    const detail = error.name + ': ' + error.message
    return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.runtimeError, phase,
      'Preview operation failed unexpectedly: ' + redactor.text(detail, 1024),
      'Call page_preview_status with detail: true to check state; if the message names a file or configuration '
        + 'field, fix it and retry; otherwise report this message to the user as a plugin defect '
        + '(no cleanup or readiness is implied)' + this.logSuffix())] }
  }
}

function selection(candidates: Candidate[], message: string): OpenResult {
  return {
    status: candidates.length ? 'needs_selection' : 'needs_configuration', candidates: candidates.slice(0, 3),
    diagnostics: [diagnostic(DiagnosticCode.ambiguousTarget, 'resolve', message + '; showing ' + Math.min(3, candidates.length) + ' of ' + candidates.length + ' candidates', 'Choose an explicit projectId and target selector; discovery is not evidence of relevance to the current task')],
  }
}

async function discoverCandidates(projects: WorkspaceProject[], workspaceRoot: string): Promise<Candidate[]> {
  const configured = projects.flatMap(({ config }) => (config.project.targets ?? []).map(target => ({ projectId: config.project.id, selector: { kind: 'registered' as const, id: target.id }, relation: ['Explicit target mapping'], evidence: 'strong' as const })))
  if (configured.length) return configured
  const candidates: Candidate[] = []
  for (const { config, profile } of projects) {
    const context = { workspaceRoot, appRoot: await resolveProjectPath(workspaceRoot, config.project.root), config, profile }
    for (const adapter of adapters) {
      if (config.project.runtime.adapter && config.project.runtime.adapter !== adapter.id) continue
      if (config.project.runtime.strategy && !adapter.strategies.includes(config.project.runtime.strategy)) continue
      if ((await adapter.probe(context)).matched) candidates.push(...(await adapter.discover(context)).candidates)
    }
  }
  return candidates
}

/** 未命中汇总 → 草稿输入：只转发请求匹配部分（method/origin/path/query 键名/count）。 */
function toDraftEntry(entry: UnmatchedRequestEntry): UnmatchedForDraft {
  return {
    method: entry.method,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    path: entry.path,
    queryKeys: entry.queryKeys,
    count: entry.count,
  }
}

/** failure 的密钥源：面板路径传已解析的 PreviewCaller，工具路径传 ToolRunContext 待解析。 */
function sourceIsCaller(source: ToolRunContext | PreviewCaller): source is PreviewCaller {
  return typeof (source as PreviewCaller).workspaceRoot === 'string'
}

function summarize(value: PreviewInspection): PreviewSummary {
  const { plan, snapshot } = value
  const capabilities = plan.capabilities
  const capabilityGaps: PreviewSummary['capabilityGaps'] = []
  const scope = capabilities.scopes[plan.scope]
  if (!scope || scope.status !== 'supported') capabilityGaps.push({ name: 'scope.' + plan.scope, capability: scope ?? { status: 'unknown', source: 'none', reason: 'No scope evidence in this plan' } })
  for (const name of ['isolatedRender', 'scenarioApply', 'scenarioReset', 'refresh', 'captureCurrentView', 'runtimeErrors', 'readinessAssertion'] as const) if (capabilities[name].status !== 'supported') capabilityGaps.push({ name, capability: structuredClone(capabilities[name]) })
  return {
    previewId: snapshot.previewId, projectId: plan.projectId, targetId: plan.targetId,
    scope: plan.scope, strategy: plan.strategy, state: snapshot.state, freshness: snapshot.freshness,
    readiness: structuredClone(snapshot.readiness), capabilityGaps,
    ...(snapshot.url && ['reachable', 'ready', 'degraded', 'updating'].includes(snapshot.state) ? { url: snapshot.url } : {}),
    ...((snapshot.scenario ?? plan.scenario) === undefined ? {} : { scenario: snapshot.scenario ?? plan.scenario }),
    ...(snapshot.unmatched?.entries.length ? { unmatchedCount: snapshot.unmatched.entries.length } : {}),
    ...(snapshot.unmatched?.dropped ? { unmatchedDropped: snapshot.unmatched.dropped } : {}),
  }
}

/** PreviewSummary → 面板 wire 投影：能力缺口压平为 name/status/reason，其余字段原样（仍是同一事实源）。 */
function panelPreview(value: PreviewSummary): PanelPreview {
  return {
    previewId: value.previewId, projectId: value.projectId, targetId: value.targetId,
    scope: value.scope, strategy: value.strategy, state: value.state, freshness: value.freshness,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.scenario === undefined ? {} : { scenario: value.scenario }),
    capabilityGaps: value.capabilityGaps.map(gap => ({ name: gap.name, status: gap.capability.status, ...(gap.capability.reason === undefined ? {} : { reason: gap.capability.reason }) })),
    readiness: value.readiness,
    ...(value.unmatchedCount === undefined ? {} : { unmatchedCount: value.unmatchedCount }),
    ...(value.unmatchedDropped === undefined ? {} : { unmatchedDropped: value.unmatchedDropped }),
  }
}

/** TargetSelector → 面板摘要文本（只含选择器自身字段，不读文件内容）；限长防 schema 截断。 */
function selectorLabel(selector: Candidate['selector']): string {
  const raw = selector.kind === 'file'
    ? selector.path + (selector.exportName === undefined ? '' : '#' + selector.exportName)
    : selector.kind === 'route' ? selector.path
      : selector.kind === 'url' ? selector.url : selector.id
  return raw.length > 500 ? raw.slice(0, 497) + '...' : raw
}

/** 本轮影响分析结果 → status 的 suggestions 字段；结果缺失（未分析）时两个字段都不出现。 */
function suggestionFields(impact: ImpactResult | undefined)
  : { suggestions?: Candidate[]; suggestionsOmitted?: number } {
  if (impact === undefined) return {}
  return {
    suggestions: impact.candidates.slice(0, 3),
    ...(impact.omitted > 0 ? { suggestionsOmitted: impact.omitted } : {}),
  }
}

/** 诊断消息内的降级说明限条/限长，避免把路径清单塞满输出预算。 */
function truncate(text: string, maxItems: number): string {
  const parts = text.split('; ').filter(Boolean)
  return parts.slice(0, maxItems).join('; ') + (parts.length > maxItems ? '; …' : '')
}

function validId(value: unknown): boolean { return value === undefined || typeof value === 'string' && value.trim().length > 0 }
/** 按来源预览给诊断盖章，多预览平铺后仍可区分归属。 */
function withPreview(value: Diagnostic, previewId: string): Diagnostic { return { ...value, previewId } }
function diagnostic(code: string, phase: Diagnostic['phase'], message: string, hint: string): Diagnostic { return { code, phase, message, hint } }
function invalid(phase: Diagnostic['phase']): ToolResultBase {
  return { status: 'error', diagnostics: [diagnostic(DiagnosticCode.configInvalid, phase, 'Invalid preview operation arguments', phase === 'stop' ? 'Use a non-empty previewId or all: true; do not combine both' : 'Use a non-empty previewId and boolean optional flags')] }
}
