/** 静态只读预检/发现（方案 §5.2、§6.1、§6.2、§6.8）；只读原文件，不启动服务或执行模块。 */
import { createHash } from 'node:crypto'
import { opendir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import type { AdapterContext, AdapterPlanOptions, AdapterPlanOutcome, DiscoverResult, ProbeResult } from '../types.ts'
import type { ResolvedTarget } from '../../core/target/resolve.ts'
import type { CapabilitySet, Diagnostic, PreviewPlan } from '../../shared/contracts.ts'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { findStaticDocument, findStaticFile } from '../../shared/static-files.ts'
import { localRoute } from '../../shared/route.ts'
import { parseHtmlSource } from '../../shared/html.ts'
import { parseScriptSource } from '../../shared/javascript.ts'
import { inspectScenarioFixtures } from '../../scenario/preflight.ts'
import { detectProjectMocks, describeProjectMocks } from '../../core/profile/project-mocks.ts'

const unknown = { status: 'unknown', source: 'none', reason: 'Current carrier integration is not verified' } as const
const unsupported = { status: 'unsupported', source: 'adapter', reason: 'Static documents do not provide this operation' } as const
export function staticCapabilities(metaCsp = false, fixtures = false): CapabilitySet {
  const document = { status: 'supported', source: 'adapter', coverage: ['Original HTML document and owned static resources'] } as const
  return {
    scopes: { page: { ...document, coverage: [...document.coverage] }, shell: { ...document, coverage: [...document.coverage] }, component: unsupported },
    isolatedRender: unsupported, scenarioApply: { status: 'supported', source: 'response-layer', coverage: ['Initial declared same-origin HTTP fixtures/body files only; no browser initialization or identity/storage reset'] }, scenarioReset: unsupported,
    refresh: { status: 'conditional', source: 'carrier', mode: 'manual', conditions: ['Reload the actual displayed document; Client refresh is not connected'] },
    captureCurrentView: unknown,
    runtimeErrors: metaCsp ? { status: 'conditional', source: 'response-layer', conditions: ['The document meta CSP must permit reporter delivery'] } : { status: 'supported', source: 'response-layer', coverage: ['Window errors, unhandled rejection and CSP reports from owned responses'] },
    readinessAssertion: metaCsp ? { status: 'conditional', source: 'response-layer', conditions: ['Document meta CSP must permit bootstrap/report delivery'] } : { status: 'supported', source: 'response-layer', coverage: ['Initial target document visible selectors and body.innerText assertions; bounded target deadline'] },
    network: [
      ...(['browser-http', 'browser-ws', 'browser-sse', 'service-worker'] as const).map(channel => ({ channel, control: channel === 'browser-http' && fixtures ? 'mock' as const : 'block' as const, location: 'response-layer' as const, note: 'CSP plus explicit unmatched errors; HTTP fixtures cover only declared same-origin paths; verified product static path in Chrome 156, native carrier compatibility requires acceptance' })),
      { channel: 'build-process', control: 'none', location: 'none', note: 'No project build process is started' },
      { channel: 'server-process', control: 'none', location: 'none', note: 'Only the plugin static server runs; no business server or proxy is executed' },
    ],
  }
}

async function publicRoot(ctx: AdapterContext): Promise<string> {
  const root = await resolveProjectPath(ctx.appRoot, ctx.config.project.runtime.publicRoot ?? '.', ctx.config.project.runtime.dependencyRoots)
  if (!(await stat(root)).isDirectory()) throw new Error('Static publicRoot must be a directory')
  return root
}
function pathFromFile(root: string, file: string): string { return '/' + relative(root, file).split(sep).map(encodeURIComponent).join('/') }

export async function discoverStatic(ctx: AdapterContext): Promise<DiscoverResult> {
  const root = await publicRoot(ctx)
  const directories = [root]
  const candidates: DiscoverResult['candidates'] = []
  let entries = 0
  while (directories.length && entries < 5000) {
    for await (const entry of await opendir(directories.shift()!)) {
      if (++entries > 5000) break
      if (entry.name.startsWith('.') || ['node_modules', 'output', 'coverage', 'dist', 'build', 'lib'].includes(entry.name)) continue
      const file = join(entry.parentPath, entry.name)
      if (entry.isDirectory()) directories.push(file)
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) candidates.push({ projectId: ctx.config.project.id, selector: { kind: 'file', path: relative(ctx.appRoot, file) }, relation: ['Existing HTML entry within publicRoot'], evidence: 'strong' })
    }
  }
  return { candidates, manualOnly: true, unresolved: ['Runtime-computed dependencies require a running page', ...(entries >= 5000 ? ['Static discovery reached its 5000-entry budget'] : [])] }
}

