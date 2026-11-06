/**
 * Vue CLI 包装配置与 worker 之间的同进程接缝（方案 §6.9）。worker 先 `setCliWorkerState`，
 * 生成的 vue.config.cjs 再 `require` 本模块取合并配置——nonce/响应层不写入临时配置文件，也不进 process.env。
 * 该文件同时被 worker（TS/ESM 加载）和包装配置（CJS require）使用，必须保持无副作用、可双重加载。
 */
import type { Middleware } from '../../../runner/response-layer/server.ts'

export interface CliMergeSpec { entry: string; template: string; pageName: string; pageFile: string }
export interface CliHookState {
  /** 完整自有中间件：响应层 → 预览文档/准入 → Mock/未命中；置于 dev-server 中间件最前。 */
  owned: Middleware
  bindDevServer: (devServer: unknown) => void
  /** webpack-dev-server v3 无 setupMiddlewares：注入改走 devServer.before(app) + inline:false。 */
  legacyDevServerHooks: boolean
  /** 项目 publicPath 前缀（已归一化为 /path/）；文档在根路径与产物前缀下都要按同一变换服务。 */
  bindDocBase: (path: string) => void
  /** 项目 devServer 中被接管（剥离/覆盖）的字段清单；只出现过的键被报告，供 worker 转诊断。 */
  onDevServerTakenOver: (fields: DevServerFieldAction[]) => void
  /** 成功编译的 webpack stats.hash 作为构建版本；缺失时 worker 兜底计数。 */
  onCompiled: (version?: string) => void
  /** webpack invalid：检测到变更、重建开始；产物读在窗口内可能瞬态失败（R2-P0-2）。 */
  onInvalidated: () => void
  /** webpack done 的全部编译错误字段（至多前 5 条）；哪个文件属于项目由 worker 判定。 */
  onCompileError: (errors: { message?: string; file?: string; line?: number; column?: number }[]) => void
  /** 首次编译完成且已监听：交出 HTTP server，worker 在受理前把自有层装到 request/upgrade 最外层。 */
  onReady: (origin: string, server: CliHttpServer) => void
}
/** dev-server 底层 HTTP server 的最小面：wds v4 为 `server`，v3 为 `listeningApp`。 */
export interface CliHttpServer {
  listening?: boolean
  once: (event: string, fn: () => void) => void
  address: () => unknown
  on: (event: string, fn: (...args: never[]) => void) => unknown
  listeners: (event: string) => Function[]
  removeAllListeners: (event: string) => unknown
}
let state: CliHookState | undefined
export function setCliWorkerState(value: CliHookState): void { state = value }

type DevServer = Record<string, unknown>
/** 原配置的对象/同步函数导出统一为对象；Promise 导出无法在同步配置入口中展开，显式拒绝。 */
export function resolveBase(original: unknown): Record<string, unknown> {
  const base = typeof original === 'function' ? (original as () => unknown)() : original
  if (base && typeof base === 'object' && typeof (base as { then?: unknown }).then === 'function') throw new Error('Asynchronous vue.config.js exports cannot be previewed; convert it to an object or synchronous function')
  return base && typeof base === 'object' ? base as Record<string, unknown> : {}
}
/** 项目 devServer 中被接管字段的处置：removed=移除且不执行；overridden=项目值被自有值/默认替代。 */
export interface DevServerFieldAction { key: string; action: 'removed' | 'overridden' }
/**
 * devServer 接管分类（R2-P0-1）：钩子/proxy/open/bonjour 会注入中间件或产生副作用，移除且不执行；
 * 监听/传输/响应头键由自有值替代；hot/liveReload/client/webSocketServer/inline/historyApiFallback
 * 为固定值——项目设置记为 overridden。其余键（compress、watchFiles 等只读开关）原样保留。
 */
const STRIP_DEVSERVER_KEYS = ['proxy', 'before', 'after', 'setupMiddlewares', 'onBeforeSetupMiddleware',
  'onAfterSetupMiddleware', 'onListening', 'open', 'bonjour'] as const
const OVERRIDE_DEVSERVER_KEYS = ['port', 'host', 'https', 'http2', 'server', 'allowedHosts', 'public',
  'headers', 'devMiddleware', 'ipc'] as const
