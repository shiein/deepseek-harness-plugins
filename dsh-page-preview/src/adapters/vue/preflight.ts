/** Vue 隔离只读预检（方案 §6.2、§6.5、§6.9）。仅分析元数据/源码，不调用 start 或加载项目工具链。 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import type { AdapterContext, AdapterPlanOptions, AdapterPlanOutcome, DiscoverResult, ProbeResult, SetupDraftPayload } from '../types.ts'
import type { ResolvedTarget } from '../../core/target/resolve.ts'
import type { CapabilitySet, Diagnostic, NetworkCoverage, RefreshMode } from '../../shared/contracts.ts'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import { installedPackageVersion, readProjectText } from '../../shared/profile.ts'
import { parseScriptSource } from '../../shared/javascript.ts'
import { parseVueSfc } from '../../shared/vue-sfc.ts'
import { scanProjectFiles } from '../../shared/project-files.ts'
import { detectVueApp } from './detect.ts'
import type { VueAppInfo } from './detect.ts'
import { generateSetupDraft, parseEntryRegistrations } from './entry-replay.ts'
import { buildGeneratedSetup, generatedSetupNotes } from './generated-setup.ts'
import { missingSetupStyles } from './setup-styles.ts'
import { viteResolvableImport } from '../vite/paths.ts'
import type { EntryReplayResult, RegistrationKind } from './entry-replay.ts'
import type { VueMajor } from './detect.ts'
import { readVueBuildConfig } from './readonly-config.ts'
import { applyViteEvidence, unverifiedViteFacts } from './vite/profile.ts'
import { inspectScenarioFixtures } from '../../scenario/preflight.ts'
import { resolveHandlerModule } from '../../scenario/handlers.ts'
import { localRoute, matchesRoute } from '../../shared/route.ts'
import { readRouteMap } from './impact/route-map.ts'
import { detectProjectMocks, describeProjectMocks } from '../../core/profile/project-mocks.ts'
import { projectMockEscapes, projectMockFiles, projectMockManifest } from '../vite/project-mock.ts'

type Host = 'vite' | 'vue-cli'
const adapterId = (host: Host) => host === 'vite' ? 'vue-vite' : 'vue-cli'
const moduleFile = (file: string) => /\.(vue|[cm]?[jt]sx?)$/i.test(file)

/** 浏览器侧通道由自有响应层/准入机制控制（方案 A，§0.3 第 3 条）；Node 侧进程如实保持 none。 */
function vueNetworkCoverage(withFixtures: boolean,
  mocks: { msw: boolean, vitePluginMock: boolean, ws: boolean, sse: boolean }
    = { msw: false, vitePluginMock: false, ws: false, sse: false }): NetworkCoverage[] {
  const owned = (channel: NetworkCoverage['channel'], control: NetworkCoverage['control'], note: string): NetworkCoverage => ({ channel, control, location: 'response-layer', note })
  const none = (channel: NetworkCoverage['channel'], note: string): NetworkCoverage => ({ channel, control: 'none', location: 'none', note })
  return [
    owned('browser-http', withFixtures ? 'mock' : 'block', 'Owned loopback middleware serves declared same-origin fixtures; unmatched business requests fail explicitly instead of reaching real backends'),
    ...(mocks.vitePluginMock ? [{ channel: 'browser-http', control: 'mock', location: 'project',
      note: 'The project vite-plugin-mock runs in the Runner and may answer same-origin paths outside '
        + 'the declared businessPaths; declared paths stay exclusive to the scenario layer'
    } satisfies NetworkCoverage] : []),
    // R5-1g：声明 ws/sse 通道时该通道为 mock（固定序列）；未声明的连接仍 block。
    owned('browser-ws', mocks.ws ? 'mock' : 'block', mocks.ws
      ? 'Declared ws fixtures play a fixed same-origin message sequence; undeclared Upgrades are destroyed '
        + 'with a blocked diagnostic'
      : 'Every Upgrade is rejected except the owned same-origin HMR binding'),
    owned('browser-sse', mocks.sse ? 'mock' : 'block', mocks.sse
      ? 'Declared sse fixtures serve a fixed same-origin event stream; undeclared endpoints stay unmatched'
      : 'EventSource endpoints share the owned HTTP admission; unmatched requests fail explicitly'),
    // R5-1e：bootstrap 在未检出 MSW 时屏蔽 navigator.serviceWorker（block 声明据此成立）；
    // MSW 经入口重放的 worker.start() 启用。
    mocks.msw
      ? { channel: 'service-worker' as const, control: 'mock' as const, location: 'project' as const,
        note: 'Project MSW worker may register inside '
        + 'the preview document (headless-Chrome verified, carrier unverified); matched requests are intercepted '
        + 'before the plugin layer sees them' }
      : owned('service-worker', 'block', 'The owned bootstrap hides navigator.serviceWorker unless a project '
        + 'MSW worker is detected'),
    owned('dev-server-proxy', 'block', 'Project dev-server proxying is cleared; nothing is forwarded to real backends'),
    none('build-process', 'Project build configuration executes in the owned worker; its file/env I/O is bounded, not blocked'),
    none('server-process', 'Configured Node handlers execute in the worker without outbound control'),
  ]
}

