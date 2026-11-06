/**
 * 自有 Vite 每预览执行器（方案 §6.3、§6.5、§6.8、§9.2；F9 自 vue/react vite worker 抽取）；
 * 仅显式子进程入口执行项目配置/编译插件。框架差异全部经 ViteWorkerHooks 注入：
 * 工具链核对、无配置文件时的编译插件加载、虚拟模块裸说明符规则、optimizeDeps 自有 include、
 * 自有资源端点准入；协议 schema 与固定路径分别来自 worker-protocol.ts 与 paths.ts。
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createResponseLayer, withOwnedResponseHeaders } from '../../runner/response-layer/server.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { resolveInstalledPackage } from '../../shared/profile.ts'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { CODE_FRAME_LIMIT, collectEnvPairs, createRedactor, envSecrets } from '../../shared/redact.ts'
import { findStaticFile } from '../../shared/static-files.ts'
import { createSwappableScenario } from '../scenario-swap.ts'
import type { SwappableScenario } from '../scenario-swap.ts'
import { remoteRequests } from '../../shared/remote-requests.ts'
import { loadProjectHandlers } from '../../scenario/handlers.ts'
import { detectProjectMocks } from '../../core/profile/project-mocks.ts'
import { serveWsFixture, wsFixtureFor } from '../../runner/response-layer/ws-fixture.ts'
import type { WsFixture } from '../../shared/config/schema.ts'
import { loadProjectMock } from './project-mock.ts'
import type { ProjectMock } from './project-mock.ts'
import { record, viteApi } from './api.ts'
import type { VitePlugin, ViteServer } from './api.ts'
import { hasUpgradeGate, isOwnedHmrUpgrade } from './network.ts'
import { VITE_PAGE_PATH, VITE_HMR_PATH, VITE_VIRTUAL_PREFIX, viteVirtualUrl } from './paths.ts'
import { isViteScenarioUpdate, parseViteWorkerInput, parseViteHandlerReply,
  parseViteScenarioUpdate } from './worker-protocol.ts'
import type { ViteWorkerInput, ViteWorkerOutput } from './worker-protocol.ts'
import type { ReadonlyBuildConfig } from '../shared/readonly-config.ts'
import type { ScenarioConfig } from '../../shared/config/schema.ts'

/** createViteSources 的返回形状；各框架 sources.ts 自产（含各自的 runtime/lifecycle 资产）。 */
export interface ViteSources {
  modules: Map<string, string>
  /**
   * 虚拟模块 id → Vite 模块语言（meta.vite.lang）。生成的 setup 承接 TS 入口的导入时登记 'ts'：
   * Vite 只在导入方是 TS 模块时把 `./x.js` 解析到 `x.ts`，虚拟 id 无扩展名，需显式声明（§0.3 第 10 条）。
   */
  moduleLangs?: Map<string, string>
  bootstrap: string
  html: string
  target: string
  exposedFiles: string[]
  setup?: string
  rerenderEntry(scene: ScenarioConfig | undefined): string
}

/** 框架差异的全部注入点；每一钩只描述 Vue/React 各自的既有行为，不新增抽象。 */
export interface ViteWorkerHooks {
  /** plan.adapter.id 的校验值（'vue-vite'/'react-vite'）。 */
  adapterId: string
  /** 生成预览入口脚手架（虚拟模块、html、bootstrap）。 */
  createSources(input: ViteWorkerInput): Promise<ViteSources>
  /** 只读构建配置（alias/mockPlugin 选项等）。 */
  readBuildConfig(root: string): Promise<ReadonlyBuildConfig>
  /**
   * 已批准工具链核对：返回 false 时发 toolchainMismatch 并退出。
   * input.plan.toolchain 内各框架字段由钩子自己核对（vue / react+react-dom）。
   */
  verifyToolchain(input: ViteWorkerInput): Promise<boolean>
  /**
   * 无 vite.config.* 时加载已批准的默认编译插件（plugin-vue / plugin-react[-swc]），
   * 返回 Vite 插件实例；与批准计划不一致时抛错。
   */
  loadDefaultPlugin(input: ViteWorkerInput, root: string): Promise<unknown>
  /**
   * 虚拟模块（setup/entry）里的裸说明符规则：返回需要在应用根下重锚的说明符，
   * 不需要重锚返回 undefined。Vue 只认 'vue'，React 认所有裸说明符。
   */
  virtualBare(id: string, importer: string | undefined): string | undefined
  /** 追加进 optimizeDeps.include 的自有所需包名（'vue' / react 家族）。 */
  optimizeInclude: readonly string[]
  /** 自有加载必需的额外资源端点（React 的 '/@react-refresh'）。 */
  ownPathnames: readonly string[]
}

