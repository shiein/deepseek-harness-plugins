/** Vue 浏览器编排失败/清理契约（方案 §6.3、§6.9）；假框架只验证顺序，真实 Vue 另作浏览器样本。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startVuePreview } from '../../src/browser/vue/lifecycle.js'

function fixture() {
  const children = []
  const body = { children, removeChild(node) { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1) } }
  const el = { ownerDocument: { body } }
  children.push(el)
  const events = []
  const Vue = {}
  const app = {}
  const handle = { unmount() { events.push('unmount') } }
  const runtime = {
    Vue,
    createPreviewApp() { events.push('create-app'); return { app, mount(container, Target, options) { events.push('mount-3'); assert.equal(container, el); assert.equal(Target.name, 'Target'); assert.equal(options.props.text, 'original'); return handle }, unmount() { events.push('prepared-unmount') } } },
    mountVue2(container, Target) { events.push('mount-2'); assert.equal(container, el); assert.equal(Target.name, 'Target'); return handle },
    async nextTick() { events.push('tick') },
  }
  const options = { major: '3', el, props: { text: 'original' }, async beforeImport() { events.push('prepare') }, async loadRuntime() { events.push('runtime'); return runtime }, async loadTarget() { events.push('target'); return { default: { name: 'Target' } } }, onMounted() { events.push('mounted') } }
  return { events, options, body, app, Vue }
}

test('network readiness precedes all imports, app precedes setup, scenario precedes target and signal follows tick', async () => {
  const { events, options, body, app } = fixture()
  let release
  let installation
  options.scenario = { identity: { id: 'own' }, permissions: ['read'], locale: 'zh-CN' }
  options.beforeImport = () => new Promise(resolve => { release = resolve })
  options.loadSetup = async () => {
    events.push('setup-import')
    body.children.push({ popup: true })
    return { default: {
      async install(args) { events.push('install'); assert.equal(args.app, app); assert.equal(args.scenario, options.scenario); installation = { rootOptions: { provide: { label: 'root' } } }; return installation },
      async createContext(args) { events.push('context'); assert.equal(args.installation, installation); return installation },
      async applyScenario(args) { events.push('scenario'); assert.equal(args.context, installation) },
      async dispose(args) { events.push('dispose'); assert.equal(args.context, installation) },
    } }
  }
  const pending = startVuePreview(options)
  await Promise.resolve()
  assert.deepEqual(events, [])
  release()
  const controller = await pending
  assert.deepEqual(events, ['runtime', 'create-app', 'setup-import', 'install', 'context', 'scenario', 'target', 'mount-3', 'tick', 'mounted'])
  await Promise.all([controller.stop(), controller.stop()])
  assert.deepEqual(events.slice(-2), ['unmount', 'dispose'])
  assert.equal(body.children.length, 1)
  const nextPreview = { newOwner: true }
  body.children.push(nextPreview)
  await controller.stop()
  assert.ok(body.children.includes(nextPreview), 'Repeated old stop must not clean a later preview')
})

test('Mock preparation failure performs no project imports and produces no mounted signal', async () => {
  const { events, options } = fixture()
  options.beforeImport = async () => { throw new Error('MOCK_NOT_READY') }
  await assert.rejects(startVuePreview(options), /MOCK_NOT_READY/)
  assert.deepEqual(events, [])
})

test('contextual scenario data cannot be claimed applied by an empty setup export', async () => {
  for (const scenario of [{ identity: {} }, { permissions: [] }, { state: {} }, { locale: '' }]) {
    const { events, options } = fixture()
    options.scenario = scenario
    options.loadSetup = async () => ({ default: {} })
    await assert.rejects(startVuePreview(options), /explicit setup binding hook/)
    assert.ok(!events.includes('target') && !events.includes('mounted'))
    assert.ok(events.includes('prepared-unmount'))
  }
})

test('cancellation after install disposes partial context without importing or mounting target', async () => {
  const { events, options, body } = fixture()
  const abort = new AbortController()
  options.signal = abort.signal
  options.loadSetup = async () => ({ default: {
    install() { events.push('install'); body.children.push({ popup: true }); abort.abort() },
    dispose() { events.push('dispose') },
  } })
  await assert.rejects(startVuePreview(options), { name: 'AbortError' })
  assert.ok(!events.includes('target') && !events.includes('mounted'))
  assert.ok(events.includes('dispose'))
  assert.equal(body.children.length, 1)
})

test('target export failure tears down setup and preserves initialization plus cleanup errors', async () => {
  const { events, options } = fixture()
  options.loadTarget = async () => ({})
  options.loadSetup = async () => ({ default: { dispose() { events.push('dispose'); throw new Error('DISPOSE_FAILED') } } })
  await assert.rejects(startVuePreview(options), error => {
    assert.match(error.message, /initialization and teardown failed/)
    assert.match(error.errors[0].message, /component export/)
    assert.match(error.errors[1].errors[0].message, /DISPOSE_FAILED/)
    return true
  })
  assert.ok(events.includes('dispose') && !events.includes('mounted'))
})

test('failed disposal remains retryable and successful disposal becomes idempotent', async () => {
  const { events, options } = fixture()
  let attempts = 0
  options.loadSetup = async () => ({ default: { dispose() { if (++attempts === 1) throw new Error('RETRY_DISPOSE') } } })
  const controller = await startVuePreview(options)
  await assert.rejects(controller.stop(), error => error.errors[0].message === 'RETRY_DISPOSE')
  await controller.stop()
  await controller.stop()
  assert.equal(attempts, 2)
  assert.equal(events.filter(value => value === 'unmount').length, 1)
})

test('Vue 2 supplies the project constructor and uses its own mount helper', async () => {
  const { events, options, Vue } = fixture()
  options.major = '2'
  options.loadSetup = async () => ({ default: { install(args) { assert.equal(args.Vue, Vue); assert.equal(args.app, undefined) } } })
  const controller = await startVuePreview(options)
  assert.ok(events.includes('mount-2') && !events.includes('create-app'))
  await controller.stop()
})

test('reviewed navigation follows scenario preparation and must resolve the requested route before target import', async () => {
  const { events, options } = fixture()
  options.navigation = { route: {path:'/orders/:id',params:{id:'42'},query:{tab:'active'}}, href:'/orders/42?tab=active#details' }
  options.loadSetup = async () => ({ default: {
    applyScenario() { events.push('scenario') },
    navigate(args) { events.push('navigate'); assert.equal(args.route, options.navigation.route); return '/orders/42?tab=active#details' },
  } })
  const controller = await startVuePreview(options)
  assert.ok(events.indexOf('scenario') < events.indexOf('navigate'))
  assert.ok(events.indexOf('navigate') < events.indexOf('target'))
  await controller.stop()
})

test('missing, failed or redirected navigation never imports or mounts the target and disposes initialization', async () => {
  for (const navigate of [undefined, () => undefined, () => '/login', () => '//outside.invalid/orders/42', () => { throw new Error('GUARD_REJECTED') }]) {
    const { events, options } = fixture()
    options.navigation = {route:{path:'/orders/42'},href:'/orders/42'}
    options.loadSetup = async () => ({default:{ ...(navigate ? {navigate} : {}), dispose() { events.push('dispose') } }})
    await assert.rejects(startVuePreview(options))
    assert.ok(!events.includes('target') && !events.includes('mounted'))
    assert.ok(events.includes('dispose'))
  }
})