/** §6.9 v1.4：可生成草稿时把全文与分类项随 missing 返回；原文表达式只进草稿文件，不进诊断。 */
function setupDraftPayload(replay: EntryReplayResult, major: VueMajor | 'unknown'): SetupDraftPayload | undefined {
  if (replay.invalid || major === 'unknown') return undefined
  const family = major === '3' ? '3' : '2'
  if (!replay.draft.frameworks.length || replay.draft.frameworks.some(value => value !== family)) return undefined
  const item = (kind: RegistrationKind, source: string, reason?: string) => ({ kind, source, ...(reason === undefined ? {} : { reason }) })
  const parked = 'Business initialization may issue requests or read credentials at module top level; it stays commented in the draft pending review'
  const stuck = 'This registration could not be resolved statically; it stays commented in the draft pending manual setup'
  return {
    source: generateSetupDraft(replay, major),
    thirdParty: replay.registrations.filter(value => value.replay !== undefined).map(value => item(value.kind, value.source)),
    business: replay.registrations.filter(value => value.replay === undefined && value.origin === 'business').map(value => item(value.kind, value.source, parked)),
    unresolved: replay.registrations.filter(value => value.replay === undefined && value.origin !== 'business').map(value => item(value.kind, value.source, stuck)),
  }
}

/**
 * 入口无法自动成稿（如 createApp 包在函数/条件里）时，告诉 Agent setup 模块的确切形态与后续步骤。
 * 形态与 generateSetupDraft 的产物一致：default 导出 install，返回 rootOptions。
 */
function manualSetupHint(major: VueMajor | 'unknown', entry: string): string {
  const receiver = major === '3' ? 'app' : 'Vue'
  const use = major === '3' ? 'app.use(ui.default)' : 'Vue.use(ui.default)'
  return 'Create a new setup module such as preview/setup.js: export default { async install({ ' + receiver
    + ' }) { const ui = await import("<ui library>"); ' + use + ' } } (router/store/i18n instances go in '
    + 'createContext() { return { rootOptions: { router } } }) — copy only the '
    + 'third-party registrations (UI kits, i18n, global components/directives) from ' + entry + ', leave out login, '
    + 'API and router-from-backend logic; then add "setup": "preview/setup.js" to the project runtime in '
    + 'page-preview.config.json and retry page_preview_open (the user approves the execution fingerprint)'
}

