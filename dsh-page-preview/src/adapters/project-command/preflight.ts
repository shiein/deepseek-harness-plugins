/** 项目命令的只读计划（方案 §6.1、§6.5、§8）；不试跑脚本、不加载构建配置、不根据命令名猜安全性。 */
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import { DiagnosticCode } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { serviceUrls } from '../../shared/service-url.ts'
import type { CapabilitySet, Diagnostic } from '../../shared/contracts.ts'
import type { ResolvedTarget } from '../../core/target/resolve.ts'
import type { AdapterContext, AdapterPlanOptions, AdapterPlanOutcome } from '../types.ts'

export function projectCommandCapabilities(): CapabilitySet {
  const unknown = { status: 'unknown', source: 'none', reason: 'The original project service/document is not instrumented' } as const
  const unsupported = { status: 'unsupported', source: 'adapter', reason: 'Generic project commands do not isolate or initialize a business target' } as const
  const page = { status: 'supported', source: 'adapter', coverage: ['Original project document at an owned, verified loopback service; rendering remains unverified'] } as const
  return {
    scopes: { page: { ...page, coverage: [...page.coverage] }, shell: { ...page, coverage: [...page.coverage] }, component: unsupported },
    isolatedRender: unsupported, scenarioApply: unsupported, scenarioReset: unsupported,
    refresh: { status: 'conditional', source: 'carrier', mode: 'manual', conditions: ['Reload the actual document; project HMR is not verified or controlled'] },
    captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unsupported,
    network: (['browser-http', 'browser-ws', 'browser-sse', 'service-worker', 'dev-server-proxy', 'build-process', 'server-process'] as const).map(channel => ({ channel, control: 'none', location: 'none', note: 'No data proxy or process sandbox; project code and its original page may access real files/services' })),
  }
}

export async function planProjectCommand(ctx: AdapterContext, target: ResolvedTarget, scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome> {
  const runtime = ctx.config.project.runtime
  const readiness = runtime.readiness
  const route = options?.route ?? target.route
  const requirements = [...(options?.requirements ?? runtime.requirements ?? ['mock-only'])]
  const missing: Diagnostic[] = []
  const issue = (code: string, message: string) => missing.push({ code, phase: 'plan', message, hint: 'Configure an explicit executable/args/cwd, health probe and authorized observation requirements; do not infer or install a command' })
  if (!runtime.command) issue(DiagnosticCode.configInvalid, 'An explicit project preview command is required')
  if (!runtime.readiness?.probePath || !runtime.readiness.serviceDeadlineMs) issue(DiagnosticCode.configInvalid, 'Project commands require a service probe and startup deadline')
  if (requirements.length) issue(DiagnosticCode.requirementUnsatisfied, 'This original project service has no isolated render or verified data boundary')
  if (runtime.setup || Object.values(ctx.config.project.scenarios ?? {}).some(value => value.handlers) || runtime.entry || runtime.styles?.length || runtime.publicRoot !== undefined || runtime.spaFallback !== undefined || scenario || ctx.config.project.targets?.find(value => value.id === target.targetId)?.assertions?.length) issue(DiagnosticCode.unsupportedCapability, 'Generic project initialization/scenarios/static bindings/assertions are not implemented')
  if (target.scope === 'component' || ['story', 'registered'].includes(target.selector.kind) || target.selector.kind === 'file' && target.selector.exportName !== undefined) issue(DiagnosticCode.unsupportedCapability, 'Project command navigation requires a document route/URL or an explicitly mapped source file')
  if (target.selector.kind === 'url' && !runtime.origin) issue(DiagnosticCode.configInvalid, 'A URL target requires its configured local origin')
  // 无固定来源时这里只校验路由语法；该锚点不进入计划或作为真实 URL 返回。
  try { serviceUrls(runtime.origin ?? 'http://127.0.0.1', target.selector, route, runtime.readiness?.probePath) }
  catch { issue(DiagnosticCode.configInvalid, 'A concrete local route/source/probe is required and must not conflict with the target') }
  let cwd: string | undefined
  if (runtime.command) {
    try {
      cwd = await resolveProjectPath(ctx.appRoot, runtime.command.cwd, runtime.dependencyRoots)
      if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory')
    } catch { issue(DiagnosticCode.configInvalid, 'Command cwd must resolve to an existing allowed directory') }
    if (isAbsolute(runtime.command.executable)) {
      try {
        if (!(await stat(runtime.command.executable)).isFile()) throw new Error('Not a file')
        await access(runtime.command.executable, constants.X_OK)
      } catch { issue(DiagnosticCode.dependencyMissing, 'The explicit preview executable is missing or cannot be executed; no dependency was installed') }
    }
  }
  // 视口是载体能力终态（§4.2 unsupported）：与其余缺失并列返回，不用近似尺寸冒充。
  if (options?.viewport) return { kind: 'unsupported', reason: 'Carrier viewport control is not implemented on the managed project path; the requested size is never silently approximated', missing }
  if (missing.length || !runtime.command || !cwd || !readiness?.probePath || !readiness.serviceDeadlineMs) return { kind: 'missing', missing }
  return { kind: 'plan', plan: {
    projectId: target.projectId, targetId: target.targetId, selector: structuredClone(target.selector), scope: target.scope, strategy: 'project',
    adapter: { id: 'project-command', version: '0.0.0' }, toolchain: {}, requirements,
    ...(route ? { route: structuredClone(route) } : {}),
    process: { kind: 'managed', executable: runtime.command.executable, args: [...runtime.command.args], cwd, ...(runtime.env === undefined ? {} : { env: { ...runtime.env } }) },
    readiness: { serviceDeadlineMs: readiness.serviceDeadlineMs, targetDeadlineMs: readiness.targetDeadlineMs ?? 5000 },
    capabilities: projectCommandCapabilities(), fingerprints: { config: fingerprintJson(ctx.config.project) }, missing: [],
    knownDifferences: ['Only an explicitly user-approved execution fingerprint may start; no Host environment is inherited', 'Original project code can read files/environment and use real backends; no proxy or process sandbox is provided', 'Document rendering, source freshness, HMR and compilation/runtime diagnostics are unverified', 'Raw command output is not forwarded because it can contain credentials', ...(runtime.origin ? ['The configured origin must be owned by this command; no silent port/origin substitution'] : ['A single owned loopback HTTP port must be discovered; several listeners require an explicit origin'])],
  } }
}
