/** Vue CLI 每预览执行器（方案 §6.9、§9.2）；仅显式子进程入口执行项目配置/cli-service。 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createResponseLayer } from '../../../runner/response-layer/server.ts'
import type { Middleware } from '../../../runner/response-layer/server.ts'
import { isWithinRoot, resolveProjectPath } from '../../../shared/config/paths.ts'
import { resolveInstalledPackage } from '../../../shared/profile.ts'
import { DiagnosticCode, RunnerSessionError } from '../../../shared/errors.ts'
import { CODE_FRAME_LIMIT, collectEnvPairs, createRedactor, envSecrets } from '../../../shared/redact.ts'
import { findStaticFile } from '../../../shared/static-files.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { createSwappableScenario } from '../../scenario-swap.ts'
import type { SwappableScenario } from '../../scenario-swap.ts'
import { remoteRequests } from '../../../shared/remote-requests.ts'
import { loadProjectHandlers } from '../../../scenario/handlers.ts'
import { detectProjectMocks } from '../../../core/profile/project-mocks.ts'
import { serveWsFixture, wsFixtureFor } from '../../../runner/response-layer/ws-fixture.ts'
import type { Socket } from 'node:net'
import { createCliSources } from './sources.ts'
import { setCliWorkerState } from './dev-server-hook.ts'
import type { CliHttpServer } from './dev-server-hook.ts'
import { isCliScenarioUpdate, parseCliScenarioUpdate, parseCliWorkerInput, parseCliHandlerReply,
  isCliRefreshInput, CLI_PAGE_PATH } from './protocol.ts'
import type { CliWorkerInput, CliWorkerOutput } from './protocol.ts'

interface CliOutputFs {
  readFileSync?: (file: string) => unknown
  statSync?: (file: string) => { isFile: () => boolean }
}
interface CliDevMiddleware {
  getFilenameFromUrl?: (url: string) => string | false | undefined
  fileSystem?: CliOutputFs
  context?: { outputFileSystem?: CliOutputFs }
}
interface CliDevServer { middleware?: CliDevMiddleware; stop?: () => Promise<void>; server?: { on: (event: string, fn: (req: unknown, socket: { destroy: () => void }) => void) => void } }

export async function runCliWorker(): Promise<void> {
  if (!process.send) throw new Error('Vue CLI worker requires dedicated IPC')
  let input: CliWorkerInput | undefined
  let starting = false
  let closing: Promise<void> | undefined
  let handlerVerified: (() => void) | undefined
  let onScenarioUpdate: ((raw: unknown) => void) | undefined
  let devServer: CliDevServer | undefined
  // P1-6/R2-P0-2：servedBuild 为成功编译的构建印章；expectBuild 缺失表示上次编译失败（重载只证明旧构建）。
  let servedBuild = '0'
  let expectBuild: string | undefined = '0'
  let refreshSeq = 0
  const send = async (value: CliWorkerOutput) => {
    if (!process.send || !process.connected) return
    await new Promise<void>((resolve, reject) => process.send!(value, error => error && process.connected ? reject(error) : resolve()))
  }
  const finish = (code: number) => {
    closing ??= (async () => {
      // 优雅关闭必须有界：webpack-dev-server 的 stop 可能因打开的连接/监听而不返回；
      // 无界等待会让 SIGTERM 实质失效，完全依赖父进程 SIGKILL 兜底。
      const bounded = (task: Promise<unknown>) =>
        Promise.race([task, new Promise(resolve => setTimeout(resolve, 1500))])
      try {
        if (devServer?.stop) await bounded(devServer.stop())
        if (input) await rm(input.temporaryRoot, { recursive: true, force: true })
      } catch { code = 1 }
      process.exit(code)
    })()
    return closing
  }
  // §13 第 8 条：worker 侧在发出消息前做值替换；secrets 在拿到项目 env 后装配。
  let redactor = createRedactor()
  const fail = async (error?: unknown) => {
    const code = error instanceof RunnerSessionError && error.diagnostic.code === DiagnosticCode.configInvalid ? DiagnosticCode.configInvalid : DiagnosticCode.runtimeError
    const detail = error instanceof Error ? { message: redactor.text(error.message), ...(error.stack === undefined ? {} : { stack: redactor.stack(error.stack) }) } : {}
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
    if (isCliRefreshInput(raw)) {
      // page_preview_refresh：只递增 seq 唤醒构建轮询；stale 如实标记编译失败态。
      refreshSeq += 1
      void send({ type: 'refresh-ack', stale: expectBuild === undefined }).catch(() => finish(1))
      return
    }
    if (isCliScenarioUpdate(raw)) {
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
        parseCliHandlerReply(raw)
        if (!handlerVerified) throw new Error('No pending handler verification')
        const resolve = handlerVerified
        handlerVerified = undefined
        resolve()
      } catch (error) { void fail(error) }
      return
    }
    starting = true
    void (async () => {
      input = parseCliWorkerInput(raw)
      if (await resolveProjectPath(input.workspaceRoot, input.project.root) !== await realpath(input.appRoot)) throw new Error('Worker application binding changed')
      const scene = input.plan.scenario === undefined ? undefined : input.project.scenarios?.[input.plan.scenario]
      if (input.plan.scenario !== undefined && !scene) throw new Error('Requested scenario was not configured')
      // 绑定为 const：let input 的收窄不进 onReady 等延迟闭包。
      const plan = input.plan
      const project = input.project
      const metadata = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, '@vue/cli-service')
      const vue = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, 'vue')
      if (!metadata || metadata.version !== input.plan.toolchain['vue-cli'] || vue?.version !== input.plan.toolchain.vue) { await send({ type: 'failed', code: DiagnosticCode.toolchainMismatch }); await finish(1); return }
      const root = input.appRoot
      // env 值必须在加载项目配置之前就绪：配置/cli-service 抛错时 message/stack 走同一统一脱敏（§13 第 8 条）。
      const envValues = envSecrets(input.project.runtime.env, await collectEnvPairs(root))
      redactor = createRedactor({ secrets: envValues })
      const buildConfig = await readVueBuildConfig(root, 'vue-cli')
      if (buildConfig.files.length > 1) throw new Error('Several Vue CLI configuration sources')
      const hookModule = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './dev-server-hook.ts' : './dev-server-hook.js', import.meta.url))
      const sources = await createCliSources(input, buildConfig.files[0], hookModule)
      const nonce = randomBytes(32).toString('hex')
      redactor = createRedactor({ secrets: envValues, channels: [nonce] })
      // P1-6：HMR 已禁用，freshness 只能经文档重载证明——印章注入每个文档响应，
      // bootstrap 回传 build；编译失败清空 expect，旧版本不能再冒充 current。
      // R5-1e：检出项目 MSW 才放行 SW 注册，与计划覆盖一致；bootstrap 默认屏蔽 API。
      const projectMsw = (await detectProjectMocks(root)).some(source => source.kind === 'msw')
      const layer = createResponseLayer({ previewId: input.previewId, nonce, allowedHosts: ['127.0.0.1'], csp: {}, frameAncestors: [], bootstrapScript: sources.bootstrap, secrets: envValues, buildVersion: () => servedBuild,
        ...(projectMsw ? { serviceWorker: 'allow' as const } : {}),
        ...(input.plan.viewport === undefined ? {}
          : { frame: { pagePath: CLI_PAGE_PATH, ...input.plan.viewport } }),
        buildState: () => ({ build: servedBuild, seq: refreshSeq }),
        ...(input.plan.readiness.assertions?.length ? { assertions: input.plan.readiness.assertions, targetDeadlineMs: input.plan.readiness.targetDeadlineMs } : {}),
        onReport(report) {
          if (expectBuild !== undefined && report.kind === 'document-loaded' && report.build === expectBuild) void send({ type: 'applied' }).catch(() => finish(1))
          void send({ type: 'report', report }).catch(() => finish(1))
        },
      })
      const allowedRoots = [root, ...await Promise.all((input.project.runtime.dependencyRoots ?? []).map(path => realpath(resolve(root, path))))]
      let accepting = false
      let swappable: SwappableScenario | undefined
      let origin = ''
      // webpack invalid → done/failed 的窗口内产物读可能瞬态失败：该窗口内的文档请求等本轮落盘后重试，不冒充 404。
      let compiling = false
      // invalid 序号（每次 watch 失效 +1）：场景更新据此识别「写入后才发生的失效」，
      // 写入前就挂起的编译的 settle 不含新入口，不能算作入口已生效（webpack 5 实测：
      // 编译中被 invalid 的轮次跳过 done/failed 钩子，settle 只属于失效后的重建）。
      let invalidSeq = 0
      const compileSettle = new Set<() => void>()
      const settleCompiles = () => { for (const waiter of compileSettle) waiter(); compileSettle.clear() }
      const waitCompile = () => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 30000)
        compileSettle.add(() => { clearTimeout(timer); resolve() })
      })
      // 项目 publicPath 前缀（mergeConfig 归一化后回传）；产物（含生成文档）只在前缀下映射。
      let docBase = '/'
      const httpDiagnostic = (
        code: Extract<CliWorkerOutput, { type: 'http-diagnostic' }>['code'],
        request?: { method: string | undefined; url: string; queryKeys?: string[] },
      ) => {
        // 被拦截请求转发 method/origin/path；query 值、userinfo 与 nonce 在统一脱敏中去除，只留键名供汇总。
        const target = request === undefined ? undefined : redactor.request(request.method, request.url, origin || 'http://127.0.0.1')
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
        try {
          return [...new Set(new URL(raw, origin || 'http://127.0.0.1').searchParams.keys())].sort()
        } catch { return undefined }
      }
      const emitCompileError = (errors: { message?: string; file?: string; line?: number; column?: number }[]) => {
        compiling = false
        settleCompiles()
        expectBuild = undefined
        // webpack 错误文件可带 `?vue&...` 查询后缀或为 loader 链后的相对路径；首选项目根内的模块错误，临时入口错误只作兜底。
        const normalize = (raw: string | undefined) => {
          const clean = raw?.split('?')[0]
          if (clean === undefined || clean === '') return undefined
          if (isAbsolute(clean)) return isWithinRoot(root, clean) ? relative(root, clean) : undefined
          return clean.startsWith('..') ? undefined : clean
        }
        const error = errors.find(value => normalize(value.file) !== undefined) ?? errors[0] ?? {}
        const file = normalize(error.file)
        // webpack/babel 常把行列只写进 message（"Unexpected token (3:0)"）；loc 缺失时从 message 提取兜底。
        const located = error.line === undefined && error.message !== undefined ? /[(:](\d+):(\d+)\)?/.exec(error.message) : undefined
        const line = error.line ?? (located ? Number(located[1]) : undefined)
        const column = error.column ?? (located ? Number(located[2]) + 1 : undefined)
        void send({ type: 'compile-error',
          ...(error.message === undefined ? {} : { message: redactor.text(error.message, CODE_FRAME_LIMIT) }),
          ...(file === undefined ? {} : { file: redactor.text(file) }),
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        }).catch(() => finish(1))
      }
      const outputFs = () => devServer?.middleware?.fileSystem ?? devServer?.middleware?.context?.outputFileSystem
      /**
       * 只有输出文件系统里真实存在的产物文件才放行：wdm v3 的 getFilenameFromUrl 对任意 URL 都给出映射路径
       * （不匹配时返回 false 而非 undefined），不能当作「产物存在」的证据。
       */
      const emittedFile = (url: string): string | undefined => {
        const middleware = devServer?.middleware
        if (typeof middleware?.getFilenameFromUrl !== 'function') return undefined
        try {
          const file = middleware.getFilenameFromUrl(url)
          const fs = outputFs()
          if (typeof file !== 'string' || !file || typeof fs?.statSync !== 'function') return undefined
          return fs.statSync(file).isFile() ? file : undefined
        } catch { return undefined }
      }
      const readEmitted = (url: string): string | undefined => {
        const file = emittedFile(url)
        const fs = outputFs()
        if (!file || typeof fs?.readFileSync !== 'function') return undefined
        try { return String(fs.readFileSync(file)) } catch { return undefined }
      }
      const publicDir = join(root, 'public')
      const browserFile = async (pathname: string) => {
        const file = await findStaticFile(publicDir, pathname)
        return file && isWithinRoot(root, file) ? file : undefined
      }
      // 已在 HTTP server 最外层经自有层判定放行的请求；express 栈中的同一中间件对其直接 next()。
      const admitted = new WeakSet<object>()
      /**
       * 自有层装在 HTTP server 的 request/upgrade 入口最外层（受理前、onReady 时同步安装）：
       * cli-service 自带的 /__open-in-editor、插件 configureDevServer 中间件、wds 内置路由及任何来源的
       * devServer 钩子都排在 express 栈里，只有自有层明确放行的产物/公共静态请求才会到达它们。
       * webSocketServer:false 时没有合法 Upgrade 通道：移除全部既有 upgrade 监听（含 ws 代理），一律销毁并上报。
       */
      const guardServer = (server: CliHttpServer) => {
        const upstream = server.listeners('request')
        server.removeAllListeners('request')
        server.on('request', ((req: IncomingMessage, res: ServerResponse) => {
          ownedLayer(req, res, () => {
            admitted.add(req)
            for (const listener of upstream) listener.call(server, req, res)
          })
        }) as (...args: never[]) => void)
        server.removeAllListeners('upgrade')
        server.on('upgrade', ((req: IncomingMessage, socket: { destroy: () => void }) => {
          // R5-1g：当前场景声明的 ws 通道播放固定序列；未声明 Upgrade 一律销毁并上报。
          const fixture = wsFixtureFor(swappable?.wsFixtures() ?? [], req)
          // F8：已准入连接上 >1 MiB 的帧按 1009 关闭并出 protocol_violation 诊断。
          if (fixture !== undefined) {
            serveWsFixture(fixture, req, socket as Socket, () => httpDiagnostic(
              DiagnosticCode.protocolViolation, { method: req.method, url: req.url ?? '/' }))
            return
          }
          httpDiagnostic(DiagnosticCode.blockedRequest, { method: req.method, url: req.url ?? '/' })
          socket.destroy()
        }) as (...args: never[]) => void)
      }
      const owned: Middleware = (req, res, next) => admitted.has(req) ? next() : ownedLayer(req, res, next)
      const ownedLayer: Middleware = (req, res, next) => layer.middleware(req, res, error => {
        const failResponse = () => { if (!res.headersSent) res.writeHead(500); res.end() }
        if (error) { failResponse(); return }
        void (async () => {
          if (!accepting) { res.writeHead(503); res.end(); return }
          const url = new URL(req.url ?? '/', 'http://preview.invalid')
          for (const [key, value] of Object.entries(layer.documentHeaders())) res.setHeader(key, value)
          if (req.headers.upgrade !== undefined) {
            httpDiagnostic(DiagnosticCode.blockedRequest, { method: req.method, url: req.url ?? '/' })
            res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify({ code: DiagnosticCode.blockedRequest })); return
          }
          const emittedDocPath = docBase + CLI_PAGE_PATH.slice(1)
          // 经 remote 通道还原的跨源业务请求：只交给 Mock/未命中，绝不当作文档或产物下发。
          const remote = remoteRequests.has(req)
          if (!remote && req.method === 'GET' && (url.pathname === CLI_PAGE_PATH || url.pathname === emittedDocPath)) {
            let html = readEmitted(emittedDocPath)
            if (html === undefined && compiling) { await waitCompile(); html = readEmitted(emittedDocPath) }
            if (html === undefined) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: DiagnosticCode.unmatchedRequest })); return }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(layer.transformDocument(html)); return
          }
          if (!remote && ['GET', 'HEAD'].includes(req.method ?? '')) {
            const destination = typeof req.headers['sec-fetch-dest'] === 'string' ? req.headers['sec-fetch-dest'] : undefined
            // webpack 产物（JS/CSS/sourcemap/资源）与 public 目录的业务静态文件放行给 dev-server 自身提供。
            // 与文档读同理：invalid→done/failed 窗口内产物读可能瞬态失败，等本轮落盘后重查，不把窗口期 404 当成未命中。
            const emitted = () => emittedFile(url.pathname + url.search) ?? emittedFile(url.pathname)
            if (emitted() === undefined && compiling) await waitCompile()
            if (emitted() !== undefined) { next(); return }
            const file = await browserFile(url.pathname)
            if (file !== undefined && destination !== undefined && ['document', 'iframe', 'frame', 'image', 'style', 'font', 'audio', 'video', 'script', 'worker', 'sharedworker', 'serviceworker'].includes(destination)) { next(); return }
          }
          const unmatched = () => { httpDiagnostic(DiagnosticCode.unmatchedRequest, { method: req.method, url: req.url ?? '/' }); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: DiagnosticCode.unmatchedRequest })) }
          if (swappable) swappable.middleware(req, res, error => {
            if (error) { httpDiagnostic(DiagnosticCode.runtimeError); failResponse() } else unmatched()
          })
          else unmatched()
        })().catch(failResponse)
      })
      // wds 主版本决定中间件注入形态（v3: devServer.before；v4+: setupMiddlewares）；解析失败按 v4 处理。
      const wdsMajor = (): number | undefined => {
        try {
          const pkg = createRequire(join(metadata.directory, 'package.json'))('webpack-dev-server/package.json') as { version?: unknown }
          const major = typeof pkg.version === 'string' ? Number(pkg.version.split('.')[0]) : NaN
          return Number.isFinite(major) ? major : undefined
        } catch { return undefined }
      }
      setCliWorkerState({
        owned,
        bindDevServer(value) { devServer = value as CliDevServer },
        // wds v3（cli-service 4）无 setupMiddlewares：mergeConfig 改走 devServer.before 注入。
        legacyDevServerHooks: wdsMajor() === 3,
        bindDocBase(value) { docBase = value },
        // 项目 devServer 字段被接管（R2-P0-1）：逐字段上报，由 runtime 转为诊断。
        onDevServerTakenOver(fields) { void send({ type: 'dev-server-diff', fields }).catch(() => finish(1)) },
        onCompiled(version) {
          compiling = false
          servedBuild = version ?? String(Date.now())
          expectBuild = servedBuild
          settleCompiles()
          void send({ type: 'compiled' }).catch(() => finish(1))
        },
        onInvalidated() { invalidSeq += 1; compiling = true },
        onCompileError: emitCompileError,
        onReady(value, server) {
          try {
            guardServer(server)
            origin = value
            // R3-2：可替换 Mock——无当前场景时 middleware 直接落到调用方未命中分支；
            // handlers 绑定已按批准固定。真实监听源就绪才创建：fixture 缺省 origin 与
            // remote 请求的同源判定都以它为准（与 Vite 路径一致）。
            swappable = createSwappableScenario({
              previewOrigin: value, appRoot: root,
              ...(project.runtime.dependencyRoots === undefined
                ? {} : { dependencyRoots: project.runtime.dependencyRoots }),
              handlers,
              onUnmatched: request => httpDiagnostic(DiagnosticCode.unmatchedRequest, {
                method: request.method, url: request.url,
                ...(request.queryKeys === undefined ? {} : { queryKeys: request.queryKeys }),
              }),
              onDiagnostic: diagnostic => httpDiagnostic(
                diagnostic.code === DiagnosticCode.configInvalid
                  || diagnostic.code === DiagnosticCode.unsupportedCapability
                  ? diagnostic.code
                  : DiagnosticCode.runtimeError),
              ...(scene === undefined || plan.scenario === undefined
                ? {} : { initial: { name: plan.scenario, scenario: scene } }),
            })
            accepting = true
          } catch (error) { void fail(error); return }
          void send({ type: 'ready', pid: process.pid, origin, nonce }).catch(() => finish(1))
        },
      })
      const handlers = scene?.handlers ? await loadProjectHandlers(root, scene.handlers, {
        ...(input.project.runtime.dependencyRoots ? { dependencyRoots: input.project.runtime.dependencyRoots } : {}),
        verifyExecution: () => new Promise<void>((resolve, reject) => {
          handlerVerified = resolve
          void send({ type: 'verify-handlers', pid: process.pid }).catch(reject)
        }),
      }) : []
      // R3-2：场景更新——原子换 Mock/Store，重写临时入口等本轮编译落盘（超时也如实回），
      // 再 bump 构建轮询 seq 让浏览器整页重载；不清 Cookie/Storage。
      onScenarioUpdate = raw => void (async () => {
        if (!accepting || swappable === undefined) throw new Error('Unexpected scenario update')
        const update = parseCliScenarioUpdate(raw)
        const next = sources.rerenderEntry(update.scenario)
        // 入口逐字节相同（场景差异只在 fixture/数据面）时 webpack 不会产出新构建，跳过重写；
        // 入口变了时，「已生效」只认由写后 invalid 触发并成功落盘的编译（产物印章更新）——
        // 写入前就挂起的编译的 settle 不含本入口；编译失败（印章不变）、watchpack 未察觉或
        // 编译挂起超时都不算生效。
        const previous = await readFile(sources.entry, 'utf8').catch(() => '')
        const changed = next !== previous
        let applied = !changed
        if (changed) {
          const servedBefore = servedBuild
          await writeFile(sources.entry, next, { mode: 0o600 })
          const mark = invalidSeq
          const deadline = Date.now() + 30000
          while ((invalidSeq === mark || compiling) && Date.now() < deadline) await waitCompile()
          applied = invalidSeq !== mark && !compiling && servedBuild !== servedBefore
        } else if (compiling) await waitCompile()
        // R5-0b（决策①）：入口未生效不换绑——服务中 Mock/Store 与已下发页面同属旧场景。
        // 入口写回旧内容：迟到/后续编译仍产旧场景。回滚时若有已读新入口的编译在跑，其产物
        // 会在回滚触发的重建覆盖前有界供出——该窗口如实 ack 未生效，不谎报已切换。
        if (!applied) {
          await writeFile(sources.entry, previous, { mode: 0o600 })
          await send({ type: 'scenario-ack', applied: false })
          return
        }
        // 换绑放最后：入口重写/编译失败不动服务中场景，旧 Mock/Store 仍一致服务。
        swappable.replace(update.name, update.scenario)
        refreshSeq += 1
        await send({ type: 'scenario-ack', stale: expectBuild === undefined })
      })().catch(async error => {
        try {
          await send({ type: 'scenario-ack',
            error: redactor.text(error instanceof Error ? error.message : String(error)) })
        } catch { await finish(1) }
      })
      const require = createRequire(join(metadata.directory, 'package.json'))
      const serviceModule: unknown = require(join(metadata.directory, 'lib', 'Service.js'))
      const Service = (serviceModule as { default?: unknown }).default ?? serviceModule
      if (typeof Service !== 'function') throw new Error('Vue CLI service export is invalid')
      // R2-6：项目 .env* 不进入预览进程（与 Vite envDir:false 对齐）；需要的变量必须在 runtime.env 显式声明。
      // loadEnv 只由 run→init 调用：实例覆写拦截 dotenv，同时保留 NODE_ENV/BABEL_ENV 的 mode 默认语义。
      process.env.NODE_ENV ??= 'development'
      process.env.BABEL_ENV ??= 'development'
      process.env.VUE_CLI_SERVICE_CONFIG_PATH = sources.config
      type CliService = {
        run: (name: string, args: Record<string, unknown>) => Promise<{ server?: CliDevServer } | undefined>
        loadEnv: (mode?: string) => void
        resolveWebpackConfig: (...args: unknown[]) => Record<string, unknown>
        devServerConfigFns?: unknown[]
      }
      const service = new (Service as new (context: string) => CliService)(root)
      // serve.js 以 Object.assign(webpackConfig.devServer, options.devServer) 合并：configureWebpack/chainWebpack
      // 里的 devServer 会绕过 mergeConfig 的接管；插件 api.configureDevServer 钩子排在自有中间件之前执行。
      // 两者都在解析出的 webpack 配置处整体移除且不执行，逐项进 devserver_taken_over 诊断。
      const resolveWebpackConfig = service.resolveWebpackConfig.bind(service)
      const strippedKeys = new Set<string>()
      service.resolveWebpackConfig = (...args) => {
        const config = resolveWebpackConfig(...args)
        const keys: string[] = []
        const nested = config.devServer
        if (nested && typeof nested === 'object') {
          keys.push(...Object.keys(nested).map(key => 'webpack.devServer.' + key))
        }
        delete config.devServer
        if (service.devServerConfigFns?.length) {
          keys.push('plugin.configureDevServer x' + service.devServerConfigFns.length)
          service.devServerConfigFns.length = 0
        }
        // resolveWebpackConfig 可被多次调用：同一字段只上报一次。
        const fresh = keys.filter(key => !strippedKeys.has(key)).slice(0, 64)
        fresh.forEach(key => strippedKeys.add(key))
        if (fresh.length) {
          const fields = fresh.map(key => ({ key: key.slice(0, 64), action: 'removed' as const }))
          void send({ type: 'dev-server-diff', fields }).catch(() => finish(1))
        }
        return config
      }
      service.loadEnv = mode => {
        if (mode) {
          const fallback = mode === 'production' || mode === 'test' ? mode : 'development'
          process.env.NODE_ENV ??= fallback
          process.env.BABEL_ENV ??= fallback
        }
      }
      // 端口经 serve args.port='0' 固定：truthy 字符串能通过 cli-service 的 || 链（数字 0 会被当成未设置而
      // 回落 8080）；portfinder 与 wds v3/v4 都把显式数字 0 原样下传到 listen(0)，由 OS 原子分配临时端口，
      // 没有 probe→bind 竞态窗口（EADDRINUSE 的 listen 失败在两代 wds 上都不经 run() 的 reject 回报，
      // 重试接不住——只有 listen(0) 从构造上消除竞态）。实际端口仍由 onReady 读 server.address()。
      const started = service.run('serve', { host: '127.0.0.1', port: '0', open: false, mode: 'development' })
        .catch(error => { void fail(error); return undefined })
      void started.then(result => { if (result?.server) devServer = result.server })
    })().catch(fail)
  })
  await send({ type: 'booted', pid: process.pid })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runCliWorker().catch(() => process.exit(1))