/** 运行路径接通并经完整样本验收前，候选能力不改为 supported。 */
export function vueCandidateCapabilities(refreshMode: RefreshMode = 'hmr'): CapabilitySet {
  const pending = { status: 'unknown', source: 'adapter', reason: 'This combination or operation has no complete implementation and sample evidence' } as const
  const unsupported = { status: 'unsupported', source: 'adapter', reason: 'This operation is not connected on the current Vue path' } as const
  return {
    scopes: { page: pending, component: pending, shell: pending }, isolatedRender: pending,
    // R3-2：场景重新加载/切换已实现但无样本证据；T 阶段验收前保持 unknown。
    scenarioApply: pending, scenarioReset: pending,
    refresh: { ...pending, mode: refreshMode }, captureCurrentView: unsupported,
    runtimeErrors: pending, readinessAssertion: pending,
    network: vueNetworkCoverage(false),
  }
}
async function inspect(ctx: AdapterContext, host: Host): Promise<VueAppInfo | undefined> {
  const explicit = ctx.config.project.runtime.adapter === adapterId(host)
  return detectVueApp(ctx.appRoot, { workspaceRoot: ctx.workspaceRoot, ...(ctx.config.project.runtime.entry ? { entry: ctx.config.project.runtime.entry } : {}), ...(explicit ? { buildHost: host } : {}) })
}
export async function probeVue(ctx: AdapterContext, host: Host, target?: ResolvedTarget): Promise<ProbeResult> {
  const info = await inspect(ctx, host)
  const requested = target?.selector
  const selector = requested?.kind === 'registered' ? ctx.config.project.targets?.find(value => value.id === requested.id)?.selector : requested
  const hostCandidate = info?.buildHost.kind === host || info?.buildHost.kind === 'unknown' && ctx.profile.buildTools.some(value => value.value.name === host)
  const matched = info !== undefined && hostCandidate === true && !info.isolationExcluded.length && (!selector || selector.kind === 'file' && moduleFile(selector.path))
  return { matched, capabilities: vueCandidateCapabilities(), evidence: matched ? [...info.evidence, 'Candidate module only; no project configuration or source was executed'] : [], limits: [...(info?.unresolved ?? []), 'Framework helper evidence does not establish this public execution path'] }
}
export async function discoverVue(ctx: AdapterContext): Promise<DiscoverResult> {
  const scan = await scanProjectFiles(ctx.appRoot, 5000)
  return { candidates: scan.files.filter(file => /\.vue$/i.test(file)).sort().map(file => ({ projectId: ctx.config.project.id, selector: { kind: 'file', path: relative(ctx.appRoot, file) }, relation: ['Existing Vue SFC; caller must choose the intended component/page'], evidence: 'weak' })), manualOnly: true,
    unresolved: ['Routes and dependency impact are not inferred by this manual discovery', ...(scan.limited ? ['Vue discovery reached its file budget'] : [])] }
}

