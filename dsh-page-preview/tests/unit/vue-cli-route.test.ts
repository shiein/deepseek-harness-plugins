/** R5-F10：Vue CLI 侧 route 目标与 layout:true（方案 §7.4、R5-4）。route-map 与
 *  route-root 宿主与 Vite 同一共享实现，此前只有 Vite 侧证据；这里在 vue26-cli 真实
 *  工具链上补：plan 级解析/失败路径 + webpack 编译后无头 Chrome 真实渲染父链。
 *  能力等级保持 unknown（CLI 非已验证组合），本测试不升级任何能力。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vueCliAdapter } from '../../src/adapters/vue/cli/index.ts'
import { createCliAppRoot } from '../helpers/vue-cli-fixture.ts'
import type { CliFixtureSpec } from '../helpers/vue-cli-fixture.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'
import { launchChrome, chromeAvailable } from '../helpers/headless-chrome.ts'
import type { ChromePage } from '../helpers/headless-chrome.ts'
import { strict } from '../helpers/test-gate.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import type { RunEvent, RunningHandle, StartContext } from '../../src/adapters/types.ts'

const modules = fileURLToPath(new URL('../toolchains/vue26-cli/node_modules', import.meta.url))
const available = existsSync(join(modules, '@vue/cli-service/package.json'))
  && existsSync(join(modules, 'vue-router/package.json'))
const skip = !available && !strict

/** 嵌套路由项目：OrderLayout 父布局 + OrderPage 叶子；reviewed setup 提供 router/navigate。 */
const spec = (): CliFixtureSpec => ({
  modules,
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler',
    'vue-router', 'core-js'],
  packageDeps: { vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
    'vue-template-compiler': '2.6.14', 'vue-router': '3.6.5', 'core-js': '3.51.0' },
  targetPath: 'src/OrderPage.vue',
  fixtureId: 'vue26-cli-route',
  setup: 'src/setup.js',
  files: {
    'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js': `module.exports = { presets: ['@vue/cli-plugin-babel/preset'] }\n`,
    'src/main.js': `import Vue from 'vue'; import { router } from './router'; export { Vue, router }\n`,
    'src/router.js': `import VueRouter from 'vue-router'
import OrderLayout from './OrderLayout.vue'
import OrderPage from './OrderPage.vue'
export const router = new VueRouter({ routes: [
  { path: '/orders', component: OrderLayout, children: [{ path: ':id', component: OrderPage }] },
] })\n`,
    'src/OrderLayout.vue': `<script>export default { name: 'OrderLayout' }</script>
<template><section><header>ORDER-SHELL-MARKER</header><router-view/></section></template>\n`,
    'src/OrderPage.vue': `<script>export default { name: 'OrderPage' }</script>
<template><article><h1>ORDER-PAGE-MARKER</h1><p>id={{ $route.params.id }}</p>
<router-link to="/orders/43" id="next-order">next</router-link></article></template>\n`,
    'src/setup.js': `import Vue from 'vue'
import VueRouter from 'vue-router'
import { router } from './router'
Vue.use(VueRouter)
export default {
  install() {},
  createContext() { return { rootOptions: { router } } },
  async navigate({ href }) {
    await router.push(href).catch(function () {})
    return router.currentRoute.fullPath
  },
}\n`,
  },
})

const routeTarget = (selector: Record<string, unknown>): ResolvedTarget =>
  ({ projectId: 'vue26-cli-route', targetId: 'route-target', scope: 'page',
    selector: selector as ResolvedTarget['selector'] })
const routeSelector = (extra: Record<string, unknown> = {}) =>
  ({ kind: 'route' as const, path: '/orders/:id', params: { id: '42' }, ...extra })

test('vue26-cli route target resolves through the static route map; layout flag reaches the plan',
  { skip, timeout: 60000 }, async t => {
  const f = await createCliAppRoot(spec())
  t.after(f.cleanup)
  const outcome = await vueCliAdapter.plan(f.context,
    routeTarget(routeSelector({ layout: true })))
  assert.equal(outcome.kind, 'plan',
    outcome.kind === 'missing' ? JSON.stringify(outcome.missing) : outcome.kind)
  if (outcome.kind !== 'plan') return
  assert.deepEqual(outcome.plan.selector, { kind: 'file', path: 'src/OrderPage.vue' })
  assert.equal(outcome.plan.layout, true)
  assert.deepEqual(outcome.plan.route, { path: '/orders/:id', params: { id: '42' } })
  // 默认不渲染父布局：无 layout 标志时 plan.layout 缺省。
  const leafOnly = await vueCliAdapter.plan(f.context, routeTarget(routeSelector()))
  assert.equal(leafOnly.kind, 'plan')
  if (leafOnly.kind === 'plan') assert.equal(leafOnly.plan.layout, undefined)
})

