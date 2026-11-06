/** 已有服务的只读计划（方案 §6.1、§6.6、§7.4、§8）；不发 HTTP，不读取源码映射或推断执行授权。 */
import { DiagnosticCode } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { serviceUrls } from '../../shared/service-url.ts'
import type { CapabilitySet, Diagnostic, PreviewPlan } from '../../shared/contracts.ts'
import type { ResolvedTarget } from '../../core/target/resolve.ts'
import type { AdapterContext, AdapterPlanOptions, AdapterPlanOutcome } from '../types.ts'

const unknown = { status: 'unknown', source: 'none', reason: 'The existing document and its carrier are not controlled or instrumented' } as const
const unsupported = { status: 'unsupported', source: 'adapter', reason: 'Attach observes the original service and does not modify it' } as const
export function existingServerCapabilities(): CapabilitySet {
  const page = { status: 'supported', source: 'adapter', coverage: ['Unmodified navigation URL at an explicitly configured local origin; rendering remains unverified'] } as const
  return {
    scopes: { page: { ...page, coverage: [...page.coverage] }, shell: { ...page, coverage: [...page.coverage] }, component: unsupported }, isolatedRender: unsupported,
    scenarioApply: unsupported, scenarioReset: unsupported,
    refresh: { status: 'conditional', source: 'carrier', mode: 'manual', conditions: ['Reload the actual displayed page; HMR and Client refresh are not controlled'] },
    captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unsupported,
    network: (['browser-http', 'browser-ws', 'browser-sse', 'service-worker', 'dev-server-proxy', 'build-process', 'server-process'] as const).map(channel => ({ channel, control: 'none', location: 'none', note: 'Uncontrolled existing service/page; requests may use real data. No user service, browser state or response is changed.' })),
  }
}

/** 文件只有显式 route 映射才可导航；不凭文件名猜服务路由。 */
export function attachmentUrls(ctx: AdapterContext, target: ResolvedTarget, route?: PreviewPlan['route']): { origin: string, url: string, probe: string } {
  return serviceUrls(ctx.config.project.runtime.origin ?? '', target.selector, route ?? target.route, ctx.config.project.runtime.readiness?.probePath)
}

export async function planExistingServer(ctx: AdapterContext, target: ResolvedTarget, scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome> {
  const runtime = ctx.config.project.runtime
  const route = options?.route ?? target.route
  const missing: Diagnostic[] = []
  const issue = (code: string, message: string) => missing.push({ code, phase: 'plan', message, hint: 'Provide an explicit local origin and route in an authorized observation configuration; do not relax requirements automatically' })
  if (runtime.command || runtime.env !== undefined || runtime.setup || Object.values(ctx.config.project.scenarios ?? {}).some(value => value.handlers)) issue(DiagnosticCode.configChangedNeedsApproval, 'Attach cannot execute initialization or change the existing service environment')
  if (runtime.entry || runtime.styles?.length || runtime.publicRoot !== undefined || runtime.spaFallback !== undefined || scenario || ctx.config.project.targets?.find(value => value.id === target.targetId)?.assertions?.length) issue(DiagnosticCode.unsupportedCapability, 'Attach cannot apply static bindings, scenarios or target assertions')
  if (target.scope === 'component' || target.selector.kind === 'story' || target.selector.kind === 'registered' || target.selector.kind === 'file' && target.selector.exportName !== undefined) issue(DiagnosticCode.unsupportedCapability, 'Attach requires a full document URL/route or an explicit file-to-route mapping')
  const requirements = [...(options?.requirements ?? runtime.requirements ?? ['mock-only'])]
  if (requirements.length) issue(DiagnosticCode.requirementUnsatisfied, 'Attach provides no isolated rendering or data boundary; explicit observation requirements must be empty')
  let urls: ReturnType<typeof attachmentUrls> | undefined
  try { urls = attachmentUrls(ctx, target, route) }
  catch { issue(DiagnosticCode.configInvalid, 'Invalid/missing configured local source, concrete route or probe path') }
  // 视口是载体能力终态（§4.2 unsupported）：与其余缺失并列返回，不用近似尺寸冒充。
  if (options?.viewport) return { kind: 'unsupported', reason: 'Attach observes a foreign service and cannot control its carrier viewport; the requested size is never silently approximated', missing }
  if (missing.length || !urls) return { kind: 'missing', missing }
  return { kind: 'plan', plan: {
    projectId: target.projectId, targetId: target.targetId, selector: structuredClone(target.selector), scope: target.scope, strategy: 'attach',
    adapter: { id: 'existing-server', version: '0.0.0' }, toolchain: {}, requirements,
    ...(route ? { route: structuredClone(route) } : {}),
    process: { kind: 'attach', origin: urls.origin },
    readiness: { serviceDeadlineMs: runtime.readiness?.serviceDeadlineMs ?? 5000, targetDeadlineMs: runtime.readiness?.targetDeadlineMs ?? 5000 },
    capabilities: existingServerCapabilities(), fingerprints: { config: fingerprintJson(ctx.config.project) }, missing: [],
    knownDifferences: ['Existing browser/service data and all network channels are uncontrolled; real backend access is possible', 'No response injection, proxy, browser login state copy or state reset is performed', 'Target rendering, source freshness, embed headers, authentication and HMR are unverified', 'Service reachability is checked by a credential-free GET with no redirects; stop only detaches'],
  } }
}
