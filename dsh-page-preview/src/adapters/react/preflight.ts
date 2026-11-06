/** React/Vite 隔离只读预检（方案 §6.2、§6.5、§6.9；R5-7）。仅分析元数据/源码，不调用 start 或加载项目工具链。 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type {
  AdapterContext, AdapterPlanOptions, AdapterPlanOutcome, DiscoverResult, ProbeResult,
  SetupDraftPayload,
} from '../types.ts'
import type { ResolvedTarget } from '../../core/target/resolve.ts'
import type { CapabilitySet, Diagnostic, NetworkCoverage, RefreshMode } from '../../shared/contracts.ts'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import { installedPackageVersion, readProjectText } from '../../shared/profile.ts'
import { parseScriptSource } from '../../shared/javascript.ts'
import { scanProjectFiles } from '../../shared/project-files.ts'
import { detectReactApp } from './detect.ts'
import type { ReactAppInfo } from './detect.ts'
import { parseEntryRegistrations } from './entry-replay.ts'
import { buildGeneratedSetup, generatedSetupNotes, generateSetupDraft } from './generated-setup.ts'
import { missingSetupStyles } from './setup-styles.ts'
import { viteResolvableImport } from '../vite/paths.ts'
import type { EntryReplayResult, RegistrationKind } from './entry-replay.ts'
import type { ReactMajor } from './detect.ts'
import { readReactBuildConfig } from './readonly-config.ts'
import { applyViteEvidence, unverifiedViteFacts } from './vite/profile.ts'
import { inspectScenarioFixtures } from '../../scenario/preflight.ts'
import { resolveHandlerModule } from '../../scenario/handlers.ts'
import { localRoute, matchesRoute } from '../../shared/route.ts'
import { readRouteMap } from './impact/route-map.ts'
import { detectProjectMocks, describeProjectMocks } from '../../core/profile/project-mocks.ts'
import { projectMockEscapes, projectMockFiles, projectMockManifest } from '../vite/project-mock.ts'

type Host = 'vite'
const adapterId = () => 'react-vite'
const moduleFile = (file: string) => /\.[cm]?[jt]sx?$/i.test(file)

/** 浏览器侧通道由自有响应层/准入机制控制（方案 A，§0.3 第 3 条）；Node 侧进程如实保持 none。 */
function reactNetworkCoverage(withFixtures: boolean,
  mocks: { msw: boolean, vitePluginMock: boolean, ws: boolean, sse: boolean }
    = { msw: false, vitePluginMock: false, ws: false, sse: false }): NetworkCoverage[] {
  const owned = (channel: NetworkCoverage['channel'], control: NetworkCoverage['control'],
    note: string): NetworkCoverage => ({ channel, control, location: 'response-layer', note })
  const none = (channel: NetworkCoverage['channel'], note: string): NetworkCoverage =>
    ({ channel, control: 'none', location: 'none', note })
  return [
    owned('browser-http', withFixtures ? 'mock' : 'block',
      'Owned loopback middleware serves declared same-origin fixtures; unmatched business requests '
        + 'fail explicitly instead of reaching real backends'),
    ...(mocks.vitePluginMock ? [{ channel: 'browser-http', control: 'mock', location: 'project',
      note: 'The project vite-plugin-mock runs in the Runner and may answer same-origin paths outside '
        + 'the declared businessPaths; declared paths stay exclusive to the scenario layer'
    } satisfies NetworkCoverage] : []),
    owned('browser-ws', mocks.ws ? 'mock' : 'block', mocks.ws
      ? 'Declared ws fixtures play a fixed same-origin message sequence; undeclared Upgrades are destroyed '
        + 'with a blocked diagnostic'
      : 'Every Upgrade is rejected except the owned same-origin HMR binding'),
    owned('browser-sse', mocks.sse ? 'mock' : 'block', mocks.sse
      ? 'Declared sse fixtures serve a fixed same-origin event stream; undeclared endpoints stay unmatched'
      : 'EventSource endpoints share the owned HTTP admission; unmatched requests fail explicitly'),
    mocks.msw
      ? { channel: 'service-worker' as const, control: 'mock' as const, location: 'project' as const,
        note: 'Project MSW worker may register inside '
        + 'the preview document (headless-Chrome verified, carrier unverified); matched requests are intercepted '
        + 'before the plugin layer sees them' }
      : owned('service-worker', 'block', 'The owned bootstrap hides navigator.serviceWorker unless a project '
        + 'MSW worker is detected'),
    owned('dev-server-proxy', 'block', 'Project dev-server proxying is cleared; nothing is forwarded to real backends'),
    none('build-process', 'Project build configuration executes in the owned worker; '
      + 'its file/env I/O is bounded, not blocked'),
    none('server-process', 'Configured Node handlers execute in the worker without outbound control'),
  ]
}

