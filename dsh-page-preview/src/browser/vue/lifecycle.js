/*
 * Vue 浏览器启动编排（方案 §6.3、§6.9）。纯 JS/ES2018；import 本模块没有副作用。
 * 调用者显式提供网络准备、动态 setup/目标加载及框架模块；挂载信号不等于 Runner ready。
 * 新增 body 节点只在本次隔离文档内清理，不用于 attach，不操作 Cookie/Storage。
 */
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[dsh-page-preview] invalid ' + label)
  return value
}
function hook(setup, name) {
  if (setup[name] !== undefined && typeof setup[name] !== 'function') throw new Error('[dsh-page-preview] invalid setup.' + name)
  return setup[name]
}
function checkSignal(signal) {
  if (signal && signal.aborted) {
    var error = new Error('[dsh-page-preview] preview initialization cancelled')
    error.name = 'AbortError'
    throw error
  }
}
function sameNavigation(actual, expected) {
  if (typeof actual !== 'string' || !actual.startsWith('/') || actual.startsWith('//') || /[\\\0\r\n]/.test(actual)) return false
  var result = new URL(actual, 'http://preview.invalid')
  var target = new URL(expected, 'http://preview.invalid')
  result.searchParams.sort()
  target.searchParams.sort()
  return result.href === target.href
}

export async function startVuePreview(options) {
  if (typeof options.beforeImport !== 'function' || typeof options.loadTarget !== 'function' || typeof options.loadRuntime !== 'function') throw new Error('[dsh-page-preview] explicit import preparation, runtime and target loaders are required')
  if (options.loadSetup !== undefined && options.loadSetup !== null && typeof options.loadSetup !== 'function') throw new Error('[dsh-page-preview] invalid setup loader')
  if (options.major !== '2' && options.major !== '3') throw new Error('[dsh-page-preview] unsupported Vue runtime')
  var el = options.el
  if (!el || !el.ownerDocument || !el.ownerDocument.body) throw new Error('[dsh-page-preview] mount container is missing')
  var body = el.ownerDocument.body
  var baseline = new Set(Array.from(body.children))
  var runtime
  var setup = {}
  var installation
  var context = {}
  var mounted
  var prepared
  var setupDisposed = false
  var stopping
  var stopped = false
  async function stop() {
    if (stopped) return
    if (stopping) return stopping
    stopping = (async function () {
      var errors = []
      try {
        if (mounted) { mounted.unmount(); mounted = null }
        else if (prepared) prepared.unmount()
      } catch (error) { errors.push(error) }
      if (!setupDisposed) {
        try {
          var dispose = hook(setup, 'dispose')
          if (dispose) await dispose({ context: context, installation: installation })
          setupDisposed = true
        } catch (error) { errors.push(error) }
      }
      // 只清理初始化后新增的 body 直系节点；已有容器中的残留由项目 dispose 负责。
      Array.from(body.children).forEach(function (node) { if (!baseline.has(node)) body.removeChild(node) })
      if (errors.length) {
        var failure = new Error('[dsh-page-preview] preview teardown failed')
        failure.errors = errors
        throw failure
      }
      stopped = true
    })()
    try { return await stopping } finally { stopping = null }
  }
  try {
    checkSignal(options.signal)
    await options.beforeImport()
    checkSignal(options.signal)
    runtime = await options.loadRuntime()
    checkSignal(options.signal)
    if (options.major === '3') prepared = runtime.createPreviewApp()
    var app = prepared && prepared.app
    var Vue = options.major === '2' ? runtime.Vue : undefined
    if (options.loadSetup) {
      var module = await options.loadSetup()
      setup = object(module && module.default, 'setup default export')
    }
    checkSignal(options.signal)
    var contextualScene = options.scenario && ['identity', 'permissions', 'state', 'locale'].some(function (name) { return options.scenario[name] !== undefined })
    if (contextualScene && !['install', 'createContext', 'applyScenario'].some(function (name) { return typeof setup[name] === 'function' })) throw new Error('[dsh-page-preview] scenario data requires an explicit setup binding hook')
    var install = hook(setup, 'install')
    if (install) installation = await install({ Vue: Vue, app: app, scenario: options.scenario })
    checkSignal(options.signal)
    var createContext = hook(setup, 'createContext')
    if (createContext) context = object(await createContext({ Vue: Vue, app: app, scenario: options.scenario, target: options.target, installation: installation }), 'setup context')
    var rootOptions = context.rootOptions === undefined ? {} : object(context.rootOptions, 'rootOptions')
    var props = options.props === undefined ? {} : object(options.props, 'props')
    checkSignal(options.signal)
    var applyScenario = hook(setup, 'applyScenario')
    if (applyScenario) await applyScenario({ scenario: options.scenario, context: context, installation: installation })
    checkSignal(options.signal)
    if (options.navigation) {
      var navigate = hook(setup, 'navigate')
      if (!navigate) throw new Error('[dsh-page-preview] navigation requires an explicit setup.navigate binding')
      var resolved = await navigate({ route: options.navigation.route, href: options.navigation.href, context: context, installation: installation })
      if (!sameNavigation(resolved, options.navigation.href)) throw new Error('[dsh-page-preview] project navigation did not resolve the requested route')
      checkSignal(options.signal)
    }
    var targetModule = await options.loadTarget()
    var exportName = options.exportName === undefined ? 'default' : options.exportName
    var Target = targetModule && Object.prototype.hasOwnProperty.call(targetModule, exportName) && targetModule[exportName]
    if (!Target || typeof Target !== 'object' && typeof Target !== 'function') throw new Error('[dsh-page-preview] target component export is missing or invalid')
    if (context.wrap !== undefined && context.wrap !== null && typeof context.wrap !== 'object' && typeof context.wrap !== 'function') throw new Error('[dsh-page-preview] invalid context.wrap')
    checkSignal(options.signal)
    var mounting = { props: props, rootOptions: rootOptions, wrap: context.wrap }
    mounted = options.major === '2' ? runtime.mountVue2(el, Target, mounting) : prepared.mount(el, Target, mounting)
    await runtime.nextTick()
    checkSignal(options.signal)
    if (options.onMounted) options.onMounted({ framework: options.major })
    return { stop: stop }
  } catch (error) {
    try { await stop() } catch (cleanupError) {
      var failure = new Error('[dsh-page-preview] initialization and teardown failed')
      failure.errors = [error, cleanupError]
      throw failure
    }
    throw error
  }
}
