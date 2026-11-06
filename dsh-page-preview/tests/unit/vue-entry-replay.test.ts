/** Vue 入口重放（方案 §6.3、§6.9、§15.3）；生成代码只在临时受控子进程执行，不加载真实项目或 Vue。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { generateSetupDraft, parseEntryRegistrations } from '../../src/adapters/vue/entry-replay.ts'
const execute = promisify(execFile)

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-entry-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  await put('package.json', { dependencies: { vue: '^3', 'test-ui': '^1', 'test-locale': '^1', 'test-client': '^1' } })
  return { root, put }
}

test('Vue 2 third-party and business registrations keep aliases/options/root instances; App never copied', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.ts', `import Framework from 'vue'
import App from './App.vue'
import Kit, { Widget as Card, focus } from 'test-ui'
import locale from 'test-locale/zh'
import client from 'test-client'
import router from './router'
import './permission'
const size: string = 'small'
const options = { locale, size }
Framework.use(Kit, options as object)
Framework.component('test-card', Card)
Framework.directive('focus', focus)
Framework.prototype.$client = client
const kit = new Kit({ locale })
new Framework({ render: h => h(App), router, kit }).$mount('#app')`)
  const result = await parseEntryRegistrations(root, 'src/main.ts')
  assert.equal(result.invalid, false)
  // 2026-11-03 决策（§0.3 第 10 条）：业务副作用导入与业务根选项也重放；网络仍由 mock-only 控制。
  assert.deepEqual(result.registrations.map(value => [value.kind, value.origin, !!value.replay]), [
    ['side-effect-import', 'business', true], ['use', 'third-party', true], ['component', 'third-party', true],
    ['directive', 'third-party', true], ['global-property', 'third-party', true], ['root-option', 'business', true],
    ['root-option', 'third-party', true],
  ])
  const draft = generateSetupDraft(result, '2.7')
  assert.match(draft, /await import\("test-ui"\)/)
  assert.match(draft, /const options = \{ locale, size \}/)
  assert.match(draft, /\["kit"\] = kit/)
  assert.match(draft, /\["router"\] = router/)
  assert.match(draft, /\.prototype\["\$client"\]/)
  assert.match(draft, /await import\(".*\/src\/permission"\)/)
  assert.doesNotMatch(draft, /import\("vue"\)|App.vue|as object|: string/)
  assert.ok(!result.diagnostics.some(value => /root-option/.test(value)))
  assert.throws(() => generateSetupDraft(result, '3'), /differs/)
})

test('Vue 3 chained registrations keep inner-first order and globalProperties use the supplied app', async t => {
  const { root, put } = await fixture(t)
  await put('main.js', `import { createApp as create } from 'vue'
import App from './App.vue'
import Kit, { Button, focus } from 'test-ui'
import client from 'test-client'
const application = create(App).use(Kit).component('button', Button)
application.directive('focus', focus)
application.config.globalProperties.$client = client
application.mount('#app')`)
  const result = await parseEntryRegistrations(root, 'main.js')
  assert.deepEqual(result.draft.frameworks, ['3'])
  assert.deepEqual(result.registrations.map(value => value.kind), ['use', 'component', 'directive', 'global-property'])
  assert.ok(result.registrations.every(value => !!value.replay))
  const draft = generateSetupDraft(result, '3')
  assert.ok(draft.indexOf('["use"]') < draft.indexOf('["component"]'))
  assert.match(draft, /\.config\.globalProperties\["\$client"\]/)
  assert.doesNotMatch(draft, /create\(App\)|\.mount\(|import\("vue"\)|App.vue/)
})

test('styles retain actual order and resolved custom themes; no default UI stylesheet is invented', async t => {
  const { root, put } = await fixture(t)
  await put('vite.config.ts', `import path from 'node:path'; export default { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } }`)
  await put('src/styles/theme.scss', '$color: red;')
  await put('src/styles/base.css', 'body { color: red }')
  await put('src/main.js', `import Vue from 'vue'
import 'test-ui/theme.css'
import '@/styles/theme.scss'
import './styles/base.css'
import Kit from 'test-ui'
Vue.use(Kit)`)
  const result = await parseEntryRegistrations(root, 'src/main.js')
  assert.deepEqual(result.registrations.map(value => value.origin), ['third-party', 'business', 'business', 'third-party'])
  assert.ok(result.registrations.every(value => value.replay))
  const draft = generateSetupDraft(result, '2.6')
  assert.ok(draft.indexOf('test-ui/theme.css') < draft.indexOf('src/styles/theme.scss'))
  assert.ok(draft.indexOf('src/styles/theme.scss') < draft.indexOf('src/styles/base.css'))
  assert.doesNotMatch(draft, /theme-chalk|reset.css|element-plus/)
})

test('aliases to business and regex aliases are replayed as project code; an aliased framework is not', async t => {
  // 2026-11-03（§0.3 第 10 条）：业务注册也重放；正则别名命中的说明符原样交给项目构建器解析。
  const { root, put } = await fixture(t)
  await put('main.js', `import Vue from 'vue'; import Kit from 'test-ui'; Vue.use(Kit)`)
  await put('vite.config.js', `export default { resolve: { alias: { 'test-ui': './src/business-ui.js' } } }`)
  let result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.registrations[0]?.origin, 'business')
  assert.ok(result.registrations[0]?.replay)
  assert.match(generateSetupDraft(result, '2.6'), /await import\(".*\/src\/business-ui\.js"\)/)
  await put('vite.config.js', `export default { resolve: { alias: [{ find: /^test/, replacement: dir('src') }] } }`)
  result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.registrations[0]?.origin, 'business')
  assert.match(generateSetupDraft(result, '2.6'), /await import\("test-ui"\)/, 'regex-aliased specifier kept verbatim')
  await put('vite.config.js', `export default { resolve: { alias: { vue: './src/business-vue.js' } } }`)
  result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.registrations[0]?.replay, undefined)
})

test('business options contaminate third-party registration rather than being silently dropped', async t => {
  const { root, put } = await fixture(t)
  await put('entry.tsx', `import Vue from 'vue'
import Kit from 'test-ui'
import permissions from './permissions'
const options = { permissions }
Vue.use(Kit, options)
Vue.component('inline', { render: h => <div /> })
Vue.use(await import('test-ui'))`)
  const result = await parseEntryRegistrations(root, 'entry.tsx')
  assert.equal(result.invalid, false)
  assert.deepEqual(result.registrations.map(value => value.origin), ['business', 'unresolved', 'unresolved'])
  // 业务选项随注册一起重放（不被静默丢弃）；JSX 内联组件与动态导入仍需手写。
  assert.deepEqual(result.registrations.map(value => !!value.replay), [true, false, false])
  assert.ok(result.diagnostics.some(value => /Dynamic entry import/.test(value)))
  const draft = generateSetupDraft(result, '2.7')
  assert.match(draft, /permissions/)
  assert.doesNotMatch(draft, /<div/)
})

test('conditional, optional, shadowed and multiple-root registrations require manual setup', async t => {
  const { root, put } = await fixture(t)
  await put('main.js', `import Vue from 'vue'; import Kit from 'test-ui'
if (condition) Vue.use(Kit)
function hidden(Vue) { Vue.component('x', Kit) }
Vue?.use(Kit)
condition && Vue.use(Kit)`)
  let result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.registrations.length, 4)
  assert.ok(result.registrations.every(value => value.origin === 'unresolved' && !value.replay))
  await put('main.js', `import { createApp } from 'vue'; import Kit from 'test-ui'
const first = createApp({}); const second = createApp({}); first.use(Kit); second.use(Kit)`)
  result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.registrations.length, 2)
  assert.ok(result.registrations.every(value => value.origin === 'unresolved' && !value.replay))
  assert.ok(result.diagnostics.some(value => /Several Vue root/.test(value)))
})

test('mutated, escaped, cyclic or computed constants never replay only their initial value', async t => {
  const { root, put } = await fixture(t)
  for (const snippet of [
    'const options = {}; options.locale = "zh"; Vue.use(Kit, options)',
    'const options = {}; customize(options); Vue.use(Kit, options)',
    'const options = {}; options.patch(); Vue.use(Kit, options)',
    'const options = { nested }; const nested = { options }; Vue.use(Kit, options)',
    'const options = { [dynamic]: "zh" }; Vue.use(Kit, options)',
  ]) {
    await put('main.js', `import Vue from 'vue'; import Kit from 'test-ui'; ${snippet}`)
    const result = await parseEntryRegistrations(root, 'main.js')
    assert.equal(result.registrations.at(-1)?.origin, 'unresolved', snippet)
    assert.equal(result.registrations.at(-1)?.replay, undefined, snippet)
  }
})

test('Vue 2 multiple root options do not merge while global registration remains shared', async t => {
  const { root, put } = await fixture(t)
  await put('main.js', `import Vue from 'vue'; import Kit from 'test-ui'; Vue.use(Kit)
const first = new Kit({ name: 'first' }); const second = new Kit({ name: 'second' })
new Vue({ kit: first }); new Vue({ kit: second })`)
  const result = await parseEntryRegistrations(root, 'main.js')
  assert.ok(result.registrations.find(value => value.kind === 'use')?.replay)
  assert.ok(result.registrations.filter(value => value.kind === 'root-option').every(value => !value.replay))
  assert.ok(result.diagnostics.some(value => /Several Vue 2 roots/.test(value)))
})

test('invalid syntax fails explicitly; type imports, undeclared packages and side effects are not invented registrations', async t => {
  const { root, put } = await fixture(t)
  await put('main.ts', `import Vue from 'vue'; Vue.use(`)
  let result = await parseEntryRegistrations(root, 'main.ts')
  assert.equal(result.invalid, true)
  assert.deepEqual(result.registrations, [])
  assert.throws(() => generateSetupDraft(result, '2.7'), /invalid entry syntax/)
  await put('main.ts', `import Vue from 'vue'; import type { Options } from 'test-ui'; import Unknown from 'undeclared'; import 'test-ui/register'; Vue.use(Unknown)`)
  result = await parseEntryRegistrations(root, 'main.ts')
  assert.equal(result.registrations.find(value => value.kind === 'use')?.origin, 'unresolved')
  // 已声明依赖的副作用导入按原顺序重放；未声明的包与纯类型导入不会凭空生成注册。
  assert.ok(result.registrations.find(value => value.kind === 'side-effect-import')?.replay)
  const draft = generateSetupDraft(result, '2.7')
  assert.match(draft, /await import\("test-ui\/register"\)/)
  assert.doesNotMatch(draft, /undeclared|\bOptions\b/)
  await assert.rejects(parseEntryRegistrations(root, 'missing.js'), /entry is missing/)
  await assert.rejects(parseEntryRegistrations(root, '../outside.js'), /outside application/)
})

test('generated ES2018 draft executes in a controlled child with exact import/registration order and per-install context', async t => {
  const { root, put } = await fixture(t)
  await put('node_modules/test-ui/package.json', { name: 'test-ui', type: 'module', exports: './index.js' })
  await put('node_modules/test-ui/index.js', `globalThis.events.push('import-ui'); export default class Kit { constructor(options) { this.options = options } }; export const Widget = { kind: 'widget' }`)
  await put('node_modules/test-locale/package.json', { name: 'test-locale', type: 'module', exports: './index.js' })
  await put('node_modules/test-locale/index.js', `globalThis.events.push('import-locale'); export default { name: 'zh' }`)
  await put('src/main.ts', `import Framework from 'vue'
import Kit, { Widget } from 'test-ui'
import locale from 'test-locale'
import App from './App.vue'
const __previewFramework = 'reserved'
const options: object = { locale, size: 'small' }
Framework.use(Kit, options)
Framework.component('widget', Widget)
const kit = new Kit({ locale })
new Framework({ kit, render: h => h(App) })`)
  const result = await parseEntryRegistrations(root, 'src/main.ts')
  const draft = generateSetupDraft(result, '2.7')
  await put('preview.setup.mjs', draft)
  await put('run.mjs', `import assert from 'node:assert/strict'
globalThis.events = []
const setup = (await import('./preview.setup.mjs')).default
const Framework = { use(kit, options) { globalThis.events.push('use'); assert.equal(options.locale.name, 'zh'); assert.equal(options.size, 'small') }, component(name, target) { globalThis.events.push('component'); assert.equal(name, 'widget'); assert.equal(target.kind, 'widget') } }
const first = await setup.install({ Vue: Framework })
const context = await setup.createContext({ installation: first })
assert.equal(context, first)
assert.equal(context.rootOptions.kit.options.locale.name, 'zh')
const second = await setup.install({ Vue: Framework })
assert.notEqual(first.rootOptions.kit, second.rootOptions.kit)
assert.deepEqual(globalThis.events, ['import-ui', 'import-locale', 'use', 'component', 'use', 'component'])
console.log('controlled child passed')`)
  await execute(process.execPath, ['--check', join(root, 'preview.setup.mjs')])
  const child = await execute(process.execPath, [join(root, 'run.mjs')], { cwd: root, env: {} })
  assert.match(child.stdout, /controlled child passed/)
  assert.equal(child.stderr, '')
  assert.match(draft, /__previewFramework1/)
  assert.ok(!draft.includes(pathToFileURL(join(root, 'src/App.vue')).href))
})

test('a Vue 3 app created inside a top-level initializer is transplanted with its call chain kept verbatim',
  async t => {
  // overview/web 形态（2026-11-03）：createApp 包在 async function initVue() 里、入口顶层按条件选择
  // initVue() 或先登录的 getLoginInfo()；R5-1d 起整条调用链原样重放——登录/接口调用按入口执行，
  // 网络由 mock-only 控制。业务 store/插件/指令、forEach 注册全局组件、正则别名导入与全局样式都要随初始化重放。
  const { root, put } = await fixture(t)
  await put('package.json', { dependencies: { vue: '^3', 'test-ui': '^1', 'vue-router': '^4' } })
  await put('vite.config.ts', `import { resolve } from 'path'
const dir = (name) => resolve(__dirname, name)
export default { resolve: { alias: [{ find: /\\/@\\//, replacement: dir('src') + '/' }] } }`)
  await put('node_modules/test-ui/package.json', { name: 'test-ui', type: 'module',
    exports: { '.': './index.js', './icons': './icons.js', './style.css': './style.css' } })
  await put('node_modules/test-ui/index.js', `globalThis.events.push('import-ui'); export default { name: 'kit' }`)
  await put('node_modules/test-ui/icons.js',
    `export const Star = { name: 'Star' }; export const Moon = { name: 'Moon' }`)
  await put('node_modules/test-ui/style.css', '')
  await put('node_modules/vue-router/package.json', { name: 'vue-router', type: 'module', exports: './index.js' })
  await put('node_modules/vue-router/index.js', `export function createMemoryHistory() { return { memory: true } }
export function createRouter(options) {
  globalThis.events.push('inert-router')
  return { inert: true, options, beforeEach() {}, addRoute() {}, currentRoute: {} }
}`)
  await put('src/main.ts', `import '/@/polyfill'
import { createApp } from 'vue'
import Kit from 'test-ui'
import * as icons from 'test-ui/icons'
import App from './App.vue'
import { router } from '/@/router'
import { store } from '/@/store'
import { loginApi } from '/@/api'
import 'test-ui/style.css'
async function getLoginInfo() { await loginApi.info(); initVue() }
async function initVue() {
  let vueApp = createApp(App)
  let app = vueApp.use(router).use(store).use(Kit)
  app.directive('focus', { mounted() {} })
  Object.keys(icons).forEach((key) => { app.component(key, icons[key]) })
  app.config.globalProperties.$kit = Kit
  app.mount('#app')
}
const token: string | null = null
if (!token) initVue(); else getLoginInfo()`)
  const result = await parseEntryRegistrations(root, 'src/main.ts')
  assert.equal(result.draft.transplant?.name, 'initVue')
  assert.deepEqual(result.draft.frameworks, ['3'])
  assert.deepEqual(result.diagnostics, [])
  const draft = generateSetupDraft(result, '3', { importPath: file => 'fs:' + file })
  assert.match(draft, /await import\("\/@\/polyfill"\)/, 'regex-aliased side-effect import kept verbatim, in order')
  assert.match(draft, /await import\("test-ui\/style\.css"\)/)
  // R5-1d：登录前置链 getLoginInfo→initVue 与顶层条件调用原样进入草稿，链内调用注入 await。
  assert.match(draft, /const getLoginInfo = async \(\) => \{\s+await loginApi\.info\(\);\s+await initVue\(\)/)
  assert.match(draft, /if \(!token\)\s*await initVue\(\);\s*else\s*await getLoginInfo\(\)/)
  assert.match(draft, /const loginApi = __previewModule\d+\["loginApi"\]/)
  assert.doesNotMatch(draft, /App\.vue|\.mount\(|createApp/)
  // 受控子进程执行：别名模块用真实文件代替，验证注册顺序、路由替换、mount 去除与 token 分支选择。
  // Node 不能导入 .css：子进程里去掉样式导入（顺序已由上面的断言覆盖）。
  const runnable = draft.replace(/"\/@\/(\w+)"/g, (_, name) => JSON.stringify('./src/' + name + '.js'))
    .replace(/await import\("test-ui\/style\.css"\)/, '')
  await put('src/polyfill.js', `globalThis.events.push('polyfill')`)
  await put('src/router.js',
    `export const router = { business: true, beforeEach() {}, addRoute() {}, currentRoute: {} }`)
  await put('src/store.js', `export const store = { name: 'store' }`)
  await put('src/api.js', `globalThis.events.push('import-api')
export const loginApi = { info: async () => { globalThis.events.push('login') } }`)
  await put('preview.setup.mjs', runnable)
  await put('run.mjs', `import assert from 'node:assert/strict'
globalThis.events = []
const setup = (await import('./preview.setup.mjs')).default
const used = [], components = [], directives = []
const app = { config: { globalProperties: {} },
  use(plugin) {
    const label = plugin.inert ? 'inert-router' : plugin.name ?? 'business-router'
    used.push(label)
    return this
  },
  component(name) { components.push(name); return this }, directive(name) { directives.push(name); return this },
  mount() { throw new Error('mount must not be replayed') } }
const originalUse = app.use
await setup.install({ app })
assert.deepEqual(used, ['inert-router', 'store', 'kit'])
assert.deepEqual(components, ['Moon', 'Star'])
assert.deepEqual(directives, ['focus'])
assert.equal(app.config.globalProperties.$kit.name, 'kit')
assert.equal(app.use, originalUse, 'app.use is restored after install')
// token 为 null → 入口条件语句选择 initVue() 分支，getLoginInfo 已声明但不执行（loginApi.info 未调）。
assert.deepEqual(globalThis.events, ['inert-router', 'polyfill', 'import-ui', 'import-api'])
console.log('transplant child passed')`)
  await execute(process.execPath, ['--check', join(root, 'preview.setup.mjs')])
  const child = await execute(process.execPath, [join(root, 'run.mjs')], { cwd: root, env: {} })
  assert.match(child.stdout, /transplant child passed/)
})

test('a truthy entry token drives the login chain first, then the initializer, through the original flow', async t => {
  // R5-1d：入口先调登录接口、再 initVue() 的形态。token 来自入口导入（复制的 const 递归收口其依赖），
  // 场景未提供 fixture 时该请求在预览里仍是 unmatched_request——setup 层如实照搬，不伪造已登录。
  const { root, put } = await fixture(t)
  await put('src/main.ts', `import { createApp } from 'vue'
import App from './App.vue'
import { loginApi } from './api'
import { getToken } from './auth'
async function getLoginInfo() { await loginApi.info(); initVue() }
async function initVue() { const app = createApp(App); app.mount('#app') }
const token = getToken()
if (!token) initVue(); else getLoginInfo()`)
  const result = await parseEntryRegistrations(root, 'src/main.ts')
  assert.equal(result.draft.transplant?.name, 'initVue')
  assert.deepEqual(result.diagnostics, [])
  // 相对说明符在草稿里是绝对路径；importPath 映射回受控子进程可执行的本地文件。
  const draft = generateSetupDraft(result, '3', {
    importPath: file => './src/' + file.split('/').pop() + '.js',
  })
  // 复制的 const 的初始化器调用入口导入：getToken 的 import 必须随 token 一起收口。
  assert.match(draft, /const token = getToken\(\)/)
  assert.match(draft, /const getToken = __previewModule\d+\["getToken"\]/)
  assert.match(draft, /if \(!token\)\s*await initVue\(\);\s*else\s*await getLoginInfo\(\)/)
  await put('src/api.js', `export const loginApi = { info: async () => { globalThis.events.push('login') } }`)
  await put('src/auth.js', `export function getToken() { return 'present' }`)
  await put('preview.setup.mjs', draft)
  await put('run.mjs', `import assert from 'node:assert/strict'
globalThis.events = []
const setup = (await import('./preview.setup.mjs')).default
const app = { config: { globalProperties: {} }, use() { return this },
  mount() { throw new Error('mount must not be replayed') } }
await setup.install({ app })
// 原业务流程：login 事件必须先于 initVue 的副作用（app 占位创建）。
assert.deepEqual(globalThis.events, ['login'])
console.log('login chain child passed')`)
  await execute(process.execPath, ['--check', join(root, 'preview.setup.mjs')])
  const child = await execute(process.execPath, [join(root, 'run.mjs')], { cwd: root, env: {} })
  assert.match(child.stdout, /login chain child passed/)
})

test('an unreplayable entry function in the chain is reported and the initializer still runs alone', async t => {
  // 失败路径（R5-1d）：链上函数引用入口内其他声明 → 该函数与调用它的顶层语句如实丢弃，
  // 初始化器照常搬运并直接执行；诊断逐项列出不重放的成员。
  const { root, put } = await fixture(t)
  await put('src/main.ts', `import { createApp } from 'vue'
import App from './App.vue'
import { loginApi } from './api'
function formatUser(user) { return user.name }
async function getLoginInfo() { const user = await loginApi.info(); formatUser(user); initVue() }
async function initVue() { const app = createApp(App); app.mount('#app') }
const token = 'present'
if (!token) initVue(); else getLoginInfo()`)
  const result = await parseEntryRegistrations(root, 'src/main.ts')
  assert.equal(result.draft.transplant?.name, 'initVue')
  const skipped = result.draft.transplant?.chainSkipped ?? []
  assert.ok(skipped.some(value => /entry function getLoginInfo/.test(value)))
  assert.ok(skipped.some(value => /entry statement at line/.test(value)))
  assert.ok(result.diagnostics.some(value => /Not replayed: the entry function getLoginInfo/.test(value)))
  assert.ok(result.diagnostics.some(value => /Not replayed: the entry statement/.test(value)))
  const draft = generateSetupDraft(result, '3')
  // getLoginInfo 名只应出现在诊断注释里，不得生成声明、调用或 loginApi 导入。
  assert.match(draft, /await initVue\(\)/)
  assert.doesNotMatch(draft, /const getLoginInfo|await getLoginInfo|\["loginApi"\]/)
})

test('initializers that call entry-local functions or create the app conditionally still require manual setup',
  async t => {
  const { root, put } = await fixture(t)
  await put('main.js', `import { createApp } from 'vue'
import App from './App.vue'
function plugins(app) { return app }
function initVue() { const app = createApp(App); plugins(app).mount('#app') }
initVue()`)
  let result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.draft.transplant, undefined)
  assert.ok(result.diagnostics.some(value => /entry-local plugins/.test(value)))
  await put('main.js', `import { createApp } from 'vue'
import App from './App.vue'
function initVue(flag) { if (flag) { createApp(App).mount('#app') } }
initVue(true)`)
  result = await parseEntryRegistrations(root, 'main.js')
  assert.equal(result.draft.transplant, undefined)
  assert.ok(result.diagnostics.some(value => /created conditionally/.test(value)))
})