/** §6.9 v1.4：可生成草稿时把全文与分类项随 missing 返回；原文表达式只进草稿文件，不进诊断。 */
function setupDraftPayload(replay: EntryReplayResult, major: ReactMajor | 'unknown'): SetupDraftPayload | undefined {
  if (replay.invalid || major === 'unknown') return undefined
  const item = (kind: RegistrationKind, source: string, reason?: string) =>
    ({ kind, source, ...(reason === undefined ? {} : { reason }) })
  const parked = 'Business initialization may issue requests or read credentials at module top level; '
    + 'it stays commented in the draft pending review'
  const stuck = 'This registration could not be resolved statically; '
    + 'it stays commented in the draft pending manual setup'
  const replayed = new Set(replay.registrations.filter(value => value.origin !== 'unresolved').map(value => value))
  return {
    source: generateSetupDraft(replay),
    thirdParty: replay.registrations.filter(value => replayed.has(value) && value.origin === 'third-party')
      .map(value => item(value.kind, value.source)),
    business: replay.registrations.filter(value => value.origin === 'business')
      .map(value => item(value.kind, value.source, parked)),
    unresolved: replay.registrations.filter(value => value.origin === 'unresolved')
      .map(value => item(value.kind, value.source, stuck)),
  }
}

/** 入口无法自动成稿时，告诉 Agent React setup 模块的确切形态与后续步骤。 */
function manualSetupHint(entry: string): string {
  return 'Create a new setup module such as preview/setup.js: export default { createContext({ createElement }) { '
    + 'return { wrap: child => createElement(Provider, { store }, child) } } } — copy only the '
    + 'third-party providers (UI kits, store, i18n, query clients) from ' + entry + ', leave out login, '
    + 'API and router-from-backend logic; then add "setup": "preview/setup.js" to the project runtime in '
    + 'page-preview.config.json and retry page_preview_open (the user approves the execution fingerprint)'
}

/** 运行路径接通并经完整样本验收前，候选能力不改为 supported。 */
export function reactCandidateCapabilities(refreshMode: RefreshMode = 'hmr'): CapabilitySet {
  const pending = { status: 'unknown', source: 'adapter',
    reason: 'This combination or operation has no complete implementation and sample evidence' } as const
  const unsupported = { status: 'unsupported', source: 'adapter',
    reason: 'This operation is not connected on the current React path' } as const
  return {
    scopes: { page: pending, component: pending, shell: pending }, isolatedRender: pending,
    scenarioApply: pending, scenarioReset: pending,
    refresh: { ...pending, mode: refreshMode }, captureCurrentView: unsupported,
    runtimeErrors: pending, readinessAssertion: pending,
    network: reactNetworkCoverage(false),
  }
}
async function inspect(ctx: AdapterContext): Promise<ReactAppInfo | undefined> {
  return detectReactApp(ctx.appRoot, { workspaceRoot: ctx.workspaceRoot,
    ...(ctx.config.project.runtime.entry ? { entry: ctx.config.project.runtime.entry } : {}) })
}
export async function probeReact(ctx: AdapterContext, target?: ResolvedTarget): Promise<ProbeResult> {
  const info = await inspect(ctx)
  const requested = target?.selector
  const selector = requested?.kind === 'registered'
    ? ctx.config.project.targets?.find(value => value.id === requested.id)?.selector : requested
  const hostCandidate = info?.buildHost.kind === 'vite'
    || info?.buildHost.kind === 'unknown'
      && ctx.profile.buildTools.some(value => value.value.name === 'vite')
  const matched = info !== undefined && info.buildHost.kind !== 'webpack' && hostCandidate === true
    && !info.isolationExcluded.length && (!selector || selector.kind === 'file' && moduleFile(selector.path))
  return { matched, capabilities: reactCandidateCapabilities(),
    evidence: matched
      ? [...info.evidence, 'Candidate module only; no project configuration or source was executed'] : [],
    limits: [...(info?.unresolved ?? []),
      'Framework helper evidence does not establish this public execution path'] }
}
export async function discoverReact(ctx: AdapterContext): Promise<DiscoverResult> {
  const scan = await scanProjectFiles(ctx.appRoot, 5000)
  const candidates = scan.files.filter(file => /\.[jt]sx$/i.test(file)).sort().map(file => ({
    projectId: ctx.config.project.id,
    selector: { kind: 'file' as const, path: relative(ctx.appRoot, file) },
    relation: ['Existing JSX/TSX module; caller must choose the intended component/page'],
    evidence: 'weak' as const,
  }))
  return { candidates, manualOnly: true,
    unresolved: ['Routes and dependency impact are not inferred by this manual discovery',
      ...(scan.limited ? ['React discovery reached its file budget'] : [])] }
}

