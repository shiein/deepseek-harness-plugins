/**
 * 执行计划与预检（方案 §6.1、§6.2、§4.2 默认 mock-only 表）。
 * 不执行项目代码；需要执行才能确认的能力保留 unknown。缺包只报告，不自动安装。
 */

import type { Diagnostic, NetworkCoverage, PreviewPlan, Requirement, Strategy, StrategyRequest, Viewport } from '../../shared/contracts.ts'
import { DiagnosticCode } from '../../shared/errors.ts'
import { previewPlanSchema } from '../../shared/plan-schema.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import type { Adapter, SetupDraftPayload } from '../../adapters/types.ts'
import type { EffectiveProjectConfig } from '../../shared/config/loader.ts'
import {
  collectExecutionItems,
  executionFingerprint,
  requiresExecutionApproval,
  runsProjectBuildConfig,
} from '../../shared/config/fingerprint.ts'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import type { AppProfile } from '../../shared/profile.ts'
import type { ResolvedTarget } from '../target/resolve.ts'

/** 无配置时的默认约束（§4.2）。 */
export const DEFAULT_REQUIREMENTS: readonly Requirement[] = ['mock-only']

/**
 * 默认 mock-only 在各路径上能否在浏览器侧成立（§4.2 表）。
 * project 需配置 Mock 路径或插件前置代理；attach 只能显式观察模式。
 */
export function mockOnlyAchievableByDefault(strategy: Strategy): boolean {
  switch (strategy) {
    case 'static':
    case 'isolated':
      return true
    case 'project':
    case 'attach':
      return false
  }
}

export type PlanOutcome =
  // executionFingerprint：批准门禁通过时的执行项指纹；Host 随 start 消息发给 Runner（R2-1）。
  | { kind: 'plan'; plan: PreviewPlan; executionFingerprint?: string; diagnostics?: Diagnostic[] }
  | { kind: 'needs-configuration'; plan?: Partial<PreviewPlan>; missing: PreviewPlan['missing']; setupDraft?: SetupDraftPayload }
  | { kind: 'unsupported'; reason: string; diagnostics?: Diagnostic[]; setupDraft?: SetupDraftPayload; alternatives?: Strategy[] }

export interface PlanInput {
  workspaceRoot: string
  config: EffectiveProjectConfig
  profile: AppProfile
  target: ResolvedTarget
  strategy: StrategyRequest
  requirements?: Requirement[]
  scenario?: string
  viewport?: Viewport
  /** 一次性授权门禁：批准只存于 Host 内存（grants + 刚批准的指纹），不落盘。 */
  approvals?: { isApproved(workspaceRoot: string, projectId: string, fingerprint: string): Promise<boolean> }
  adapters: readonly Pick<Adapter, 'id' | 'version' | 'strategies' | 'probe' | 'plan'>[]
}