export async function planVue(ctx: AdapterContext, target: ResolvedTarget, host: Host, scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome> {
  const missing: Diagnostic[] = []
  let setupDraft: SetupDraftPayload | undefined
  const runtime = ctx.config.project.runtime
  // hint 必须是 Agent 能直接执行的下一步（AGENTS §5 第 12 条）：给出具体的配置字段、目标形态或工具调用。
  const configHint = (field: string, example: string) => 'Add "' + field + '": ' + example + ' under the project '
    + JSON.stringify(ctx.config.project.id) + ' runtime in page-preview.config.json at the workspace root '
    + '(projects[]: {"id": ' + JSON.stringify(ctx.config.project.id) + ', "root": '
    + JSON.stringify(ctx.config.project.root) + ', "runtime": {"adapter": "' + adapterId(host) + '", ...}}), '
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
  const selector = requested.kind === 'registered' ? ctx.config.project.targets?.find(value => value.id === requested.id)?.selector : requested
  const info = await inspect(ctx, host)
  if (!info || info.buildHost.kind !== host) issue(DiagnosticCode.toolchainMismatch,
    'Vue and the selected build host are missing or ambiguous',
    dependencyHint)
  if (info?.isolationExcluded.length) issue(DiagnosticCode.unsupportedCapability, 'This framework requires its project path; the isolated strategy was not changed automatically')
  if (info?.vue.major === 'unknown') issue(DiagnosticCode.toolchainMismatch,
    'Installed Vue version must be known and within Vue 2.6/2.7/3; declaration ranges are insufficient', dependencyHint)
  const toolVersion = info?.buildHost.kind === 'vite' ? info.buildHost.viteVersion : info?.buildHost.kind === 'vue-cli' ? info.buildHost.cliServiceVersion : undefined
  if (!toolVersion) issue(DiagnosticCode.dependencyMissing,
    'The selected build tool has no actual installed version; no dependency was installed', dependencyHint)
  if (info?.buildHost.kind === 'vite' && info.buildHost.vuePlugin === 'unknown') issue(DiagnosticCode.dependencyMissing,
    'An installed Vue build plugin matching the runtime must be explicitly resolvable', dependencyHint)
  if (runtime.command || runtime.origin || runtime.publicRoot !== undefined || runtime.spaFallback !== undefined) issue(DiagnosticCode.configInvalid, 'Project/attach/static bindings cannot be silently reused as an isolated Vue plan')
  // R5-4：路由选择器经只读 route-map 解析为叶子组件文件；找不到/歧义如实报，不猜组件。
  // 路由选择器自带导航上下文（覆盖 definition/scene 的 route），layout 决定是否渲染父链。
  let resolvedSelector = selector
  let routeLayout = false
  let layoutWithoutAncestors = false
  if (selector?.kind === 'route') {
    let concrete: URL | undefined
    try { concrete = localRoute(selector) } catch { /* 下方统一诊断 */ }
    if (concrete === undefined) issue(DiagnosticCode.configInvalid,
      'Vue route target must be a concrete local route; missing params and external routes are not inferred')
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
        layoutWithoutAncestors = routeLayout && entry.ancestors.length === 0
      }
    }
  }
  if (!resolvedSelector || resolvedSelector.kind !== 'file' || !moduleFile(resolvedSelector.path)) {
    issue(DiagnosticCode.unsupportedCapability,
      'Vue isolation needs a component module file/export; story and URL targets are not connected',
      'Retry page_preview_open with target {"kind": "file", "path": "<page component relative to the workspace, '
        + 'e.g. src/views/home/index.vue>"} or {"kind": "route", "path": "<declared route path>"}')
  }
  // R5-2：CLI 的 assertions 与 navigation 与 Vite 同一实现——assertions 经共享响应层/bootstrap
  // 证据链核对，navigation 经 cli/sources 注入 __NAVIGATION_JSON__ 由共享 lifecycle.js 调
  // setup.navigate 并核对 finalPath；不再有宿主页面的机制差异，放行两宿主。
  if (route) {
    if (!runtime.setup) issue(DiagnosticCode.unsupportedCapability, 'Vue file navigation requires an explicit reviewed setup.navigate binding')
    try { localRoute(route) } catch { issue(DiagnosticCode.configInvalid, 'Vue navigation must be a concrete local route; missing params and external routes are not inferred') }
  }
  const files: Record<string, string> = {}
  const sceneFiles = new Map<string, string>()
  const buildConfig = await readVueBuildConfig(ctx.appRoot, host)
  let jsxTarget = false
  let setupStyleGaps: { file: string, specifiers: string[] } | undefined
  let generatedSetup: { entry: string, hash: string } | undefined
  let generatedNotes: string[] = []
  const text = async (file: string): Promise<string | undefined> => {
    const canonical = await localFile(relative(ctx.appRoot, file) || '.')
    const source = await readProjectText(canonical)
    if (source !== undefined) files[relative(ctx.appRoot, file)] = createHash('sha256').update(source).digest('hex')
    return source
  }
  const localFile = async (path: string) => resolveProjectPath(ctx.appRoot, path, runtime.dependencyRoots)
  if (scenario !== undefined) {
    if (!scene) issue(DiagnosticCode.configInvalid, 'Requested Vue scenario was not configured')
    else {
      if ((scene.identity !== undefined || scene.permissions !== undefined || scene.state !== undefined || scene.locale !== undefined) && !runtime.setup) issue(DiagnosticCode.unsupportedCapability, 'Identity, permission, state and locale data require an explicit reviewed setup binding')
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
      } catch (error) { if (error instanceof RunnerSessionError) missing.push(error.diagnostic); else issue(DiagnosticCode.configInvalid, 'Scenario handler source is invalid; no project code was executed') }
    }
  }
  if (resolvedSelector?.kind === 'file' && moduleFile(resolvedSelector.path)) {
    const file = await localFile(resolvedSelector.path)
    const source = await text(file)
    if (source === undefined || !(await stat(file)).isFile()) issue(DiagnosticCode.targetNotReady,
      'Vue target module does not exist as a file',
      'Retry with target.path pointing at an existing .vue/.tsx/.jsx/.ts/.js component file')
    else {
      const exportName = resolvedSelector.exportName ?? 'default'
      if (extname(file).toLowerCase() === '.vue') {
        const sfc = parseVueSfc(source)
        const exports = new Set<string>()
        if (sfc.template || sfc.scripts.some(block => block.setup)) exports.add('default')
        for (const block of sfc.scripts) {
          if (!['js', 'ts', 'jsx', 'tsx'].includes(block.lang)) { issue(DiagnosticCode.toolchainMismatch, 'SFC script language needs a verified project compiler'); continue }
          if (block.src && !block.src.startsWith('.')) { issue(DiagnosticCode.toolchainMismatch, 'Non-relative SFC script resolution needs project compiler verification'); continue }
          const script = block.src ? await localFile(relative(ctx.appRoot, resolve(dirname(file), block.src))) : undefined
          const code = script ? await text(script) : block.source
          if (code === undefined) { issue(DiagnosticCode.dependencyMissing, 'External SFC script is missing'); continue }
          const parsed = parseScriptSource(script ?? file + '.' + block.lang, code)
          if (parsed.invalid) issue(DiagnosticCode.compileError, 'SFC script syntax is invalid; no project compiler was executed')
          parsed.exports.forEach(value => exports.add(value))
        }
        for (const block of sfc.styles) if (block.src) {
          if (!block.src.startsWith('.')) issue(DiagnosticCode.toolchainMismatch, 'Non-relative SFC stylesheet resolution needs project compiler verification')
          else if (await text(await localFile(relative(ctx.appRoot, resolve(dirname(file), block.src)))) === undefined) issue(DiagnosticCode.dependencyMissing, 'External SFC stylesheet is missing')
        }
        if (sfc.unresolved.length) issue(DiagnosticCode.toolchainMismatch, 'SFC block structure needs project compiler verification')
        if (!exports.has(exportName)) issue(DiagnosticCode.targetNotReady,
          'Requested SFC export is not statically declared',
          'Retry with target.exportName set to an export the file declares, or omit it for the default export')
      } else {
        const parsed = parseScriptSource(file, source)
        if (parsed.invalid) issue(DiagnosticCode.compileError, 'Target module syntax is invalid')
        // JSX/TSX 由项目自己的编译插件处理：Vite 需项目配置引入 @vitejs/plugin-vue-jsx；Vue CLI 的 babel preset 自带。
        // 有编译路径即照常执行，能力保持 unknown 并经 unverified_toolchain 披露（§0.3 第 1 条）。
        if (parsed.jsx && host === 'vite' && !buildConfig.imports.includes('@vitejs/plugin-vue-jsx')) {
          issue(DiagnosticCode.toolchainMismatch,
            'JSX/TSX target needs @vitejs/plugin-vue-jsx in the project Vite config; none is imported there',
            'Open a .vue SFC target instead, or ask the user to add @vitejs/plugin-vue-jsx to the project Vite config')
        } else if (parsed.jsx) jsxTarget = true
        if (!parsed.exports.includes(exportName)) issue(DiagnosticCode.targetNotReady,
          'Requested target export is not statically declared',
          'Retry with target.exportName set to an export the file declares, or omit it for the default export')
      }
    }
  }
  if (runtime.setup) {
    const file = await localFile(runtime.setup)
    const source = await text(file)
    if (source === undefined) issue(DiagnosticCode.dependencyMissing, 'Configured setup file is missing')
    else {
      const parsed = parseScriptSource(file, source)
      if (parsed.invalid || !parsed.exports.includes('default')) issue(DiagnosticCode.configInvalid, 'Setup must have valid syntax and a default export; it was not executed')
      else if (info?.entry) {
        // 任务 C：手写 setup 接管后自动重放关闭，可能漏掉入口样式；只读核对，产出非阻断诊断。
        const gaps = await missingSetupStyles(ctx.appRoot, info.entry, file, buildConfig)
          .catch(() => [] as string[])
        if (gaps.length) setupStyleGaps = { file: relative(ctx.appRoot, file), specifiers: gaps }
      }
    }
  } else if (info?.entry) {
    await text(info.entry)
    // §0.3 第 10 条：未配置 setup 时自动使用从入口生成的 setup，摘要并入执行指纹审批；无法生成时走手写路径。
    const built = await buildGeneratedSetup(ctx.appRoot, info.entry, info.vue.major,
      host === 'vite' ? viteResolvableImport : undefined)
    const replay = 'reason' in built
      ? built.replay ?? await parseEntryRegistrations(ctx.appRoot, info.entry) : built.replay
    const needed = replay.registrations.length > 0 || replay.draft.transplant !== undefined
    if (!('reason' in built) && needed) {
      generatedSetup = { entry: built.entry, hash: built.hash }
      generatedNotes = generatedSetupNotes(built)
    } else if (replay.invalid || replay.diagnostics.length || replay.registrations.length) {
      // §0.3 第 5 条：能生成草稿时把全文交给 Host 写入插件数据目录，由用户审阅后保存为 runtime.setup。
      setupDraft = setupDraftPayload(replay, info.vue.major)
      missing.push({ code: DiagnosticCode.unsupportedCapability, phase: 'plan',
        message: 'Entry initialization requires an explicit reviewed runtime.setup; generated drafts are never executed automatically',
        hint: setupDraft === undefined ? manualSetupHint(info.vue.major, relative(ctx.appRoot, replay.entryFile))
          : 'Review the generated draft at setupDraft.path, then either copy it into runtime.setup yourself ' +
            'or retry page_preview_open with writeSetupTo (after the user agrees); approve the execution fingerprint',
        location: { file: relative(ctx.appRoot, replay.entryFile) } })
    }
  } else {
    const reasons = (info?.unresolved ?? []).filter(value => /entr|script/i.test(value))
    issue(DiagnosticCode.configInvalid,
      'Original entry is unknown' + (reasons.length ? ' (' + reasons.join('; ') + ')' : '')
        + '; configure runtime.entry or provide an explicit reviewed runtime.setup',
      configHint('entry', '"<module loaded by index.html, e.g. src/main.ts>"'))
  }
  for (const path of runtime.styles ?? []) {
    const file = await localFile(path)
    if (!/\.(css|scss|sass|less|styl|stylus)$/i.test(file) || await text(file) === undefined) issue(DiagnosticCode.dependencyMissing, 'Configured Vue style must be an existing stylesheet')
  }
  const config = buildConfig
  for (const file of config.files) await text(file)
  for (const path of ['package.json', 'tsconfig.json', 'jsconfig.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    // JSONC/extends 由项目编译器处理；这里只纳入原始字节，不伪装解析完成。
    await text(join(ctx.appRoot, path))
  }
  if (config.files.length > 1) issue(DiagnosticCode.ambiguousTarget, 'Several build config files exist; selecting one is not implemented')
  const jsxVersion = jsxTarget && host === 'vite'
    ? await installedPackageVersion(ctx.appRoot, ctx.workspaceRoot, '@vitejs/plugin-vue-jsx') : undefined
  if (jsxTarget && host === 'vite' && !jsxVersion) {
    issue(DiagnosticCode.dependencyMissing, '@vitejs/plugin-vue-jsx is imported by the Vite config but not installed',
      dependencyHint)
  }
  // R5-4：视口经插件自有外层页面（固定尺寸 iframe 内嵌预览文档）实现——外层样式不进入内层，
  // 断言/文本/截图仍在内层文档取证。尺寸必须为正整数，不做近似。
  if (options?.viewport !== undefined) {
    const { width, height } = options.viewport
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      issue(DiagnosticCode.configInvalid, 'Viewport dimensions must be positive integers; '
        + 'the requested size is never silently approximated')
  }
  if (missing.length || !info || !toolVersion) return { kind: 'missing', missing, ...(setupDraft === undefined ? {} : { setupDraft }) }
  const pluginVersion = info.buildHost.kind === 'vite' && info.buildHost.vuePlugin !== 'unknown' ? await installedPackageVersion(ctx.appRoot, ctx.workspaceRoot, info.buildHost.vuePlugin) : undefined
  const toolchain = {
    vue: info.vue.installedVersion!, [host]: toolVersion,
    ...(info.buildHost.kind === 'vite' ? {
      vuePlugin: info.buildHost.vuePlugin, ...(pluginVersion ? { vuePluginVersion: pluginVersion } : {}),
    } : {}),
    ...(jsxTarget ? { vueJsx: jsxVersion ?? 'project-babel-preset' } : {}) }
  const viteDifferences = [
    'The owned Vite runtime uses loopback HTTP/base /, disables project proxies and cross-origin source reads, ' +
      'and keeps Vite config bundles/cache in temporary storage with automatic env-file loading disabled',
    'Owned CSP/CORS/cache/frame response policy takes precedence over project headers; ' +
      'ordinary custom headers are retained',
    'Owned HMR uses a dedicated path and transport; native Upgrade admission is only checked ' +
      'on the Node 24.9+ line, not other runtimes']
  // R2-P0-1：CLI devServer 接管分类——剥离的钩子/proxy 永不执行，网络成形字段被自有值替代；逐项运行时诊断见 devserver_taken_over。
  const cliDifferences = [
    'Project devServer fields shaping listener/transport (port/host/https/http2/server/allowedHosts/' +
      'public/headers/devMiddleware/ipc) are overridden',
    'Project devServer proxy/before/after/setupMiddlewares/onBefore*/onAfter*/onListening/open/bonjour ' +
      'hooks are removed and never execute; historyApiFallback follows the preview page rules',
    'Business data must come from declared scenario fixtures; project dev-server proxies and mock hooks never run',
    'Project .env* files are not loaded into the preview worker (aligned with the Vite envDir:false path); ' +
      'declare the needed variables in runtime.env']
  const routeDifferences = [
    'Route/file target navigation uses reviewed setup.navigate and verifies its returned local route before ' +
      'mounting; navigation stays inside the project router and cross-application navigation is not provided',
    ...(layoutWithoutAncestors ? ['The route target asked for parent layout rendering but no static parent ' +
      'layout component was found; the leaf component renders alone'] : []),
    ...(routeLayout && !layoutWithoutAncestors ? ['Parent layout rendering mounts a router-view host and ' +
      'replays the statically resolved parent chain; app-level shell outside the router is not included'] : [])]
  const sceneDifferences = scene ? [
    'Initial scenario data only; browser identity/storage reset and live role switching are not verified',
    'Business HTTP globs: ' + JSON.stringify(scene.businessPaths ?? []) +
      '; document/module resources take precedence'] : []
  const unverified = host !== 'vite' || unverifiedViteFacts(toolchain).length > 0
  // R5-1e：项目 Mock 执行——vite-plugin-mock 选项可静态求值时由 Runner 执行（temporaryRoot 副本）；
  // MSW 由入口重放的 worker.start() 启用；执行输入计入 sources 指纹。
  const mockSources = await detectProjectMocks(ctx.appRoot)
  // F6：插件实际枚举的 mock 文件相对导入越出 mockPath 时，复制副本必解析失败、插件静默
  // 降级为空表（3.0.2 无可读路由表可核实）——计划层不声明 project 覆盖并如实诊断。
  const mockEscapes = host === 'vite' && typeof buildConfig.mockPlugin === 'object'
    ? await projectMockEscapes(ctx.appRoot, buildConfig.mockPlugin.mockPath) : []
  const mockPluginConfirmed = mockSources
    .some(source => source.kind === 'vite-plugin-mock' && source.confidence === 'confirmed')
  const mockPluginReady = host === 'vite' && typeof buildConfig.mockPlugin === 'object'
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
  // CLI 的刷新经自有构建长轮询整页重载（R2-P0-2），不是 HMR；能力仍如实保持 unknown。
  const coverage = {
    ...vueCandidateCapabilities(host === 'vue-cli' ? 'reload' : 'hmr'),
    network: vueNetworkCoverage(Boolean(scene?.http?.length || scene?.handlers),
      { msw: mswDetected, vitePluginMock: mockPluginReady,
        ws: Boolean(scene?.ws?.length), sse: Boolean(scene?.sse?.length) }),
  }
  // R3-3：项目已有 Mock 只读识别——证据进 knownDifferences，一条非阻断信息性诊断随计划提交。
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
    // 只读静态核对（setup 本身 + 深度 1 本地模块），措辞保持 may be missing；不阻断、不动能力。
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
    strategy: 'isolated', adapter: { id: adapterId(host), version: '0.0.0' },
    toolchain,
    requirements: [...(options?.requirements ?? runtime.requirements ?? ['mock-only'])], process: { kind: 'in-runner' },
    ...(scenario === undefined ? {} : { scenario }),
    ...(route ? { route: structuredClone(route) } : {}),
    ...(routeLayout ? { layout: true } : {}),
    ...(options?.viewport === undefined ? {} : { viewport: structuredClone(options.viewport) }),
    readiness: { serviceDeadlineMs: runtime.readiness?.serviceDeadlineMs ?? 10000, targetDeadlineMs: runtime.readiness?.targetDeadlineMs ?? 10000, ...(definition?.assertions?.length ? { assertions: [{ kind: 'mount-signal' as const }, ...definition.assertions] } : {}) },
    capabilities: host === 'vite' && resolvedSelector
      ? applyViteEvidence(coverage, toolchain, resolvedSelector) : coverage,
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
      ...(host === 'vite' ? viteDifferences : []), ...(host === 'vue-cli' ? cliDifferences : []),
      ...(route ? routeDifferences : []), ...(scene ? sceneDifferences : []),
      ...generatedNotes,
      ...(jsxTarget ? ['The JSX/TSX target is compiled by the project\'s own JSX transform (' + toolchain.vueJsx
        + '); no verified sample covers it, so capabilities stay unknown'] : []),
      ...projectMocks.knownDifferences,
      ...info.unresolved],
  } }
}