export async function planReact(ctx: AdapterContext, target: ResolvedTarget, _host: Host = 'vite',
  scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome> {
  const missing: Diagnostic[] = []
  let setupDraft: SetupDraftPayload | undefined
  const runtime = ctx.config.project.runtime
  const configHint = (field: string, example: string) => 'Add "' + field + '": ' + example + ' under the project '
    + JSON.stringify(ctx.config.project.id) + ' runtime in page-preview.config.json at the workspace root '
    + '(projects[]: {"id": ' + JSON.stringify(ctx.config.project.id) + ', "root": '
    + JSON.stringify(ctx.config.project.root) + ', "runtime": {"adapter": "react-vite", ...}}), '
    + 'then retry page_preview_open'
  const dependencyHint = 'Ask the user to install the project dependencies themselves (the plugin never installs '
    + 'them), then retry page_preview_open'
  const issue = (code: string, message: string, hint = 'Fix the reported item in page-preview.config.json or choose '
    + 'another file target; strategy/scope/requirements were not changed') =>
    missing.push({ code, phase: 'plan', message, hint })
  const scenes = ctx.config.project.scenarios ?? {}
  const scene = scenario === undefined || !Object.hasOwn(scenes, scenario) ? undefined : scenes[scenario]
  const definition = ctx.config.project.targets?.find(value => value.id === target.targetId)
  let route = options?.route ?? definition?.route ?? scene?.route
  const requested = target.selector
  const selector = requested.kind === 'registered'
    ? ctx.config.project.targets?.find(value => value.id === requested.id)?.selector : requested
  const info = await inspect(ctx)
  if (!info || info.buildHost.kind !== 'vite') issue(DiagnosticCode.toolchainMismatch,
    'React and the Vite build host are missing or ambiguous',
    dependencyHint)
  if (info?.isolationExcluded.length) issue(DiagnosticCode.unsupportedCapability,
    'This framework requires its project path; the isolated strategy was not changed automatically')
  if (info?.react.major === 'unknown') issue(DiagnosticCode.toolchainMismatch,
    'Installed React version must be known and within the 18/19 lines; declaration ranges are insufficient',
    dependencyHint)
  const toolVersion = info?.buildHost.kind === 'vite' ? info.buildHost.viteVersion : undefined
  if (!toolVersion) issue(DiagnosticCode.dependencyMissing,
    'The selected build tool has no actual installed version; no dependency was installed', dependencyHint)
  if (info?.buildHost.kind === 'vite' && info.buildHost.reactPlugin === 'unknown')
    issue(DiagnosticCode.dependencyMissing,
    'An installed React build plugin matching the runtime must be explicitly resolvable', dependencyHint)
  const foreignBindings = runtime.command || runtime.origin
    || runtime.publicRoot !== undefined || runtime.spaFallback !== undefined
  if (foreignBindings) issue(DiagnosticCode.configInvalid,
    'Project/attach/static bindings cannot be silently reused as an isolated React plan')
  // 路由选择器经只读 route-map 解析为叶子组件文件；找不到/歧义如实报，不猜组件。
  let resolvedSelector = selector
  let routeLayout = false
  if (selector?.kind === 'route') {
    let concrete: URL | undefined
    try { concrete = localRoute(selector) } catch { /* 下方统一诊断 */ }
    if (concrete === undefined) issue(DiagnosticCode.configInvalid,
      'React route target must be a concrete local route; missing params and external routes are not inferred')
    else {
      const map = await readRouteMap(ctx.appRoot, info?.entry)
      const matched = map.routes.filter(entry => matchesRoute(entry.path, concrete))
      const components = [...new Set(matched.map(entry => entry.component))]
      if (components.length === 0) issue(DiagnosticCode.unsupportedCapability,
        'No statically known route matches ' + JSON.stringify(selector.path)
          + (map.routerModule ? ' in ' + map.routerModule : ' (no static router module was identified)')
          + (map.gaps.length ? '; route map gaps: ' + map.gaps.slice(0, 3).join('; ') : ''),
        'Point target.path at a statically declared route, or use {"kind": "file", "path": '
          + '"<page component relative to the workspace>"} directly; unmatched routes are never guessed')
      else if (components.length > 1) issue(DiagnosticCode.ambiguousTarget,
        'Several route entries match ' + JSON.stringify(selector.path) + ' (' + components.join(', ')
          + '); no component was picked',
        'Use {"kind": "file", "path": "<page component relative to the workspace>"} to name it explicitly')
      else {
        const entry = matched.find(value => value.component === components[0])!
        resolvedSelector = { kind: 'file', path: entry.component }
        route = { path: selector.path, ...(selector.params === undefined ? {} : { params: selector.params }),
          ...(selector.query === undefined ? {} : { query: selector.query }) }
        routeLayout = selector.layout === true
      }
    }
  }
  // R5-7：React 路径暂不执行项目路由表父链（v1 叶子组件挂在内存路由上下文）；
  // layout 请求如实拒绝而不是静默降级为叶子渲染。
  if (routeLayout) issue(DiagnosticCode.unsupportedCapability,
    'React route layout rendering is not connected on this path; the leaf component would render alone',
    'Drop "layout": true to mount the leaf component, or use {"kind": "file"} with an explicit parent component')
  if (!resolvedSelector || resolvedSelector.kind !== 'file' || !moduleFile(resolvedSelector.path)) {
    issue(DiagnosticCode.unsupportedCapability,
      'React isolation needs a component module file/export; story and URL targets are not connected',
      'Retry page_preview_open with target {"kind": "file", "path": "<page component relative to the workspace, '
        + 'e.g. src/pages/Home.jsx>"} or {"kind": "route", "path": "<declared route path>"}')
  }
  const files: Record<string, string> = {}
  const sceneFiles = new Map<string, string>()
  const buildConfig = await readReactBuildConfig(ctx.appRoot)
  let setupStyleGaps: { file: string, specifiers: string[] } | undefined
  let generatedSetup: { entry: string, hash: string } | undefined
  let generatedNotes: string[] = []
  let generatedHasRouter = false
  const localFile = async (path: string) => resolveProjectPath(ctx.appRoot, path, runtime.dependencyRoots)
  const text = async (file: string): Promise<string | undefined> => {
    const canonical = await localFile(relative(ctx.appRoot, file) || '.')
    const source = await readProjectText(canonical)
    if (source !== undefined) files[relative(ctx.appRoot, file)] = createHash('sha256').update(source).digest('hex')
    return source
  }
  if (scenario !== undefined) {
    if (!scene) issue(DiagnosticCode.configInvalid, 'Requested React scenario was not configured')
    else {
      const contextual = scene.identity !== undefined || scene.permissions !== undefined
        || scene.state !== undefined || scene.locale !== undefined
      if (contextual && !runtime.setup) issue(DiagnosticCode.unsupportedCapability,
        'Identity, permission, state and locale data require an explicit reviewed setup binding')
      try {
        if (scene.handlers) {
          const source = await text(await resolveHandlerModule(ctx.appRoot, scene.handlers, runtime.dependencyRoots))
          if (source === undefined) throw new Error('Handler module source is missing')
          sceneFiles.set(scene.handlers, createHash('sha256').update(source).digest('hex'))
        }
        for (const [path, digest] of await inspectScenarioFixtures(ctx.appRoot, scene, runtime.dependencyRoots)) {
          files['fixture:' + path] = digest
          sceneFiles.set(path, digest)
        }
      } catch (error) {
        if (error instanceof RunnerSessionError) missing.push(error.diagnostic)
        else issue(DiagnosticCode.configInvalid, 'Scenario handler source is invalid; no project code was executed')
      }
    }
  }
  if (resolvedSelector?.kind === 'file' && moduleFile(resolvedSelector.path)) {
    const file = await localFile(resolvedSelector.path)
    const source = await text(file)
    if (source === undefined || !(await stat(file)).isFile()) issue(DiagnosticCode.targetNotReady,
      'React target module does not exist as a file',
      'Retry with target.path pointing at an existing .jsx/.tsx/.js/.ts component file')
    else {
      const exportName = resolvedSelector.exportName ?? 'default'
      const parsed = parseScriptSource(file, source)
      if (parsed.invalid) issue(DiagnosticCode.compileError, 'Target module syntax is invalid')
      if (!parsed.exports.includes(exportName)) issue(DiagnosticCode.targetNotReady,
        'Requested target export is not statically declared',
        'Retry with target.exportName set to an export the file declares, or omit it for the default export')
    }
  }
  if (runtime.setup) {
    const file = await localFile(runtime.setup)
    const source = await text(file)
    if (source === undefined) issue(DiagnosticCode.dependencyMissing, 'Configured setup file is missing')
    else {
      const parsed = parseScriptSource(file, source)
      if (parsed.invalid || !parsed.exports.includes('default'))
        issue(DiagnosticCode.configInvalid, 'Setup must have valid syntax and a default export; it was not executed')
      else if (info?.entry) {
        const gaps = await missingSetupStyles(ctx.appRoot, info.entry, file, buildConfig)
          .catch(() => [] as string[])
        if (gaps.length) setupStyleGaps = { file: relative(ctx.appRoot, file), specifiers: gaps }
      }
    }
  } else if (info?.entry) {
    await text(info.entry)
    // §0.3 第 10 条：未配置 setup 时自动使用从入口生成的 setup，摘要并入执行指纹审批；无法生成时走手写路径。
    const built = await buildGeneratedSetup(ctx.appRoot, info.entry, info.react.major, viteResolvableImport)
    const replay = 'reason' in built
      ? built.replay ?? await parseEntryRegistrations(ctx.appRoot, info.entry) : built.replay
    if (!('reason' in built)) {
      generatedSetup = { entry: built.entry, hash: built.hash }
      generatedNotes = generatedSetupNotes(built)
      generatedHasRouter = built.replay.draft.layers.some(layer => layer.kind === 'router')
    } else if (replay.invalid || replay.diagnostics.length || replay.registrations.length) {
      setupDraft = setupDraftPayload(replay, info.react.major)
      missing.push({ code: DiagnosticCode.unsupportedCapability, phase: 'plan',
        message: 'Entry initialization requires an explicit reviewed runtime.setup; '
          + 'generated drafts are never executed automatically',
        hint: setupDraft === undefined ? manualSetupHint(relative(ctx.appRoot, replay.entryFile))
          : 'Review the generated draft at setupDraft.path, then either copy it into runtime.setup yourself ' +
            'or retry page_preview_open with writeSetupTo (after the user agrees); approve the execution fingerprint',
        location: { file: relative(ctx.appRoot, replay.entryFile) } })
    }
  } else {
    const reasons = (info?.unresolved ?? []).filter(value => /entr|script/i.test(value))
    issue(DiagnosticCode.configInvalid,
      'Original entry is unknown' + (reasons.length ? ' (' + reasons.join('; ') + ')' : '')
        + '; configure runtime.entry or provide an explicit reviewed runtime.setup',
      configHint('entry', '"<module loaded by index.html, e.g. src/main.jsx>"'))
  }
  // 导航绑定门禁：显式 setup 契约自带 navigate；生成 setup 只在入口含路由元素时
  // 才有可消费的 MemoryRouter 上下文——无路由层时 navigate 没有实际效果，如实拒绝。
  if (route) {
    if (!runtime.setup && !generatedHasRouter) issue(DiagnosticCode.unsupportedCapability,
      'React navigation requires an explicit reviewed setup.navigate binding or an entry that mounts a router')
    try { localRoute(route) } catch {
      issue(DiagnosticCode.configInvalid, 'React navigation must be a concrete local route; '
        + 'missing params and external routes are not inferred')
    }
  }
  for (const path of runtime.styles ?? []) {
    const file = await localFile(path)
    if (!/\.(css|scss|sass|less|styl|stylus)$/i.test(file) || await text(file) === undefined)
      issue(DiagnosticCode.dependencyMissing, 'Configured React style must be an existing stylesheet')
  }
  const config = buildConfig
  for (const file of config.files) await text(file)
  const lockfiles = ['package.json', 'tsconfig.json', 'jsconfig.json', 'package-lock.json',
    'pnpm-lock.yaml', 'yarn.lock']
  for (const path of lockfiles) {
    await text(join(ctx.appRoot, path))
  }
  if (config.files.length > 1)
    issue(DiagnosticCode.ambiguousTarget, 'Several build config files exist; selecting one is not implemented')
  if (options?.viewport !== undefined) {
    const { width, height } = options.viewport
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      issue(DiagnosticCode.configInvalid, 'Viewport dimensions must be positive integers; '
        + 'the requested size is never silently approximated')
  }
  if (missing.length || !info || !toolVersion)
    return { kind: 'missing', missing, ...(setupDraft === undefined ? {} : { setupDraft }) }
  const pluginVersion = info.buildHost.kind === 'vite' && info.buildHost.reactPlugin !== 'unknown'
    ? await installedPackageVersion(ctx.appRoot, ctx.workspaceRoot, info.buildHost.reactPlugin)
    : undefined
  const toolchain = {
    react: info.react.installedVersion!, ...(info.react.domVersion ? { reactDom: info.react.domVersion } : {}),
    vite: toolVersion,
    reactPlugin: info.buildHost.kind === 'vite' ? info.buildHost.reactPlugin : 'unknown',
    ...(pluginVersion ? { reactPluginVersion: pluginVersion } : {}),
  }
  const viteDifferences = [
    'The owned Vite runtime uses loopback HTTP/base /, disables project proxies and cross-origin source reads, ' +
      'and keeps Vite config bundles/cache in temporary storage with automatic env-file loading disabled',
    'Owned CSP/CORS/cache/frame response policy takes precedence over project headers; ' +
      'ordinary custom headers are retained',
    'Owned HMR uses a dedicated path and transport; native Upgrade admission is only checked ' +
      'on the Node 24.9+ line, not other runtimes']
  const routeDifferences = [
    'Route/file target navigation mounts the leaf component inside an in-memory router context ' +
      '(MemoryRouter initialEntries); the project route table does not execute, so params/loaders '
      + 'of the matched route are not resolved and parent layouts are not rendered']
  const sceneDifferences = scene ? [
    'Initial scenario data only; browser identity/storage reset and live role switching are not verified',
    'Business HTTP globs: ' + JSON.stringify(scene.businessPaths ?? []) +
      '; document/module resources take precedence'] : []
  const unverified = unverifiedViteFacts(toolchain).length > 0
  const mockSources = await detectProjectMocks(ctx.appRoot)
  // F6：插件实际枚举的 mock 文件相对导入越出 mockPath 时，复制副本必解析失败、插件静默
  // 降级为空表（3.0.2 无可读路由表可核实）——计划层不声明 project 覆盖并如实诊断。
  const mockEscapes = typeof buildConfig.mockPlugin === 'object'
    ? await projectMockEscapes(ctx.appRoot, buildConfig.mockPlugin.mockPath) : []
  const mockPluginConfirmed = mockSources
    .some(source => source.kind === 'vite-plugin-mock' && source.confidence === 'confirmed')
  const mockPluginReady = typeof buildConfig.mockPlugin === 'object'
    && mockPluginConfirmed && mockEscapes.length === 0
  const mswDetected = mockSources.some(source => source.kind === 'msw')
  if (mockPluginReady && typeof buildConfig.mockPlugin === 'object') {
    for (const file of await projectMockFiles(ctx.appRoot, buildConfig.mockPlugin.mockPath)) await text(file)
    const manifest = await projectMockManifest(ctx.appRoot)
    if (manifest !== undefined) files['project-mock:vite-plugin-mock/package.json']
      = createHash('sha256').update(manifest).digest('hex')
  }
  if (mswDetected) await text(join(ctx.appRoot, 'public/mockServiceWorker.js'))
  const executedMocks = new Set<'vite-plugin-mock'>(mockPluginReady ? ['vite-plugin-mock'] : [])
  const coverage = {
    ...reactCandidateCapabilities('hmr'),
    network: reactNetworkCoverage(Boolean(scene?.http?.length || scene?.handlers),
      { msw: mswDetected, vitePluginMock: mockPluginReady,
        ws: Boolean(scene?.ws?.length), sse: Boolean(scene?.sse?.length) }),
  }
  const projectMocks = describeProjectMocks(mockSources, executedMocks)
  const diagnostics = [...projectMocks.diagnostics]
  if (mockPluginConfirmed && typeof buildConfig.mockPlugin === 'object' && mockEscapes.length)
    diagnostics.push({ code: DiagnosticCode.projectMockUnavailable, phase: 'plan',
      message: 'Project vite-plugin-mock files import modules outside the mock directory ('
        + mockEscapes.slice(0, 3).map(entry => entry.file + ' -> ' + entry.specifier).join(', ')
        + (mockEscapes.length > 3 ? ', ...' : '')
        + '); the copied mock tree cannot resolve them, so the plugin would serve an empty route table',
      hint: 'Move the shared module inside the mock directory or inline it in the mock files, '
        + 'or rewrite the mock boundary as a scenario "handlers" module' })
  if (setupStyleGaps) {
    const shown = setupStyleGaps.specifiers.slice(0, 5).map(value => JSON.stringify(value)).join(', ')
    const rest = setupStyleGaps.specifiers.length - Math.min(5, setupStyleGaps.specifiers.length)
    diagnostics.push({ code: DiagnosticCode.setupMissingStyles, phase: 'plan',
      message: 'The configured setup may be missing ' + setupStyleGaps.specifiers.length
        + ' entry style import(s): ' + shown + (rest > 0 ? ' (and ' + rest + ' more)' : ''),
      hint: 'Remove runtime.setup to use the generated setup that replays entry style imports, '
        + 'or import these styles in ' + setupStyleGaps.file,
      location: { file: setupStyleGaps.file } })
  }
  return { kind: 'plan', ...(diagnostics.length ? { diagnostics } : {}), plan: {
    projectId: target.projectId, targetId: target.targetId,
    selector: structuredClone(resolvedSelector ?? target.selector), scope: target.scope,
    strategy: 'isolated', adapter: { id: adapterId(), version: '0.0.0' },
    toolchain,
    requirements: [...(options?.requirements ?? runtime.requirements ?? ['mock-only'])], process: { kind: 'in-runner' },
    ...(scenario === undefined ? {} : { scenario }),
    ...(route ? { route: structuredClone(route) } : {}),
    ...(options?.viewport === undefined ? {} : { viewport: structuredClone(options.viewport) }),
    readiness: { serviceDeadlineMs: runtime.readiness?.serviceDeadlineMs ?? 10000,
      targetDeadlineMs: runtime.readiness?.targetDeadlineMs ?? 10000,
      ...(definition?.assertions?.length
        ? { assertions: [{ kind: 'mount-signal' as const }, ...definition.assertions] } : {}) },
    capabilities: resolvedSelector ? applyViteEvidence(coverage, toolchain, resolvedSelector) : coverage,
    fingerprints: { config: fingerprintJson(ctx.config.project), sources: fingerprintJson(files),
      ...(scene ? { scenario: fingerprintJson({ scene, files: Object.fromEntries(sceneFiles) }) } : {}) },
    ...(generatedSetup ? { generatedSetup } : {}),
    missing: [],
    knownDifferences: [
      'Version/scope evidence is bounded to the declared combination; browser data channels are controlled ' +
        'by the owned response layer while Node-side processes run uncontrolled (build-process/server-process: none)',
      ...(unverified ? ['The toolchain/platform combination has no verified sample evidence; execution ' +
        'still proceeds and reports unverified_toolchain with capabilities kept unknown'] : []),
      'Only direct target/entry/setup/styles/config/fixture bytes are fingerprinted; ' +
        'the transitive project graph is incomplete',
      'Project build configuration and explicit initialization may execute only in Runner after applicable approval',
      ...viteDifferences,
      ...(route ? routeDifferences : []), ...(scene ? sceneDifferences : []),
      ...generatedNotes,
      ...projectMocks.knownDifferences,
      ...info.unresolved],
  } }
}