test('vue26-cli route target failure paths: unmatched, ambiguous and non-concrete never pick a component',
  { skip, timeout: 60000 }, async t => {
  const f = await createCliAppRoot(spec())
  t.after(f.cleanup)
  const missing = await vueCliAdapter.plan(f.context,
    routeTarget(routeSelector({ path: '/nowhere' })))
  assert.equal(missing.kind, 'missing')
  if (missing.kind === 'missing') assert.ok(missing.missing.some(value =>
    value.code === 'unsupported_capability' && /No statically known route/.test(value.message)),
    'unmatched route must not resolve to a component: ' + JSON.stringify(missing.missing))
  // 歧义：第二个同形模板同时匹配具体路径时如实报 ambiguous，不猜组件。
  await f.put('src/DupPage.vue', '<template><p>dup page</p></template>\n')
  await f.put('src/router.js', `import VueRouter from 'vue-router'
import OrderLayout from './OrderLayout.vue'
import OrderPage from './OrderPage.vue'
import DupPage from './DupPage.vue'
export const router = new VueRouter({ routes: [
  { path: '/orders', component: OrderLayout, children: [{ path: ':id', component: OrderPage }] },
  { path: '/orders/:code', component: DupPage },
] })\n`)
  const dup = await vueCliAdapter.plan(f.context,
    routeTarget({ kind: 'route', path: '/orders/:code', params: { code: '42' } }))
  assert.equal(dup.kind, 'missing')
  if (dup.kind === 'missing') assert.ok(dup.missing.some(value =>
    value.code === 'ambiguous_target' && /Several route entries/.test(value.message)),
    'ambiguous routes must not pick a component: ' + JSON.stringify(dup.missing))
  // 非具体路由（缺 params）→ config_invalid。
  const vague = await vueCliAdapter.plan(f.context,
    routeTarget(routeSelector({ params: undefined })))
  assert.equal(vague.kind, 'missing')
  if (vague.kind === 'missing') assert.ok(vague.missing.some(value =>
    value.code === 'config_invalid'), 'non-concrete route must report config_invalid')
})

test('vue26-cli layout:true mounts the route-root host and renders the static parent chain',
  { skip: skip || !chromeAvailable(), timeout: 240000 }, async t => {
  const f = await createCliAppRoot(spec())
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  const events: RunEvent[] = []
  const ledger = createFileLedger(join(f.root, 'control'))
  t.after(async () => {
    if (chrome) await chrome.close()
    if (running) await running.stop()
    await f.cleanup()
  })
  const outcome = await vueCliAdapter.plan(f.context,
    routeTarget(routeSelector({ layout: true })))
  assert.equal(outcome.kind, 'plan',
    outcome.kind === 'missing' ? JSON.stringify(outcome.missing) : outcome.kind)
  if (outcome.kind !== 'plan') return
  const input: StartContext = { ...f.context, previewId: 'vue26-cli-route-layout',
    ownerSessionId: 'own-test', plan: outcome.plan, signal: new AbortController().signal,
    deadline: Date.now() + 200000, ledger,
    async verifyExecution() {}, emit(event) { events.push(event) } }
  running = await vueCliAdapter.start(input)
  chrome = await launchChrome(t)
  await chrome.navigate(running.url)
  const text = async () => {
    try { return String(await chrome!.evaluate('document.body.innerText')) } catch { return '' }
  }
  let body = ''
  for (let i = 0; i < 300 && !body.includes('ORDER-PAGE-MARKER'); i++) {
    body = await text()
    if (!body.includes('ORDER-PAGE-MARKER')) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(body.includes('ORDER-SHELL-MARKER'),
    'parent layout chain must render around the leaf through the shared route-root host: '
      + body.slice(0, 300))
  assert.ok(body.includes('id=42'), 'route params must reach the leaf: ' + body.slice(0, 300))
  // 项目内导航：点击 router-link 跳到 /orders/43，父布局仍在、内容换绑（导航不出预览）。
  await chrome.evaluate('document.getElementById("next-order").click()')
  for (let i = 0; i < 50 && !body.includes('id=43'); i++) {
    body = await text()
    if (!body.includes('id=43')) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(body.includes('id=43') && body.includes('ORDER-SHELL-MARKER'),
    'in-project navigation must stay inside the preview layout: ' + body.slice(0, 300))
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})