export async function runViteWorker(hooks: ViteWorkerHooks): Promise<void> {
  if (!process.send) throw new Error('Vite worker requires dedicated IPC')
  let vite: ViteServer | undefined
  let input: ViteWorkerInput | undefined
  let starting = false
  let closing: Promise<void> | undefined
  let handlerVerified: (() => void) | undefined
  let onScenarioUpdate: ((raw: unknown) => void) | undefined
  let hmrEnabled = false
  // R5-1g：声明的 ws 通道按当前场景准入；start 后由 swappable 供给，未声明的 websocket
  // Upgrade 在 gate 拒绝（Node ≥24.9）或由下方 upgrade 监听销毁，两条路径都出 blocked 诊断。
  let wsMatch: ((request: IncomingMessage) => WsFixture | undefined) | undefined
  let blockedUpgrade: ((request: IncomingMessage) => void) | undefined
  // F8：已准入 fixture 连接上的超大帧（>1 MiB）按 1009 关闭并经 httpDiagnostic 上报。
  let wsProtocolError: ((request: IncomingMessage) => void) | undefined
  const server = createServer(hasUpgradeGate() ? {
    shouldUpgradeCallback: request => {
      if (hmrEnabled && isOwnedHmrUpgrade(request)) return true
      if (wsMatch?.(request) !== undefined) return true
      if (request.headers.upgrade?.toLowerCase() === 'websocket') blockedUpgrade?.(request)
      return false
    },
  } : {})
  server.on('upgrade', (request, socket) => {
    // vite-hmr 协议留给 Vite 自有监听；其余 websocket：声明路径播放 fixture，未声明如实销毁。
    if (request.headers['sec-websocket-protocol'] === 'vite-hmr') return
    const fixture = wsMatch?.(request)
    if (fixture !== undefined) {
      serveWsFixture(fixture, request, socket as Socket, () => wsProtocolError?.(request))
      return
    }
    if (request.headers.upgrade?.toLowerCase() === 'websocket') blockedUpgrade?.(request)
    socket.destroy()
  })
  const send = async (value: ViteWorkerOutput) => {
    if (!process.send || !process.connected) return
    await new Promise<void>((resolve, reject) => process.send!(value,
      error => error && process.connected ? reject(error) : resolve()))
  }
  const finish = (code: number) => {
    closing ??= (async () => {
      // 优雅关闭必须有界：Vite 的 close() 可能因内部 watcher/连接而不 resolve，
      // 无界等待会把 SIGTERM 变成实质无效、完全依赖父进程 SIGKILL 兜底。
      const bounded = (task: Promise<unknown>) =>
        Promise.race([task, new Promise(resolve => setTimeout(resolve, 1500))])
      try {
        server.closeAllConnections?.()
        if (vite) await bounded(vite.close())
        if (server.listening) {
          const closingServer = new Promise<void>((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve()))
          await bounded(closingServer)
        }
        if (input) await rm(input.temporaryRoot, { recursive: true, force: true })
      } catch { code = 1 }
      process.exit(code)
    })()
    return closing
  }
  // §13 第 8 条：worker 侧在发出消息前做值替换；secrets 在拿到项目 env 后装配。
  let redactor = createRedactor()
  const fail = async (error?: unknown) => {
    const code = error instanceof RunnerSessionError
      && error.diagnostic.code === DiagnosticCode.configInvalid
      ? DiagnosticCode.configInvalid : DiagnosticCode.runtimeError
    const detail = error instanceof Error
      ? { message: redactor.text(error.message),
        ...(error.stack === undefined ? {} : { stack: redactor.stack(error.stack) }) }
      : {}
    await send({ type: 'failed', code, ...detail })
    await finish(1)
  }
  process.on('disconnect', () => { void finish(0) })
  process.on('SIGTERM', () => { void finish(0) })
  process.on('SIGINT', () => { void finish(0) })
  process.on('uncaughtException', error => { void fail(error) })
  process.on('unhandledRejection', error => { void fail(error instanceof Error ? error : new Error(String(error))) })
  process.on('message', (raw: unknown) => {
    if (closing) return
    if (isViteScenarioUpdate(raw)) {
      // R3-2：场景更新只可能在 ready 之后到达（RunningHandle 已建好）；否则如实回绝。
      if (onScenarioUpdate === undefined) {
        void send({ type: 'scenario-ack', error: 'Scenario update arrived before the preview was ready' })
          .catch(() => finish(1))
        return
      }
      onScenarioUpdate(raw)
      return
    }
    if (starting) {
      try {
        parseViteHandlerReply(raw)
        if (!handlerVerified) throw new Error('No pending handler verification')
        const resolve = handlerVerified
        handlerVerified = undefined
        resolve()
      } catch (error) { void fail(error) }
      return
    }
    starting = true
    void (async () => {
      input = parseViteWorkerInput(raw, hooks.adapterId)
      if (await resolveProjectPath(input.workspaceRoot, input.project.root) !== await realpath(input.appRoot))
        throw new Error('Worker application binding changed')
      const scene = input.plan.scenario === undefined ? undefined : input.project.scenarios?.[input.plan.scenario]
      if (input.plan.scenario !== undefined && !scene) throw new Error('Requested scenario was not configured')
      const metadata = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, 'vite')
      if (!metadata || metadata.version !== input.plan.toolchain.vite || !await hooks.verifyToolchain(input)) {
        await send({ type: 'failed', code: DiagnosticCode.toolchainMismatch })
        await finish(1)
        return
      }
      const api = viteApi(await import(pathToFileURL(join(metadata.directory, 'dist/node/index.js')).href))
      const sources = await hooks.createSources(input)
      const root = input.appRoot
      // env 值必须在加载项目配置之前就绪：配置抛错时 message/stack 走同一统一脱敏（§13 第 8 条）。
      const envValues = envSecrets(input.project.runtime.env, await collectEnvPairs(root))
      redactor = createRedactor({ secrets: envValues })
      const buildConfig = await hooks.readBuildConfig(root)
      if (buildConfig.files.length > 1) throw new Error('Several Vite configuration sources')
      let original: Record<string, unknown> = {}
      if (buildConfig.files[0]) {
        // Vite 的配置打包文件只写在自有临时目录；原模块的 dirname/import.meta 保留由其打包器处理。
        const wrapper = join(input.temporaryRoot, 'vite.config.mjs')
        await writeFile(wrapper, 'export { default } from ' + jsonSource(buildConfig.files[0]) + '\n',
          { mode: 0o600 })
        const loaded = await api.loadConfigFromFile(
          { command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false },
          wrapper, root, 'silent')
        if (!loaded) throw new Error('Original Vite configuration could not be loaded')
        original = loaded.config
      } else {
        original.plugins = [await hooks.loadDefaultPlugin(input, root)]
      }
      const nonce = randomBytes(32).toString('hex')
      redactor = createRedactor({ secrets: envValues, channels: [nonce] })
      // P1-6 freshness 版本核对：served 为注入文档的构建印章，expect 为浏览器须证明的版本；
      // 编译失败把 expect 清空——旧文档/旧更新不再能冒充 current，直到下一次成功编译。
      let servedBuild = '0'
      let expectBuild: string | undefined = '0'
      // R3-2：docBuild 只跟随实际下发的文档印章（HMR 就地更新不动它），
      // 避免构建长轮询把每次 HMR 误判成需要整页重载。
      let docBuild = '0'
      let reloadSeq = 0
      // R5-1e：检出项目 MSW 才放行 SW 注册，与计划覆盖一致；bootstrap 默认屏蔽 API。
      const projectMsw = (await detectProjectMocks(root)).some(source => source.kind === 'msw')
      const layer = createResponseLayer({ previewId: input.previewId, nonce, allowedHosts: ['127.0.0.1'],
        csp: {}, frameAncestors: [], bootstrapScript: sources.bootstrap, secrets: envValues,
        ...(projectMsw ? { serviceWorker: 'allow' as const } : {}),
        ...(input.plan.viewport === undefined ? {}
          : { frame: { pagePath: VITE_PAGE_PATH, ...input.plan.viewport } }),
        buildVersion: () => { docBuild = servedBuild; return servedBuild },
        // R3-2：与 CLI 同一整页重载通道；seq 只在场景更新时递增。
        buildState: () => ({ build: docBuild, seq: reloadSeq }),
        ...(input.plan.readiness.assertions?.length
          ? { assertions: input.plan.readiness.assertions,
            targetDeadlineMs: input.plan.readiness.targetDeadlineMs }
          : {}),
        onReport(report) {
          const expected = (report.kind === 'document-loaded' && report.build === expectBuild)
            || (report.kind === 'module-updated' && report.version === expectBuild)
          if (expectBuild !== undefined && expected)
            void send({ type: 'applied' }).catch(() => finish(1))
          void send({ type: 'report', report }).catch(() => finish(1))
        },
      })
      const dependencyRoots = input.project.runtime.dependencyRoots ?? []
      const allowedRoots = [root, ...await Promise.all(dependencyRoots.map(path => realpath(resolve(root, path))))]
      const ownPlugin: VitePlugin = {
        name: 'dsh-page-preview-owned-entry', enforce: 'pre',
        resolveId(id, importer) {
          if (id.startsWith('/@id/__x00__')) id = '\0' + id.slice('/@id/__x00__'.length)
          if (sources.modules.has(id)) return id
          // 虚拟模块（setup/entry）没有文件系统位置：其裸说明符统一锚到应用根解析，
          // 保证框架运行时与 Provider 第三方包都命中项目自己的安装。
          const bare = hooks.virtualBare(id, importer)
          if (bare !== undefined)
            return this.resolve(bare, join(root, '__dsh_preview_resolve__.js'), { skipSelf: true })
          return null
        },
        load(id) {
          const code = sources.modules.get(id)
          if (code === undefined) return null
          const lang = sources.moduleLangs?.get(id)
          return lang === undefined ? code : { code, meta: { vite: { lang } } }
        },
        handleHotUpdate({ timestamp }) {
          // Vite 把同一 timestamp 发给插件钩子和客户端 update 载荷；module-updated 报告可据此精确核对版本。
          servedBuild = String(timestamp)
          expectBuild = servedBuild
          void send({ type: 'compiled' }).catch(() => finish(1))
        },
      }
      const logger = {
        hasWarned: false, info() {}, warn() {}, warnOnce() {}, clearScreen() {}, hasErrorLogged() { return true },
        // Vite 以 error(msg, {error}) 传错：转发 message/文件/行列/frame（§13 第 8 条），文件相对应用根。
        error(msg: string, options?: { error?: unknown }) {
          expectBuild = undefined
          const err = options?.error && typeof options.error === 'object'
            ? options.error as Record<string, unknown> : {}
          const loc = err.loc && typeof err.loc === 'object' ? err.loc as Record<string, unknown> : {}
          const id = typeof err.id === 'string' ? err.id : typeof loc.file === 'string' ? loc.file : undefined
          const file = id !== undefined && isAbsolute(id) && isWithinRoot(root, id) ? relative(root, id) : id
          void send({ type: 'compile-error',
            ...(typeof err.message === 'string' || typeof msg === 'string'
              ? { message: redactor.text(typeof err.message === 'string' ? err.message : String(msg)) }
              : {}),
            ...(file === undefined ? {} : { file: redactor.text(file) }),
            ...(typeof loc.line === 'number' ? { line: loc.line } : {}),
            ...(typeof loc.column === 'number' ? { column: loc.column } : {}),
            ...(typeof err.frame === 'string' ? { frame: redactor.text(err.frame, CODE_FRAME_LIMIT) } : {}),
          }).catch(() => finish(1))
        },
      }
      const temporaryRoot = input.temporaryRoot
      const workspaceRoot = input.workspaceRoot
      // 依赖预构建缓存优先放插件数据目录下的持久缓存根（跨预览复用）；大项目每次冷预构建要数十秒，
      // 期间页面反复重载、可见文本为空（2026-11-03 overview 实机推断）。缺省时退回本预览临时目录。
      const cacheDir = input.buildCacheRoot === undefined ? join(temporaryRoot, 'cache')
        : join(input.buildCacheRoot, 'vite')
      const serverPolicy: VitePlugin = {
        name: 'dsh-page-preview-owned-server', enforce: 'post',
        config(config) {
          const serverConfig = record(config.server)
          const optimization = record(config.optimizeDeps)
          const include: string[] = []
          if (optimization.include !== undefined) {
            if (!Array.isArray(optimization.include)) throw new Error('Invalid Vite dependency include list')
            for (const name of optimization.include) {
              if (typeof name !== 'string') throw new Error('Invalid Vite dependency include list')
              include.push(name)
            }
          }
          // 最后一个 config hook 设置所有权相关字段，早于 Vite 的 env/cache 初始化；不覆盖项目别名/编译插件。
          Object.assign(config, { base: '/', envFile: false, envDir: temporaryRoot, cacheDir,
            appType: 'custom', clearScreen: false, customLogger: logger })
          config.optimizeDeps = {
            ...optimization,
            entries: [resolve(root, sources.target), ...(sources.setup ? [sources.setup] : [])],
            include: [...new Set([...include, ...hooks.optimizeInclude])],
          }
          config.server = {
            ...serverConfig, middlewareMode: true, host: '127.0.0.1', port: 0, strictPort: true, open: false,
            https: false, cors: false,
            headers: withOwnedResponseHeaders(record(serverConfig.headers), layer.documentHeaders()),
            hmr: serverConfig.hmr === false ? false : { server, overlay: false, path: VITE_HMR_PATH },
            // 持久依赖缓存在插件数据目录：预构建产物经 /@fs 提供，必须在严格 fs 白名单内。
            fs: { ...record(serverConfig.fs), strict: true,
              allow: [...new Set([workspaceRoot, temporaryRoot, cacheDir, ...allowedRoots])] },
          }
        },
        configResolved(config) {
          // Vite 5 把 envDir 解析为传入的临时目录；Vite 6 因 envFile:false 解析为 false。两者都表示环境文件不落回业务目录。
          const ownedPaths = config.cacheDir === cacheDir
            && (config.envDir === false || config.envDir === temporaryRoot)
          if (!ownedPaths) throw new Error('A project resolved hook changed owned cache/environment paths')
          config.server.proxy = {}
          config.server.cors = false
          config.server.headers = withOwnedResponseHeaders(record(config.server.headers), layer.documentHeaders())
        },
      }
      if (original.root !== undefined && typeof original.root !== 'string')
        throw new Error('Invalid Vite application root')
      vite = await api.createServer({ ...original,
        root: typeof original.root === 'string' ? resolve(root, original.root) : root,
        configFile: false, envFile: false,
        plugins: [ownPlugin, original.plugins, serverPolicy],
      })
      const viteServer = vite
      if (viteServer.config.server.hmr !== false) {
        const hmr = record(viteServer.config.server.hmr)
        if (hmr.server !== server || hmr.path !== VITE_HMR_PATH)
          throw new Error('Project hooks changed the owned HMR transport binding')
        hmrEnabled = true
      }
      const handlers = scene?.handlers ? await loadProjectHandlers(root, scene.handlers, {
        ...(input.project.runtime.dependencyRoots ? { dependencyRoots: input.project.runtime.dependencyRoots } : {}),
        verifyExecution: () => new Promise<void>((resolve, reject) => {
          handlerVerified = resolve
          void send({ type: 'verify-handlers', pid: process.pid }).catch(reject)
        }),
      }) : []
      const virtualUrls = new Set([...sources.modules.keys()]
        .map(id => viteVirtualUrl(id.slice(VITE_VIRTUAL_PREFIX.length))))
      const viteEnv = '/@fs/' + (await realpath(join(metadata.directory, 'dist/client/env.mjs'))).replace(/^\//, '')
      const browserFile = async (pathname: string) => {
        const file = await findStaticFile(viteServer.config.root, pathname)
          ?? (viteServer.config.publicDir
            ? await findStaticFile(viteServer.config.publicDir, pathname) : undefined)
        return file && allowedRoots.some(root => isWithinRoot(root, file)) ? file : undefined
      }
      const resource = async (url: URL, destination: string | undefined) => {
        // ownPathnames 是框架自有加载必需的额外端点（如 React 的 /@react-refresh preamble）。
        if (url.pathname === '/@vite/client' || hooks.ownPathnames.includes(url.pathname)
          || url.pathname === viteEnv || virtualUrls.has(url.pathname)) return true
        if (url.pathname.startsWith('/@id/__x00__')
          && viteServer.moduleGraph.getModuleById('\0' + url.pathname.slice('/@id/__x00__'.length))) return true
        // Vite 5 的 urlToModuleMap 是真 Map；Vite 6 是向后兼容包装器，只有 get 没有 has。
        const byUrl = viteServer.moduleGraph.urlToModuleMap
        if (byUrl.get(url.pathname + url.search) || byUrl.get(url.pathname)) return true
        // Vite 延迟解析 dynamic import，首次目标/setup/style 请求尚未出现在模块图；只放行计划中的真实文件。
        let pathname: string
        try { pathname = decodeURIComponent(url.pathname) } catch { return false }
        const candidate = pathname.startsWith('/@fs/')
          ? '/' + pathname.slice('/@fs/'.length).replace(/^\//, '')
          : resolve(viteServer.config.root, '.' + pathname)
        // 未知请求只查现有图；getModuleByUrl 会触发项目 resolveId，不能用于业务请求的准入判断。
        if (viteServer.moduleGraph.fileToModulesMap.get(candidate)?.size) return true
        if (sources.exposedFiles.includes(candidate)) return true
        const staticDestinations = ['image', 'style', 'font', 'audio', 'video', 'script',
          'worker', 'sharedworker', 'serviceworker']
        if (!destination || !staticDestinations.includes(destination)) return false
        return await browserFile(url.pathname) !== undefined
      }
      let accepting = false
      let swappable: SwappableScenario | undefined
      const httpDiagnostic = (
        code: Extract<ViteWorkerOutput, { type: 'http-diagnostic' }>['code'],
        request?: { method: string | undefined; url: string; queryKeys?: string[] },
      ) => {
        // 被拦截请求转发 method/origin/path；query 值、userinfo 与 nonce 在统一脱敏中去除，只留键名供汇总。
        const target = request === undefined ? undefined : redactor.request(request.method, request.url, origin)
        const keys = request?.queryKeys ?? queryKeysOf(request?.url)
        void send({ type: 'http-diagnostic', code,
          ...(target?.method === undefined ? {} : { method: target.method }),
          ...(target?.origin === undefined ? {} : { origin: target.origin }),
          ...(target === undefined ? {} : { path: target.path }),
          ...(keys === undefined || !keys.length ? {} : { queryKeys: keys }),
        }).catch(() => finish(1))
      }
      /** 从原始请求 URL 提取 query 键名（无值）；畸形输入返回 undefined。 */
      const queryKeysOf = (raw: string | undefined): string[] | undefined => {
        if (raw === undefined) return undefined
        try { return [...new Set(new URL(raw, origin).searchParams.keys())].sort() } catch { return undefined }
      }
      server.on('request', (req, res) => layer.middleware(req, res, error => {
        const failResponse = () => { if (!res.headersSent) res.writeHead(500); res.end() }
        if (error) { failResponse(); return }
        void (async () => {
          if (!accepting) { res.writeHead(503); res.end(); return }
          const url = new URL(req.url ?? '/', 'http://preview.invalid')
          for (const [key, value] of Object.entries(layer.documentHeaders())) res.setHeader(key, value)
          if (req.headers.upgrade !== undefined) {
            httpDiagnostic(DiagnosticCode.blockedRequest, { method: req.method, url: req.url ?? '/' })
            res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' })
            res.end(JSON.stringify({ code: DiagnosticCode.blockedRequest }))
            return
          }
          // 经 remote 通道还原的跨源业务请求：只交给 Mock/未命中，绝不当作文档或项目资源下发。
          const remote = remoteRequests.has(req)
          if (!remote && req.method === 'GET' && url.pathname === VITE_PAGE_PATH) {
            const html = await viteServer.transformIndexHtml(VITE_PAGE_PATH, sources.html)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(layer.transformDocument(html))
            return
          }
          if (!remote && ['GET', 'HEAD'].includes(req.method ?? '')) {
            const destination = typeof req.headers['sec-fetch-dest'] === 'string'
              ? req.headers['sec-fetch-dest'] : undefined
            if (destination === 'iframe' || destination === 'frame') {
              const file = await browserFile(url.pathname)
              if (file && ['.html', '.htm'].includes(extname(file).toLowerCase())) {
                // 子文档继承响应策略，但不能回传父目标的挂载/断言证明。
                const html = await viteServer.transformIndexHtml(url.pathname, await readFile(file, 'utf8'))
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                res.end(req.method === 'HEAD' ? undefined : html)
                return
              }
            }
            if (await resource(url, destination)) { viteServer.middlewares(req, res, failResponse); return }
          }
          const unmatched = () => {
            httpDiagnostic(DiagnosticCode.unmatchedRequest, { method: req.method, url: req.url ?? '/' })
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ code: DiagnosticCode.unmatchedRequest }))
          }
          // R5-1e：项目 Mock 链在场景层之后、最终未命中之前；remote 跨源请求不进项目 Mock。
          const throughProjectMock = () => {
            if (remote || !projectMock) { unmatched(); return }
            let index = 0
            const step = (error?: unknown) => {
              if (error !== undefined) { httpDiagnostic(DiagnosticCode.runtimeError); failResponse(); return }
              const middleware = projectMock!.middlewares[index++]
              if (middleware === undefined) { unmatched(); return }
              middleware(req, res, step)
            }
            step()
          }
          if (swappable) swappable.middleware(req, res, error => {
            if (error) { httpDiagnostic(DiagnosticCode.runtimeError); failResponse() } else throughProjectMock()
          })
          else throughProjectMock()
        })().catch(failResponse)
      }))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No owned HTTP listener')
      const origin = 'http://127.0.0.1:' + address.port
      // R3-2：可替换 Mock——无当前场景时 middleware 直接落到调用方未命中分支；handlers 绑定已按批准固定。
      swappable = createSwappableScenario({
        previewOrigin: origin, appRoot: root,
        ...(input.project.runtime.dependencyRoots === undefined
          ? {} : { dependencyRoots: input.project.runtime.dependencyRoots }),
        handlers,
        onUnmatched: request => httpDiagnostic(DiagnosticCode.unmatchedRequest, {
          method: request.method, url: request.url,
          ...(request.queryKeys === undefined ? {} : { queryKeys: request.queryKeys }),
        }),
        onDiagnostic: diagnostic => httpDiagnostic(
          diagnostic.code === DiagnosticCode.configInvalid || diagnostic.code === DiagnosticCode.unsupportedCapability
            ? diagnostic.code
            : DiagnosticCode.runtimeError),
        ...(scene === undefined || input.plan.scenario === undefined
          ? {} : { initial: { name: input.plan.scenario, scenario: scene } }),
      })
      // R5-1g：Upgrade 准入跟随当前场景（replace 换表）；未声明的 WS 如实 block 诊断。
      wsMatch = request => wsFixtureFor(swappable?.wsFixtures() ?? [], request)
      blockedUpgrade = request => httpDiagnostic(DiagnosticCode.blockedRequest, {
        method: request.method, url: request.url ?? '/' })
      wsProtocolError = request => httpDiagnostic(DiagnosticCode.protocolViolation, {
        method: request.method, url: request.url ?? '/' })
      // R5-1e：项目 vite-plugin-mock（readonly-config 可完整求值时）在 temporaryRoot 副本上执行；
      // 只能应答 businessPaths 之外的同源路径——场景层在声明路径上保持独占与可观测未命中。
      let projectMock: ProjectMock | undefined
      if (typeof buildConfig.mockPlugin === 'object') {
        try { projectMock = await loadProjectMock(root, buildConfig.mockPlugin.mockPath, input.temporaryRoot) }
        catch { projectMock = undefined }
        // 插件缺失/选项越界/目录不可读都如实诊断并继续；请求落到未命中分支。
        if (projectMock === undefined) httpDiagnostic(DiagnosticCode.projectMockUnavailable, {
          method: 'LOAD', url: '/' + buildConfig.mockPlugin.mockPath.replace(/^\/+/, ''),
        })
      }
      // R3-2：场景更新——原子换 Mock/Store，重渲染虚拟入口并整体失效模块图（虚拟模块的文件时间戳
      // 不能触发 Vite 失效），再 bump 长轮询 seq 让浏览器整页重载；不清 Cookie/Storage。
      // 失败面由 vue-vite-runtime 覆盖：invalidateAll 缺失如实回绝不换绑、编译失败 ack stale、
      // docBuild 不随 HMR 变化（R5-0c）。
      onScenarioUpdate = raw => void (async () => {
        if (!accepting || swappable === undefined) throw new Error('Unexpected scenario update')
        const update = parseViteScenarioUpdate(raw)
        const entry = sources.rerenderEntry(update.scenario)
        if (typeof viteServer.moduleGraph.invalidateAll !== 'function') {
          throw new Error('Installed Vite lacks module graph invalidation; the updated entry cannot be served')
        }
        sources.modules.set(VITE_VIRTUAL_PREFIX + 'entry', entry)
        viteServer.moduleGraph.invalidateAll()
        // 换绑放最后：此前的异常不会动服务中场景，失败后旧 Mock/Store 仍一致服务。
        swappable.replace(update.name, update.scenario)
        reloadSeq += 1
        await send({ type: 'scenario-ack', stale: expectBuild === undefined })
      })().catch(async error => {
        try {
          await send({ type: 'scenario-ack',
            error: redactor.text(error instanceof Error ? error.message : String(error)) })
        } catch { await finish(1) }
      })
      accepting = true
      await send({ type: 'ready', pid: process.pid, origin, nonce })
    })().catch(fail)
  })
  await send({ type: 'booted', pid: process.pid })
}

const jsonSource = (value: unknown) =>
  JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** 作为显式子进程入口时自启；entryUrl 传调用方模块的 import.meta.url。 */
export const runIfMain = (entryUrl: string, run: () => Promise<void>) => {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(entryUrl))
    void run().catch(() => process.exit(1))
}