const FIXED_DEVSERVER_KEYS = ['hot', 'liveReload', 'client', 'webSocketServer', 'inline', 'historyApiFallback'] as const
/** publicPath 只支持站点内路径：绝对 URL 会让资产绕过自有通道，相对路径无法映射产物。 */
const docBase = (value: unknown): string => {
  if (value === undefined || value === 'auto') return '/'
  if (typeof value !== 'string' || value === '') return '/'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    throw new Error('Project publicPath to another origin cannot be previewed: emitted assets bypass the owned channel')
  if (!value.startsWith('/'))
    throw new Error('Relative publicPath cannot be previewed: emitted assets would not map to the owned listener')
  return value.endsWith('/') ? value : value + '/'
}
export function mergeConfig(base: Record<string, unknown>, spec: CliMergeSpec): Record<string, unknown> {
  if (!state) throw new Error('Vue CLI preview worker state is not installed')
  const dev = { ...(base.devServer && typeof base.devServer === 'object' ? base.devServer as DevServer : {}) }
  const fields: DevServerFieldAction[] = []
  const drop = (key: string, action: DevServerFieldAction['action']) => {
    if (dev[key] === undefined) return
    delete dev[key]
    fields.push({ key, action })
  }
  for (const key of STRIP_DEVSERVER_KEYS) drop(key, 'removed')
  for (const key of OVERRIDE_DEVSERVER_KEYS) drop(key, 'overridden')
  for (const key of FIXED_DEVSERVER_KEYS) drop(key, 'overridden')
  // 其余函数值字段在 dev-server 上下文执行且无法核验注入面，一律移除。
  for (const key of Object.keys(dev)) if (typeof dev[key] === 'function') drop(key, 'removed')
  if (fields.length) state.onDevServerTakenOver(fields)
  state.bindDocBase(docBase(base.publicPath))
  return {
    ...base,
    pages: { [spec.pageName]: { entry: spec.entry, template: spec.template, filename: spec.pageFile } },
    devServer: state.legacyDevServerHooks
      ? {
          ...dev,
          host: '127.0.0.1',
          port: 0,
          inline: false,
          hot: false,
          liveReload: false,
          historyApiFallback: false,
          before: (app: CliExpressApp, devServer: unknown) => installV3(app, devServer as CliDevServerRef),
        }
      : {
          ...dev,
          host: '127.0.0.1',
          port: 0,
          client: false,
          hot: false,
          liveReload: false,
          webSocketServer: false,
          historyApiFallback: false,
          setupMiddlewares: (middlewares: CliMiddlewareItem[], devServer: unknown) => install(middlewares, devServer as CliDevServerRef),
        },
  }
}
interface CliDevServerRef {
  compiler: {
    hooks: {
      done: { tap: (name: string, fn: (stats: unknown) => void) => void }
      failed: { tap: (name: string, fn: (error: unknown) => void) => void }
      invalid: { tap: (name: string, fn: () => void) => void }
    }
    options?: { output?: { path?: string } }
  }
  server?: CliHttpServer
  listeningApp?: CliHttpServer
}
interface CliMiddlewareItem { name?: string; path?: string; middleware?: unknown }
interface CliExpressApp { use: (middleware: Middleware) => void }
/** wds v3 的 before(app, server)：自有中间件挂 express 最前，编译/监听钩子与 v4 相同。 */
function installV3(app: CliExpressApp, devServer: CliDevServerRef): void {
  const hook = state!
  app.use(hook.owned)
  wire(hook, devServer)
}
/** dev-server v4 在 createServer/listen 之前执行 setupMiddlewares：首次 done + listening 两者齐备才就绪。 */
function install(middlewares: CliMiddlewareItem[], devServer: CliDevServerRef): CliMiddlewareItem[] {
  const hook = state!
  wire(hook, devServer)
  return [{ name: 'dsh-page-preview-owned', middleware: hook.owned }, ...middlewares]
}
function wire(hook: CliHookState, serverRef: CliDevServerRef): void {
  let compiled = false
  let listening = false
  let announced = false
  hook.bindDevServer(serverRef)
  const announce = () => {
    if (!compiled || !listening || announced) return
    announced = true
    const server = serverRef.server ?? serverRef.listeningApp
    const address = server?.address()
    const port = address && typeof address === 'object' && typeof (address as { port?: unknown }).port === 'number'
      ? (address as { port: number }).port : undefined
    if (server && port !== undefined) hook.onReady('http://127.0.0.1:' + port, server)
  }
  const errorFields = (first: unknown): { message?: string; file?: string; line?: number; column?: number } => {
    if (!first || typeof first !== 'object') return {}
    const record = first as Record<string, unknown>
    const loc = record.loc && typeof record.loc === 'object' ? record.loc as { start?: { line?: unknown; column?: unknown } } : undefined
    const module = record.module && typeof record.module === 'object' ? record.module as { resource?: unknown } : undefined
    // webpack 5 错误的文件：ModuleBuildError 在 module.resource；其余看 file/moduleName/moduleIdentifier（loader 前缀取最后一段）。
    const raw = typeof module?.resource === 'string' ? module.resource
      : typeof record.file === 'string' ? record.file
      : typeof record.moduleName === 'string' ? record.moduleName
      : typeof record.moduleIdentifier === 'string' ? record.moduleIdentifier.split('!').pop() : undefined
    return {
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
      ...(raw === undefined ? {} : { file: raw }),
      ...(typeof loc?.start?.line === 'number' && loc.start.line > 0 ? { line: loc.start.line } : {}),
      // webpack loc.start.column 为 0 基；协议约定 1 基正整数。
      ...(typeof loc?.start?.column === 'number' ? { column: loc.start.column + 1 } : {}),
    }
  }
  serverRef.compiler.hooks.invalid.tap('dsh-page-preview', () => hook.onInvalidated())
  serverRef.compiler.hooks.done.tap('dsh-page-preview', stats => {
    const errors = stats && typeof stats === 'object' ? (stats as { compilation?: { errors?: unknown[] } }).compilation?.errors : undefined
    const hasErrors = stats && typeof stats === 'object' && typeof (stats as { hasErrors?: unknown }).hasErrors === 'function' ? Boolean((stats as { hasErrors: () => boolean }).hasErrors()) : false
    if (hasErrors) hook.onCompileError((Array.isArray(errors) ? errors : [stats]).slice(0, 5).map(errorFields))
    else hook.onCompiled(stats && typeof stats === 'object' && typeof (stats as { hash?: unknown }).hash === 'string' ? (stats as { hash: string }).hash : undefined)
    compiled = true
    announce()
  })
  serverRef.compiler.hooks.failed.tap('dsh-page-preview', error => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
    hook.onCompileError([message === undefined ? {} : { message }])
    compiled = true
    announce()
  })
  const watchServer = () => {
    const server = serverRef.server ?? serverRef.listeningApp
    if (!server) { setImmediate(watchServer); return }
    if (server.listening) { listening = true; announce(); return }
    server.once('listening', () => { listening = true; announce() })
  }
  setImmediate(watchServer)
}
