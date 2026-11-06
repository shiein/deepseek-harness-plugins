/** Vue 影响分析：模块图/路由表/页面边（方案 §5.2、R3-4）；临时应用只读解析，不执行项目代码。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildModuleGraph, brokenImporters, reachableImporters, resolveModuleSpecifier }
  from '../../src/adapters/vue/impact/module-graph.ts'
import { readRouteMap } from '../../src/adapters/vue/impact/route-map.ts'
import { impactVue } from '../../src/adapters/vue/impact/index.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { FileChange } from '../../src/core/change/baseline.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vue-impact-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return { root, put }
}
const change = (path: string, kind: FileChange['kind'] = 'modified'): FileChange =>
  ({ kind, path, origin: 'workspace-observed' })

test('module graph resolves static/dynamic/require specifiers, SFC blocks, styles and aliases', async t => {
  const { root, put } = await fixture(t)
  await put('vite.config.ts', [
    'export default { resolve: { alias: [',
    "  { find: '@', replacement: 'src' },",
    '  { find: /^~lib\\//, replacement: buildExpression() },',
    '] } }',
  ].join('\n'))
  await put('src/main.ts', [
    "import { createApp } from 'vue'",
    "import App from './App.vue'",
    "export { helper } from './lib/helper'",
    "const lazy = () => import('./pages/Lazy.vue')",
    "const legacy = require('./legacy.js')",
    'const opaque = import(`./dynamic/${name}`)',
    "import('@/pages/Aliased.vue')",
    "import('~lib/unknown.js')",
    'createApp(App)',
  ].join('\n'))
  await put('src/App.vue', [
    '<template><p /></template>',
    '<script lang="ts" src="./app-script.ts"></script>',
    '<style>@import "./app-style.css";</style>',
  ].join('\n'))
  await put('src/app-script.ts', "import '@/pages/Aliased.vue'")
  await put('src/app-style.css', "@use './tokens.scss'")
  await put('src/tokens.scss', '')
  await put('src/lib/helper.ts', 'export const helper = 1')
  await put('src/legacy.js', 'module.exports = {}')
  await put('src/pages/Lazy.vue', '<template />')
  await put('src/pages/Aliased.vue', '<template />')
  await put('src/pages/Gone.vue.d.ts', 'export {}') // 解析目标存在但非引用者
  await put('src/uses-missing.ts', "import './no-such-file'")
  const graph = await buildModuleGraph(root)
  const main = graph.imports.get('src/main.ts')!
  for (const expected of ['src/App.vue', 'src/lib/helper.ts', 'src/pages/Lazy.vue',
    'src/legacy.js', 'src/pages/Aliased.vue'])
    assert.ok(main.includes(expected), expected + ' missing from ' + JSON.stringify(main))
  // 裸说明符入 bareSpecifiers 而非 imports。
  assert.deepEqual(graph.bareSpecifiers.get('src/main.ts'), ['vue'])
  assert.ok(graph.imports.get('src/App.vue')!.includes('src/app-script.ts'),
    'SFC script src is an edge')
  assert.ok(graph.imports.get('src/App.vue')!.includes('src/app-style.css'),
    'SFC inline style @import is an edge')
  assert.ok(graph.imports.get('src/app-style.css')!.includes('src/tokens.scss'))
  // '..' 出应用根与正则/表达式别名 → 如实 gaps，不猜测。
  assert.ok(graph.gaps.some(gap => gap.includes('no-such-file')), JSON.stringify(graph.gaps))
  assert.ok(graph.gaps.some(gap => gap.includes('~lib/unknown.js')), JSON.stringify(graph.gaps))
  assert.equal(graph.partial, false)
  // 断链登记：删除后引用方可追溯。
  assert.deepEqual(graph.broken.get('src/no-such-file'), ['src/uses-missing.ts'])
  assert.deepEqual(brokenImporters(graph, 'src/no-such-file.ts'), ['src/uses-missing.ts'])
})

test('specifier resolution distinguishes file/outside/bare/unresolved outcomes', async t => {
  const { root, put } = await fixture(t)
  await put('src/a.ts', '')
  await put('src/pkg/index.ts', '')
  const files = new Set(['src/a.ts', 'src/pkg/index.ts'])
  const config = {
    aliases: [
      { find: '@', replacement: 'src' },
      { find: 'lib-out', replacement: '../outside' },
    ],
    opaqueAliases: [{ find: 'opaque' }],
  }
  const at = (specifier: string) => resolveModuleSpecifier(root, 'src/x.ts', specifier, files, config)
  assert.deepEqual(at('./a'), { kind: 'file', path: 'src/a.ts' })
  assert.deepEqual(at('/src/pkg'), { kind: 'file', path: 'src/pkg/index.ts' }, 'index resolution')
  assert.deepEqual(at('@/a'), { kind: 'file', path: 'src/a.ts' })
  assert.deepEqual(at('lib-out/x'), { kind: 'outside' })
  assert.deepEqual(at('vue'), { kind: 'bare' })
  assert.deepEqual(at('opaque/deep'), { kind: 'unresolved', reason: 'opaque-alias' })
  const missing = at('./gone')
  assert.equal(missing.kind, 'unresolved')
  assert.equal((missing as { candidate?: string }).candidate, 'src/gone')
  // '..' 逃逸不重锚回应用根。
  assert.equal(at('../../outside/x').kind, 'unresolved')
})

test('route map supports createRouter/VueRouter forms, bindings, children and dynamic segments', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.ts', "import { router } from './router'\nimport Home from './pages/Home.vue'")
  await put('src/router.ts', [
    "import { createRouter, createWebHistory } from 'vue-router'",
    "import VueRouter from 'vue-router'",
    "import Home from './pages/Home.vue'",
    "import { adminRoutes } from './routes/admin'",
    'const routes = [',
    "  { path: '/', component: Home },",
    "  { path: '/about', component: () => import('./pages/About.vue') },",
    "  { path: '/legacy', component: () => require('./pages/Legacy.vue') },",
    "  { path: '/user/:id', component: () => import('./pages/User.vue') },",
    "  { path: '/app', component: Shell,",
    "    children: [{ path: 'nested', component: () => import('./pages/Nested.vue') }] },",
    ']',
    'const Shell = () => import("./pages/Shell.vue")',
    'export const router = createRouter({ history: createWebHistory(), routes })',
    "const other = new VueRouter({ routes: adminRoutes })",
  ].join('\n'))
  await put('src/routes/admin.ts',
    "import Detail from '../pages/Detail.vue'\nexport const adminRoutes = [{ path: '/admin', component: Detail }]")
  for (const page of ['Home', 'About', 'Legacy', 'User', 'Nested', 'Shell', 'Detail'])
    await put(`src/pages/${page}.vue`, '<template />')
  const map = await readRouteMap(root, join(root, 'src/main.ts'))
  assert.equal(map.routerModule, 'src/router.ts')
  const routes = Object.fromEntries(map.routes.map(route => [route.path, route]))
  assert.equal(routes['/']?.component, 'src/pages/Home.vue')
  assert.equal(routes['/about']?.component, 'src/pages/About.vue')
  assert.equal(routes['/legacy']?.component, 'src/pages/Legacy.vue')
  assert.equal(routes['/user/:id']?.dynamic, true)
  assert.equal(routes['/']?.dynamic, false)
  // children 与父路径拼接；跨文件 import 绑定一跳解析。
  assert.equal(routes['/app/nested']?.component, 'src/pages/Nested.vue')
  assert.equal(routes['/admin']?.component, 'src/pages/Detail.vue')
})

test('route map reports ambiguity honestly and stays empty without vue-router', async t => {
  const { root, put } = await fixture(t)
  await put('src/a.ts', "import { createRouter } from 'vue-router'\ncreateRouter({ routes: [] })")
  await put('src/b.ts', "import { createRouter } from 'vue-router'\ncreateRouter({ routes: [] })")
  const ambiguous = await readRouteMap(root, undefined)
  assert.deepEqual(ambiguous.routes, [])
  assert.ok(ambiguous.gaps.some(gap => gap.includes('Several modules create routers')))
  // 入口收窄：reachable 集合内恰有一个路由模块时采用它。
  await put('src/main.ts', "import './a'")
  const narrowed = await readRouteMap(root, join(root, 'src/main.ts'))
  assert.equal(narrowed.routerModule, 'src/a.ts')
  const { root: root2, put: put2 } = await fixture(t)
  await put2('src/main.ts', "import { createApp } from 'vue'\ncreateApp({})")
  const empty = await readRouteMap(root2, undefined)
  assert.deepEqual(empty.routes, [])
  assert.ok(empty.gaps.some(gap => gap.includes('No module importing vue-router')))
})

test('impact edges: route component strong, shared medium, component fallback, deleted via broken', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.ts', "import { createApp } from 'vue'\nimport { router } from './router'")
  await put('src/router.ts', [
    "import { createRouter, createWebHistory } from 'vue-router'",
    'const routes = [',
    "  { path: '/', component: () => import('./pages/Home.vue') },",
    "  { path: '/about', component: () => import('./pages/About.vue') },",
    ']',
    'export const router = createRouter({ history: createWebHistory(), routes })',
  ].join('\n'))
  const usesShared = '<script lang="ts">import Shared from "../components/Shared.vue";'
    + ' export default { components: { Shared } }</script>'
  await put('src/pages/Home.vue', ['<template><Shared /></template>', usesShared].join('\n'))
  await put('src/pages/About.vue', ['<template><Shared /></template>', usesShared].join('\n'))
  await put('src/components/Shared.vue', '<template />')
  await put('src/components/Orphan.vue', '<template />')
  await put('src/styles/site.css', 'body {}')
  await put('src/pages/Home.vue.bak', 'not a module')
  const ctx: AdapterContext = {
    workspaceRoot: root, appRoot: root,
    profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [],
      buildTools: [], runtime: {}, existingPreview: [] },
    config: { source: { kind: 'detected' },
      project: { id: 'app', root: '.', runtime: { entry: 'src/main.ts' } }, diagnostics: [] },
  }
  // 路由组件自身 → strong page 边带路由上下文。
  const own = await impactVue(ctx, [change('src/pages/Home.vue')])
  const hit = own.edges.find(value => value.changed === 'src/pages/Home.vue')!
  assert.equal(hit.evidence, 'strong')
  assert.deepEqual(hit.selector, { kind: 'file', path: 'src/pages/Home.vue' })
  assert.ok(hit.relation.includes('route /'))
  // 共享组件到达多个路由页面 → 每页 medium。
  const shared = await impactVue(ctx, [change('src/components/Shared.vue')])
  assert.equal(shared.edges.length, 2)
  assert.ok(shared.edges.every(value => value.evidence === 'medium'))
  assert.deepEqual(shared.edges.map(value => (value.selector as { path: string }).path).sort(),
    ['src/pages/About.vue', 'src/pages/Home.vue'])
  // 非路由 .vue → component 级 strong；无引用文件 → unrelated。
  const component = await impactVue(ctx, [change('src/components/Orphan.vue'), change('tsconfig.json')])
  assert.ok(component.edges.some(value => value.evidence === 'strong' && value.scope === 'component'
    && (value.selector as { path: string }).path === 'src/components/Orphan.vue'))
  assert.ok(component.unrelated.includes('tsconfig.json'))
  // 删除经 broken 追溯：Shared.vue 被删后其 importer 的页面仍受影响（medium）。
  const deleted = await impactVue(ctx, [change('src/components/Shared.vue', 'deleted')])
  assert.equal(deleted.edges.length, 2)
  assert.ok(deleted.edges.every(value => value.evidence === 'medium'
    && value.relation[0] === 'src/components/Shared.vue'))
})