export async function probeStatic(ctx: AdapterContext, target?: ResolvedTarget): Promise<ProbeResult> {
  const selector = target?.selector
  const matched = selector ? selector.kind === 'route' || selector.kind === 'file' && /\.html?$/i.test(selector.path) : (await discoverStatic(ctx)).candidates.length > 0
  return { matched, capabilities: staticCapabilities(), evidence: matched ? ['Concrete HTML/local route candidate; plan validates resources before execution'] : [], limits: ['No compilation, component isolation, browser scene initialization or automatic carrier reload'] }
}

export async function planStatic(ctx: AdapterContext, target: ResolvedTarget, scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome> {
  const missing: Diagnostic[] = []
  const issue = (code: string, message: string, file?: string) => missing.push({ code, phase: 'plan', message, hint: 'Use original browser-ready files or explicitly configure a supported build/initialization path', ...(file ? { location: { file } } : {}) })
  const runtime = ctx.config.project.runtime
  const definition = ctx.config.project.targets?.find(value => value.id === target.targetId)
  const requested = target.selector
  const selector = requested.kind === 'registered' ? ctx.config.project.targets?.find(value => value.id === requested.id)?.selector : requested
  if (!selector || !['file', 'route'].includes(selector.kind) || target.scope === 'component') issue(DiagnosticCode.unsupportedCapability, 'Static preview needs a document file or concrete local route, not a component/story/URL')
  if (runtime.command || runtime.env !== undefined || runtime.setup || Object.values(ctx.config.project.scenarios ?? {}).some(value => value.handlers)) issue(DiagnosticCode.configChangedNeedsApproval, 'Static execution bindings require an approved and implemented initialization path')
  if (runtime.entry || runtime.styles?.length) issue(DiagnosticCode.unsupportedCapability, 'Static extra initialization is not connected')
  const scenes = ctx.config.project.scenarios ?? {}
  const scene = scenario === undefined || !Object.hasOwn(scenes, scenario) ? undefined : scenes[scenario]
  let fixtureFiles = new Map<string, string>()
  if (scenario !== undefined) {
    if (!scene) issue(DiagnosticCode.configInvalid, 'Requested static scenario was not configured')
    else {
      if (['identity', 'permissions', 'state', 'props', 'locale'].some(key => Object.hasOwn(scene, key))) issue(DiagnosticCode.unsupportedCapability, 'Static browser scenario data needs an implemented explicit initialization binding; no fields were silently ignored')
      // R5-1g：static 无 Upgrade 通道——声明的 ws 通道如实拒绝，不静默忽略；sse 经共享 Mock 层已接通。
      if (scene.ws?.length) issue(DiagnosticCode.unsupportedCapability,
        'Declared ws fixtures need a preview worker with an Upgrade channel; static has none')
      try { fixtureFiles = await inspectScenarioFixtures(ctx.appRoot, scene, runtime.dependencyRoots) }
      catch (error) { if (error instanceof RunnerSessionError) missing.push(error.diagnostic); else throw error }
    }
  }
  if (selector?.kind === 'file' && (selector.exportName !== undefined || options?.route || definition?.route)) issue(DiagnosticCode.unsupportedCapability, 'Static file export/navigation binding is not implemented')
  // 视口是载体能力终态（§4.2 unsupported）：与其余缺失并列返回，不用近似尺寸冒充。
  if (options?.viewport) return { kind: 'unsupported', reason: 'Static carrier viewport control is not connected; the requested size is never silently approximated', missing }
  if (missing.length) return { kind: 'missing', missing }
  const root = await publicRoot(ctx)
  let pathname: string
  if (selector?.kind === 'file') {
    const file = await resolveProjectPath(ctx.appRoot, selector.path, runtime.dependencyRoots)
    if (!isWithinRoot(root, file)) return { kind: 'missing', missing: [problem('Static target is outside publicRoot')] }
    pathname = pathFromFile(root, file)
  } else if (selector?.kind === 'route') pathname = localRoute(selector).pathname
  else return { kind: 'missing', missing: [problem('Static document selector is required')] }
  const initial = await findStaticDocument(root, pathname, runtime.spaFallback === true, true)
  if (!initial || !/\.html?$/i.test(initial)) return { kind: 'missing', missing: [problem('Static target must resolve to an existing HTML document')] }
  const files: Record<string, string> = {}
  for (const [path, digest] of fixtureFiles) files['fixture:' + path] = digest
  const documentUrl = selector?.kind === 'route' ? localRoute(selector) : new URL(pathFromFile(root, initial), 'http://preview.invalid')
  const queue = [{ file: initial, url: documentUrl }]
  const visited = new Set<string>()
  const differences = ['Only target-document browser reports can prove loading and configured initial DOM assertions; source freshness remains unverified', 'No automatic reload or current-view capture; remote resources and non-owned subdocuments are blocked', 'Runtime-computed resources and CSS dependency graphs are not completely resolved by this preflight']
  if (scene) differences.push('Initial HTTP fixtures only; no browser identity/storage reset; explicit business globs: ' + JSON.stringify(scene.businessPaths ?? []))
  let metaCsp = false
  const enqueue = async (value: string, base: URL, kind: 'script' | 'style' | 'asset' | 'frame' | 'module' | 'worker') => {
    if (!value || value.startsWith('#') || kind === 'asset' && /^(data:|blob:)/.test(value)) return
    if (kind === 'module' && !/^[./]|^https?:/.test(value)) { issue(DiagnosticCode.dependencyMissing, 'Bare browser imports require a verified import-map/build path', relative(ctx.appRoot, initial)); return }
    const url = new URL(value, base)
    if (url.origin !== 'http://preview.invalid') { issue(DiagnosticCode.requirementUnsatisfied, 'External static resources are outside the controlled source policy'); return }
    const file = await findStaticFile(root, url.pathname)
    if (!file) { issue(DiagnosticCode.dependencyMissing, 'Declared static resource is missing or cannot be served', url.pathname); return }
    queue.push({ file, url })
  }
  const script = async (file: string, source: string, base: URL) => {
    const parsed = parseScriptSource(file, source)
    if (parsed.invalid || parsed.jsx || parsed.typescript) issue(DiagnosticCode.unsupportedCapability, 'Static scripts must be valid browser JavaScript; JSX/TypeScript requires compilation', relative(ctx.appRoot, file))
    for (const reference of parsed.references) await enqueue(reference.value, base, reference.kind)
  }
  while (queue.length && visited.size < 2000) {
    const item = queue.shift()!
    const key = item.file + '\0' + item.url.href
    if (visited.has(key)) continue
    visited.add(key)
    const data = await readFile(item.file)
    files[relative(root, item.file)] = createHash('sha256').update(data).digest('hex')
    const extension = extname(item.file).toLowerCase()
    if (['.html', '.htm'].includes(extension)) {
      const html = parseHtmlSource(data.toString('utf8'))
      metaCsp ||= html.metaCsp
      const base = html.base === undefined ? item.url : new URL(html.base, item.url)
      if (base.origin !== 'http://preview.invalid') issue(DiagnosticCode.requirementUnsatisfied, 'An external HTML base is not supported by the owned static path')
      for (const reference of html.references) await enqueue(reference.value, base, reference.kind)
      for (const inline of html.inlineScripts) await script(item.file + '.js', inline.source, base)
    } else if (['.js', '.mjs'].includes(extension)) await script(item.file, data.toString('utf8'), item.url)
  }
  if (queue.length) differences.push('Source graph reached its 2000-file budget; the source fingerprint is partial')
  if (options?.viewport) return { kind: 'unsupported', reason: 'Static carrier viewport control is not connected; the requested size is never silently approximated', missing }
  if (missing.length) return { kind: 'missing', missing }
  // R3-3：项目已有 Mock 只读识别——证据进 knownDifferences，一条非阻断信息性诊断随计划提交。
  const projectMocks = describeProjectMocks(await detectProjectMocks(ctx.appRoot))
  differences.push(...projectMocks.knownDifferences)
  const plan: PreviewPlan = {
    projectId: target.projectId, targetId: target.targetId, selector: structuredClone(target.selector), scope: target.scope, strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: [...(options?.requirements ?? runtime.requirements ?? ['mock-only'])],
    ...(options?.route ? { route: structuredClone(options.route) } : {}), ...(scenario === undefined ? {} : { scenario }), process: { kind: 'in-runner' },
    readiness: { serviceDeadlineMs: runtime.readiness?.serviceDeadlineMs ?? 5000, targetDeadlineMs: runtime.readiness?.targetDeadlineMs ?? 5000, ...(definition?.assertions?.length ? { assertions: structuredClone(definition.assertions) } : {}) },
    capabilities: staticCapabilities(metaCsp, Boolean(scene?.http?.length)), fingerprints: { config: fingerprintJson(ctx.config.project), sources: fingerprintJson(files), ...(scene ? { scenario: fingerprintJson({ scene, files: Object.fromEntries(fixtureFiles) }) } : {}) }, missing: [], knownDifferences: differences,
  }
  return { kind: 'plan', plan, ...(projectMocks.diagnostics.length ? { diagnostics: projectMocks.diagnostics } : {}) }
}
function problem(message: string): Diagnostic {
  return { code: DiagnosticCode.targetNotReady, phase: 'plan', message,
    hint: 'Static previews only serve existing HTML files under publicRoot. For a single-page-app route, retry '
      + 'page_preview_open with target {"kind": "file", "path": "<page component file, e.g. src/views/x/index.vue>"} '
      + 'so the framework adapter renders it; otherwise pass an existing .html file' }
}
