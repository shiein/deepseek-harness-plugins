/** R5-4：路由目标解析、父布局渲染、自有视口框架页与项目内导航（真实工具链 + headless Chrome）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpath, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import type { createVueViteFixture as Fixture } from '../helpers/vue-vite-fixture.ts'

type F = Awaited<ReturnType<typeof Fixture>>

/** 嵌套路由项目：OrderLayout 父布局 + OrderPage 叶子，reviewed setup 提供 router 与 navigate。 */
async function routeFixture() {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  const routerModule = await realpath(join(modules, 'vue-router'))
  await symlink(routerModule, join(f.appRoot, 'node_modules/vue-router'))
  const project = f.input.config.project
  project.runtime.dependencyRoots = [relative(f.appRoot, await realpath(modules))]
  project.runtime.setup = 'preview-setup.js'
  await f.put('src/OrderLayout.vue',
    `<template><section><header>ORDER-SHELL-MARKER</header><router-view/></section></template>\n`)
  await f.put('src/OrderPage.vue', `<script setup>
import { useRoute } from 'vue-router'
const route = useRoute()
</script><template><article><h1>ORDER-PAGE-MARKER</h1><p>id={{ route.params.id }}</p>
<router-link to="/orders/43" id="next-order">next</router-link></article></template>\n`)
  await f.put('src/router.js', `import { createRouter, createMemoryHistory } from 'vue-router'
import OrderLayout from './OrderLayout.vue'
import OrderPage from './OrderPage.vue'
export const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/orders', component: OrderLayout, children: [{ path: ':id', component: OrderPage }] },
] })\n`)
  await f.put('preview-setup.js', `import { router } from './src/router.js'
export default {
  install({ app }) { app.use(router); return { router } },
  createContext({ installation }) { return installation },
  async navigate({ href, context }) {
    await context.router.push(href); await context.router.isReady()
    return context.router.currentRoute.value.fullPath
  },
}\n`)
  const target = (selector: ResolvedTarget['selector']): ResolvedTarget =>
    ({ projectId: 'vue-app', targetId: 'route-target', scope: 'page', selector })
  const routeSelector = (extra: Record<string, unknown> = {}) =>
    ({ kind: 'route' as const, path: '/orders/:id', params: { id: '42' }, ...extra })
  return { f, target, routeSelector }
}

const planFor = (f: F, selector: ResolvedTarget['selector']) =>
  vueViteAdapter.plan(f.input, { projectId: 'vue-app', targetId: 'route-target', scope: 'page', selector })

test('route target resolves through the static route map; layout flag and route context reach the plan',
  { skip: integrationSkip }, async () => {
  const { f, routeSelector } = await routeFixture()
  try {
    const outcome = await planFor(f, routeSelector({ layout: true }))
    assert.equal(outcome.kind, 'plan', outcome.kind === 'missing' ? JSON.stringify(outcome.missing) : outcome.kind)
    if (outcome.kind !== 'plan') return
    assert.deepEqual(outcome.plan.selector, { kind: 'file', path: 'src/OrderPage.vue' })
    assert.equal(outcome.plan.layout, true)
    assert.deepEqual(outcome.plan.route, { path: '/orders/:id', params: { id: '42' } })
    // 默认不渲染父布局：无 layout 标志时 plan.layout 缺省。
    const leafOnly = await planFor(f, routeSelector())
    assert.equal(leafOnly.kind, 'plan')
    if (leafOnly.kind === 'plan') assert.equal(leafOnly.plan.layout, undefined)
  } finally { await f.cleanup() }
})

test('route target failure paths: unmatched, ambiguous and non-concrete routes never pick a component',
  { skip: integrationSkip }, async () => {
  const { f, routeSelector, target } = await routeFixture()
  try {
    const missing = await planFor(f, routeSelector({ path: '/nowhere' }))
    assert.equal(missing.kind, 'missing')
    if (missing.kind === 'missing') assert.ok(missing.missing.some(value =>
      value.code === 'unsupported_capability' && /No statically known route/.test(value.message)),
      'unmatched route must not resolve to a component')
    // 歧义：改写路由加入第二个同形模板，两个静态模板都匹配具体路径时如实报 ambiguous，不猜组件。
    await f.put('src/DupPage.vue', '<template><p>dup page</p></template>\n')
    await f.put('src/router.js', `import { createRouter, createMemoryHistory } from 'vue-router'
import OrderLayout from './OrderLayout.vue'
import OrderPage from './OrderPage.vue'
import DupPage from './DupPage.vue'
export const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/orders', component: OrderLayout, children: [{ path: ':id', component: OrderPage }] },
  { path: '/orders/:code', component: DupPage },
] })\n`)
    const dup = await planFor(f, { kind: 'route', path: '/orders/:code', params: { code: '42' } })
    assert.equal(dup.kind, 'missing')
    if (dup.kind === 'missing') assert.ok(dup.missing.some(value =>
      value.code === 'ambiguous_target' && /Several route entries/.test(value.message)),
      'ambiguous routes must not pick a component: ' + JSON.stringify(dup.missing))
    // 非具体路由（缺 params）→ config_invalid。
    const vague = await planFor(f, routeSelector({ params: undefined }))
    assert.equal(vague.kind, 'missing')
    if (vague.kind === 'missing') assert.ok(vague.missing.some(value => value.code === 'config_invalid'))
    // 视口尺寸必须为正整数，不近似。
    const badViewport = await vueViteAdapter.plan(f.input,
      target({ kind: 'file', path: 'src/OrderPage.vue' }), undefined,
      { requirements: [], viewport: { width: 0, height: 240 } })
    assert.equal(badViewport.kind, 'missing')
    if (badViewport.kind === 'missing') assert.ok(badViewport.missing.some(value =>
      value.code === 'config_invalid' && /Viewport/.test(value.message)))
  } finally { await f.cleanup() }
})