/** 只做预检；选定路径的 plan 失败即返回，不通过试运行或换策略隐藏失败。 */
export async function buildPlan(input: PlanInput): Promise<PlanOutcome> {
  const { config, target } = input
  const runtime = config.project.runtime
  if (target.projectId !== config.project.id) return missing(DiagnosticCode.configInvalid, 'Target and configuration belong to different applications')
  const saved = runtime.requirements ?? [...DEFAULT_REQUIREMENTS]
  const requirements = input.requirements === undefined ? [...saved] : [...input.requirements]
  if (new Set(requirements).size !== requirements.length) return missing(DiagnosticCode.configInvalid, 'Duplicate requirements are not allowed')
  if (saved.some(value => !requirements.includes(value))) return missing(DiagnosticCode.requirementUnsatisfied, 'The request would relax saved/default requirements; explicit user approval is required')
  const definition = config.project.targets?.find(value => value.id === target.targetId)
  const scenario = input.scenario ?? definition?.defaultScenario
  if (scenario !== undefined && !Object.hasOwn(config.project.scenarios ?? {}, scenario)) return missing(DiagnosticCode.configInvalid, 'The selected scenario is not configured')
  const route = target.selector.kind === 'route' ? { path: target.selector.path, ...(target.selector.params ? { params: target.selector.params } : {}), ...(target.selector.query ? { query: target.selector.query } : {}) } : target.route ?? (scenario === undefined ? undefined : config.project.scenarios?.[scenario]?.route)
  const appRoot = await resolveProjectPath(input.workspaceRoot, config.project.root)
  if (await resolveProjectPath(input.workspaceRoot, input.profile.root) !== appRoot) return missing(DiagnosticCode.configInvalid, 'Application profile and configuration refer to different roots')
  const context = { workspaceRoot: input.workspaceRoot, appRoot, config, profile: input.profile }
  const strategy = input.strategy !== 'auto' ? input.strategy : runtime.strategy ?? (runtime.command ? 'project' : runtime.origin ? 'attach' : undefined)
  const candidates: Array<{ adapter: PlanInput['adapters'][number]; strategy: Strategy }> = []
  for (const adapter of input.adapters) {
    if (runtime.adapter !== undefined && runtime.adapter !== adapter.id || strategy !== undefined && !adapter.strategies.includes(strategy)) continue
    const probe = await adapter.probe(context, target)
    if (!probe.matched) continue
    const chosen = strategy ?? (adapter.strategies.length === 1 ? adapter.strategies[0] : undefined)
    if (!chosen) return missing(DiagnosticCode.configInvalid, 'The matching adapter needs an explicit strategy')
    // 无绑定 auto 的初选仅排除明确不能满足的候选，未知能力留给完整计划诊断。
    if (input.strategy === 'auto' && !runtime.adapter && !strategy && (probe.capabilities.scopes?.[target.scope]?.status === 'unsupported' || requirements.includes('isolated-target') && probe.capabilities.isolatedRender?.status === 'unsupported')) continue
    candidates.push({ adapter, strategy: chosen })
  }
  if (!candidates.length) return { kind: 'unsupported', reason: 'No registered adapter matches the requested strategy and application without changing requirements' }
  const order: Strategy[] = ['static', 'isolated', 'project', 'attach']
  candidates.sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy))
  const selected = candidates[0]!
  if (candidates[1]?.strategy === selected.strategy) return missing(DiagnosticCode.ambiguousTarget, 'Several adapters match this application; configure one adapter explicitly')
  const outcome = await selected.adapter.plan(context, structuredClone(target), scenario, { requirements, ...(input.viewport ? { viewport: { ...input.viewport } } : {}), ...(route ? { route: structuredClone(route) } : {}) })
  // 适配器显式终态（如载体视口）如实透传；其余可配置缺失与草稿并行展示，互不吞并。
  if (outcome.kind === 'unsupported') return { kind: 'unsupported', reason: outcome.reason, ...(outcome.missing?.length ? { diagnostics: outcome.missing } : {}), ...(outcome.setupDraft === undefined ? {} : { setupDraft: outcome.setupDraft }) }
  if (outcome.kind === 'missing') return { kind: 'needs-configuration', missing: outcome.missing, ...(outcome.setupDraft === undefined ? {} : { setupDraft: outcome.setupDraft }) }
  const parsed = previewPlanSchema.safeParse(outcome.plan)
  if (!parsed.success) return missing(DiagnosticCode.configInvalid, 'Adapter returned an invalid execution plan')
  const plan = parsed.data
  const contradicts = plan.projectId !== target.projectId || plan.targetId !== target.targetId
    || fingerprintJson(plan.selector) !== fingerprintJson(target.selector)
    || plan.scope !== target.scope || plan.strategy !== selected.strategy
    || plan.adapter.id !== selected.adapter.id || plan.adapter.version !== selected.adapter.version
    || plan.scenario !== scenario || plan.fingerprints.config !== fingerprintJson(config.project)
    || fingerprintJson([...plan.requirements].sort()) !== fingerprintJson([...requirements].sort())
    || input.viewport && (!plan.viewport || fingerprintJson(input.viewport) !== fingerprintJson(plan.viewport))
    || fingerprintJson(route ?? null) !== fingerprintJson(plan.route ?? null)
  if (contradicts) return missing(DiagnosticCode.configInvalid, 'Adapter plan contradicts the selected target, route, strategy, scenario, requirements or configuration')
  if (plan.strategy === 'project' ? plan.process.kind !== 'managed' : plan.strategy === 'attach' ? plan.process.kind !== 'attach' : plan.process.kind !== 'in-runner') return missing(DiagnosticCode.configInvalid, 'Adapter process ownership does not match the selected strategy')
  if (definition?.assertions?.some(assertion => !plan.readiness.assertions?.some(value => fingerprintJson(value) === fingerprintJson(assertion)))) return missing(DiagnosticCode.configInvalid, 'Adapter plan omitted a configured target assertion')
  if (plan.missing.length) return { kind: 'needs-configuration', plan, missing: plan.missing }
  // §0.3 第 1 条：未验证（unknown）不是阻断理由；只有明确的 unsupported 才拒绝所选路径。
  // 声称 supported 却无证据来源或覆盖面的计划属于无效声明，同样不能放行。
  const scope = plan.capabilities.scopes[target.scope]
  if (scope?.status === 'unsupported') return { kind: 'unsupported', reason: 'The selected path cannot provide the requested scope' }
  if (scope?.status === 'supported' && (scope.source === 'none' || !scope.coverage?.length)) return missing(DiagnosticCode.configInvalid, 'Adapter declared supported scope without evidence source or coverage', plan)
  if (scenario !== undefined) {
    const apply = plan.capabilities.scenarioApply
    if (apply.status === 'unsupported') return { kind: 'unsupported', reason: 'The selected path cannot apply the requested scenario' }
    if (apply.status === 'supported' && (apply.source === 'none' || !apply.coverage?.length)) return missing(DiagnosticCode.configInvalid, 'Adapter declared supported scenario application without evidence source or coverage', plan)
  }
  if (requirements.includes('isolated-target')) {
    const isolated = plan.capabilities.isolatedRender
    if (isolated.status === 'unsupported') return { kind: 'unsupported', reason: 'The selected path cannot independently render the requested target' }
    if (isolated.status === 'supported' && (isolated.source === 'none' || !isolated.coverage?.length)) return missing(DiagnosticCode.requirementUnsatisfied, 'Isolated target rendering is claimed without evidence on this path', plan)
  }
  if (requirements.includes('mock-only')) {
    const channels = ['browser-http', 'browser-ws', 'browser-sse', 'service-worker'] as const
    const required: NetworkCoverage['channel'][] = [...channels]
    if (plan.strategy === 'project') required.push('dev-server-proxy', 'server-process')
    else if (scenario !== undefined && config.project.scenarios?.[scenario]?.handlers) required.push('server-process')
    if (plan.strategy === 'attach' || required.some(channel => {
      const coverage = plan.capabilities.network.filter(value => value.channel === channel)
      return !coverage.length || coverage.some(value => !['mock', 'block'].includes(value.control) || value.location === 'none')
    })) return missing(DiagnosticCode.requirementUnsatisfied, 'Business data control is incomplete for the required browser/server channels', plan)
  }
  // 自动生成的 setup 与配置执行项同审：其摘要并入执行指纹（§0.3 第 10 条）。
  const generated = plan.generatedSetup?.hash
  const items = await collectExecutionItems(appRoot, config.project)
  if (requiresExecutionApproval(config.project, generated, runsProjectBuildConfig(plan.strategy, items))) {
    const fingerprint = executionFingerprint(items, generated)
    if (!await input.approvals?.isApproved(input.workspaceRoot, config.project.id, fingerprint)) return missing(DiagnosticCode.configChangedNeedsApproval, 'Execution items require a user-approved fingerprint before starting', plan)
    return { kind: 'plan', plan, executionFingerprint: fingerprint,
      ...(outcome.diagnostics?.length ? { diagnostics: outcome.diagnostics } : {}) }
  }
  return { kind: 'plan', plan, ...(outcome.diagnostics?.length ? { diagnostics: outcome.diagnostics } : {}) }
}

function missing(code: string, message: string, plan?: PreviewPlan): PlanOutcome {
  const diagnostic: Diagnostic = { code, phase: 'plan', message, hint: 'Configure and verify the missing condition; do not silently change scope, strategy or requirements' }
  return { kind: 'needs-configuration', ...(plan ? { plan } : {}), missing: [diagnostic] }
}