test('layout:true renders the static parent chain and keeps in-project navigation inside the preview',
  { skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  const { f, routeSelector } = await routeFixture()
  let running: Awaited<ReturnType<typeof vueViteAdapter.start>> | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const outcome = await planFor(f, routeSelector({ layout: true }))
  assert.equal(outcome.kind, 'plan')
  if (outcome.kind !== 'plan') return
  f.input.plan = outcome.plan
  running = await vueViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    for (let attempt = 0; attempt < 100 && !text.includes('ORDER-PAGE-MARKER'); attempt++) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (!text.includes('ORDER-PAGE-MARKER')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('ORDER-SHELL-MARKER'),
      'parent layout chain must render around the leaf: ' + text.slice(0, 300))
    assert.ok(text.includes('id=42'), 'route params must reach the leaf: ' + text.slice(0, 300))
    // 项目内导航：点击 router-link 跳到 /orders/43，父布局仍在、内容换绑。
    await chrome.evaluate('document.getElementById("next-order").click()')
    let moved = ''
    for (let attempt = 0; attempt < 50 && !moved.includes('id=43'); attempt++) {
      moved = String(await chrome.evaluate('document.body.innerText'))
      if (!moved.includes('id=43')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(moved.includes('id=43') && moved.includes('ORDER-SHELL-MARKER'),
      'in-project navigation must stay inside the preview layout: ' + moved.slice(0, 300))
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('route target without layout renders only the leaf component',
  { skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  const { f, routeSelector } = await routeFixture()
  let running: Awaited<ReturnType<typeof vueViteAdapter.start>> | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const outcome = await planFor(f, routeSelector())
  assert.equal(outcome.kind, 'plan')
  if (outcome.kind !== 'plan') return
  f.input.plan = outcome.plan
  running = await vueViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    for (let attempt = 0; attempt < 100 && !text.includes('ORDER-PAGE-MARKER'); attempt++) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (!text.includes('ORDER-PAGE-MARKER')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('ORDER-PAGE-MARKER') && !text.includes('ORDER-SHELL-MARKER'),
      'leaf-only render must not include the parent shell: ' + text.slice(0, 300))
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('viewport opens the owned frame page; assertions and page text stay in the inner document',
  { skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: Awaited<ReturnType<typeof vueViteAdapter.start>> | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  f.input.plan.viewport = { width: 320, height: 240 }
  running = await vueViteAdapter.start(f.input)
  assert.ok(running.url.endsWith('/__dsh_preview/frame'),
    'viewport must open the owned frame page, got ' + running.url)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let inner = ''
    for (let attempt = 0; attempt < 100 && !inner.includes('Real adapter target'); attempt++) {
      inner = String(await chrome.evaluate(
        'var fr=document.querySelector("iframe[data-dsh-preview-frame]");'
        + 'fr && fr.contentDocument && fr.contentDocument.body ? fr.contentDocument.body.innerText : ""'))
      if (!inner.includes('Real adapter target')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(inner.includes('Real adapter target'), 'inner document must mount the target: ' + inner.slice(0, 200))
    const frame = String(await chrome.evaluate(
      'var fr=document.querySelector("iframe[data-dsh-preview-frame]");var box=fr.getBoundingClientRect();'
      + 'JSON.stringify({w:box.width,h:box.height,innerBg:getComputedStyle(fr.contentDocument.body).backgroundColor,'
      + 'outerBg:getComputedStyle(document.body).backgroundColor})'))
    const meta = JSON.parse(frame) as { w: number, h: number, innerBg: string, outerBg: string }
    assert.deepEqual([meta.w, meta.h], [320, 240], 'frame must fix the inner viewport size')
    assert.equal(meta.outerBg, 'rgb(68, 68, 68)', 'outer page paints its own background')
    assert.notEqual(meta.innerBg, meta.outerBg, 'outer frame styles must not leak into the inner preview')
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})
