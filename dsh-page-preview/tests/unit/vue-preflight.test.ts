/** Vue 真实只读预检（方案 §6.2、§6.5、§6.9、§15.3）；临时文件/元数据，不执行项目编译器或代码。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { vueCliAdapter } from '../../src/adapters/vue/cli/index.ts'
import { buildPlan } from '../../src/core/plan/planner.ts'
import { parseVueSfc } from '../../src/shared/vue-sfc.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vue-plan-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  const installed = (name: string, version: string) => put('node_modules/' + name + '/package.json', { name, version })
  await put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5' } })
  await installed('vue', '3.4.27'); await installed('vite', '5.2.12'); await installed('@vitejs/plugin-vue', '5.1.4')
  await put('index.html', '<script type="module" src="/src/main.js"></script>')
  await put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'; createApp(App).mount('#app')`)
  await put('src/Target.vue', '<script setup lang="ts">const label: string = "original"</script><template><h1>{{ label }}</h1></template>')
  const context: AdapterContext = { workspaceRoot: root, appRoot: root, config: { source: { kind: 'detected' }, project: { id: 'vue', root: '.', runtime: {} }, diagnostics: [] }, profile: { root: '.', hasPackageJson: true, languages: [], frameworks: [], buildTools: [{ value: { name: 'vite' }, confidence: 'candidate', evidence: [] }], runtime: {}, existingPreview: [] } }
  const target: ResolvedTarget = { projectId: 'vue', targetId: 'component', selector: { kind: 'file', path: 'src/Target.vue' }, scope: 'component' }
  return { root, put, installed, context, target, plan: () => vueViteAdapter.plan(context, target) }
}

test('SFC block AST excludes scripts in template/custom blocks and handles JS/TS/setup/style metadata', () => {
  const parsed = parseVueSfc(`<!-- <script>fake</script> --><template><script>also fake</script></template>
<script lang="ts">export const Named = {}</script><script setup>const value = 1</script><style src="./theme.css"></style><custom><script>not a block</script></custom>`)
  assert.equal(parsed.template, true)
  assert.equal(parsed.scripts.length, 2)
  assert.equal(parsed.scripts[0]?.lang, 'ts')
  assert.equal(parsed.scripts[1]?.setup, true)
  assert.equal(parsed.styles[0]?.src, './theme.css')
  assert.deepEqual(parsed.unresolved, [])
  for (const source of ['<script src="./external.js" />', '<style>not a component</style>', '<script>one</script><script>two</script>']) assert.ok(parseVueSfc(source).unresolved.length)
})

test('Vue preflight applies exact verified scope evidence but common Planner preserves default mock-only gating', async t => {
  const f = await fixture(t)
  assert.equal((await vueViteAdapter.probe(f.context, f.target)).matched, true)
  assert.equal((await vueCliAdapter.probe(f.context, f.target)).matched, false)
  await f.put('node_modules/ignored/Bad.vue', '<template>not a project target</template>')
  const discovered = await vueViteAdapter.discover(f.context)
  assert.deepEqual(discovered.candidates.map(value => value.selector), [{ kind: 'file', path: 'src/Target.vue' }])
  assert.equal(discovered.manualOnly, true)
  const result = await f.plan()
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected read-only candidate')
  assert.equal(result.plan.strategy, 'isolated')
  assert.equal(result.plan.toolchain.vue, '3.4.27')
  assert.equal(result.plan.toolchain.vite, '5.2.12')
  assert.equal(result.plan.toolchain.vuePluginVersion, '5.1.4')
  assert.equal(result.plan.capabilities.scopes.component?.status, process.platform === 'darwin' ? 'supported' : 'unknown')
  // §0.3 方案 A：浏览器通道如实声明为自有响应层的 block（无场景 fixtures 时 browser-http 也是 block），Node 侧进程保持 none。
  // R5-1e：bootstrap 在未检出 MSW 时屏蔽 navigator.serviceWorker——block 据此成立（原声明曾不实）。
  assert.deepEqual(Object.fromEntries(result.plan.capabilities.network.map(value => [value.channel, value.control + '/' + value.location])), {
    'browser-http': 'block/response-layer', 'browser-ws': 'block/response-layer', 'browser-sse': 'block/response-layer',
    'service-worker': 'block/response-layer', 'dev-server-proxy': 'block/response-layer',
    'build-process': 'none/none', 'server-process': 'none/none',
  })
  assert.deepEqual(result.plan.requirements, ['mock-only'])
  const checked = await buildPlan({ workspaceRoot: f.root, config: f.context.config, profile: f.context.profile, target: f.target, strategy: 'isolated', adapters: [vueViteAdapter] })
  assert.equal(checked.kind, 'plan')
})

// F6：配置+证据确认的 vite-plugin-mock 但其 mock 文件相对导入越出 mockPath——
// 复制副本必加载失败，计划层不声明 project 覆盖并给出 project_mock_unavailable。
test('vite-plugin-mock with mock files importing outside mockPath loses project coverage (F6)', async t => {
  const f = await fixture(t)
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5' },
    devDependencies: { 'vite-plugin-mock': '3.0.2', mockjs: '1.1.0' } })
  await f.put('vite.config.mjs', `import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [viteMockServe({ mockPath: 'mock' })] }`)
  await f.put('mock/api.ts', `import { list } from '../src/data'
export default [{ url: '/api/x', method: 'get', response: () => list }]`)
  await f.put('src/data.ts', 'export const list = []')
  const result = await f.plan()
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected a plan')
  assert.ok(!result.plan.capabilities.network
      .some(entry => entry.channel === 'browser-http' && entry.location === 'project'),
    'escaping mock files must not claim project coverage')
  const diagnostic = (result.diagnostics ?? []).find(value => value.code === 'project_mock_unavailable')
  assert.ok(diagnostic, 'expected a project_mock_unavailable plan diagnostic')
  assert.ok(diagnostic?.message.includes('api.ts -> ../src/data'), 'diagnostic must name the escaping file')
  // 把共享模块收回 mock 目录内后覆盖如实恢复，诊断消失。
  await f.put('mock/api.ts', `import { list } from './data'
export default [{ url: '/api/x', method: 'get', response: () => list }]`)
  await f.put('mock/data.ts', 'export const list = []')
  const clean = await f.plan()
  assert.equal(clean.kind, 'plan')
  if (clean.kind !== 'plan') throw new Error('Expected a plan')
  assert.ok(clean.plan.capabilities.network
    .some(entry => entry.channel === 'browser-http' && entry.location === 'project'))
  assert.ok(!(clean.diagnostics ?? []).some(value => value.code === 'project_mock_unavailable'))
})

test('unverified toolchains and module formats keep unknown capabilities yet still produce an executable plan', async t => {
  const f = await fixture(t)
  f.context.config.project.runtime.requirements = []
  const build = () => buildPlan({ workspaceRoot: f.root, config: f.context.config, profile: f.context.profile, target: f.target, strategy: 'isolated', adapters: [vueViteAdapter] })
  const verified = await build()
  assert.equal(verified.kind, 'plan')
  if (verified.kind !== 'plan') throw new Error('Expected a checked plan')
  assert.equal(verified.plan.capabilities.scopes.component?.status, process.platform === 'darwin' ? 'supported' : 'unknown')
  await f.installed('vite', '5.2.13')
  const unverified = await build()
  assert.equal(unverified.kind, 'plan', 'Unverified toolchains are not gates; the plan still proceeds (§0.3)')
  if (unverified.kind !== 'plan') throw new Error('Expected a plan for the unverified toolchain')
  assert.equal(unverified.plan.capabilities.scopes.component?.status, 'unknown')
  assert.ok(unverified.plan.knownDifferences.some(value => value.includes('unverified_toolchain')))
  await f.installed('vite', '5.2.12')
  await f.put('src/Target.vue', '<script>export const Named = {}</script><template>Default</template>')
  f.target.selector = { kind: 'file', path: 'src/Target.vue', exportName: 'Named' }
  assert.equal((await build()).kind, 'plan')
  await f.put('src/Named.js', 'export const Named = {}')
  f.target.selector = { kind: 'file', path: 'src/Named.js', exportName: 'Named' }
  const jsTarget = await build()
  assert.equal(jsTarget.kind, 'plan')
  if (jsTarget.kind !== 'plan') throw new Error('Expected a plan for the unverified module format')
  assert.equal(jsTarget.plan.capabilities.scopes.component?.status, 'unknown')
})

test('target, entry, setup, stylesheet, config and lock bytes change candidate fingerprints without executing them', async t => {
  const f = await fixture(t)
  f.context.config.project.runtime.setup = 'setup.ts'
  f.context.config.project.runtime.styles = ['theme.scss']
  await f.put('setup.ts', 'throw new Error("SETUP_MUST_NOT_RUN"); export default {}')
  await f.put('theme.scss', '$color: red;')
  await f.put('vite.config.ts', 'throw new Error("CONFIG_MUST_NOT_RUN"); export default {}')
  await f.put('package-lock.json', '{"version":1}')
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network in preflight') })
  let previous
  for (const [path, content] of [
    ['src/Target.vue', '<template>original</template>'],
    ['src/Target.vue', '<template>changed</template>'],
    ['setup.ts', 'throw new Error("SETUP_MUST_NOT_RUN"); export default { marker: true }'],
    ['theme.scss', '$color: blue;'],
    ['vite.config.ts', 'throw new Error("CONFIG_MUST_NOT_RUN"); export default { base: "/new/" }'],
    ['package-lock.json', '{"version":2}'],
  ]) {
    await f.put(path!, content!)
    const result = await f.plan()
    assert.equal(result.kind, 'plan')
    if (result.kind !== 'plan') throw new Error('Expected candidate')
    assert.notEqual(result.plan.fingerprints.sources, previous)
    previous = result.plan.fingerprints.sources
  }
  assert.equal(network.mock.callCount(), 0)
})

test('entry registrations are replayed through a generated setup whose hash joins the plan; a reviewed setup wins',
  async t => {
  // 2026-11-03（§0.3 第 10 条）：未配置 setup 时自动使用从入口生成的 setup，摘要计入执行指纹审批。
  const f = await fixture(t)
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', 'test-ui': '^1' } })
  await f.put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'; import Kit from 'test-ui'; const app = createApp(App); app.use(Kit); app.mount('#app')`)
  const generated = await f.plan()
  assert.equal(generated.kind, 'plan')
  if (generated.kind !== 'plan') return
  assert.equal(generated.plan.generatedSetup?.entry, 'src/main.js')
  assert.match(generated.plan.generatedSetup?.hash ?? '', /^[0-9a-f]{64}$/)
  assert.ok(generated.plan.knownDifferences.some(value => /plugin-generated setup/.test(value)))
  await f.put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'; import Kit from 'test-ui'
const app = createApp(App); app.use(Kit, { size: 'small' }); app.mount('#app')`)
  const changed = await f.plan()
  assert.ok(changed.kind === 'plan' && changed.plan.generatedSetup?.hash !== generated.plan.generatedSetup?.hash,
    'editing the entry changes the generated setup hash (re-approval)')
  f.context.config.project.runtime.setup = 'reviewed.js'
  await f.put('reviewed.js', 'export default {}')
  const reviewed = await f.plan()
  assert.ok(reviewed.kind === 'plan' && reviewed.plan.generatedSetup === undefined,
    'a reviewed setup is never replaced')
  await f.put('reviewed.js', 'export const missingDefault = {}')
  assert.equal((await f.plan()).kind, 'missing')
})

test('entries that cannot be replayed keep the reviewed-setup path with a draft or a precise hint', async t => {
  const f = await fixture(t)
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', 'test-ui': '^1' } })
  // 只有无法重放的初始化（动态导入）：没有可自动执行的内容，仍要求手写 setup 并附草稿。
  await f.put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'
createApp(App).mount('#app'); import('./lazy.js')`)
  const result = await f.plan()
  assert.equal(result.kind, 'missing')
  if (result.kind !== 'missing') throw new Error('Expected a missing outcome')
  assert.ok(result.setupDraft, 'A setup draft payload must accompany the missing outcome')
  const diagnostic = result.missing.find(value => value.code === 'unsupported_capability')
  assert.equal(diagnostic?.location?.file, 'src/main.js')
  assert.match(diagnostic?.hint ?? '', /setupDraft\.path/)
  // 无法生成草稿的入口（语法损坏）不附带草稿。
  await f.put('src/main.js', 'import { createApp } from')
  const invalid = await f.plan()
  assert.equal(invalid.kind, 'missing')
  if (invalid.kind !== 'missing') throw new Error('Expected a missing outcome')
  assert.equal(invalid.setupDraft, undefined)
})

test('missing/invalid exports and external SFC script paths are checked without compiler execution', async t => {
  const f = await fixture(t)
  f.context.config.project.runtime.setup = 'setup.js'
  await f.put('setup.js', 'export default {}')
  for (const source of ['<script>export const Other = {}</script>', '<script>export default (</script>', '<script src="./missing.js"></script>', '<script src="https://external.invalid/component.js"></script>', '<template>Original</template><style src="./missing.css"></style>']) {
    await f.put('src/Target.vue', source)
    assert.equal((await f.plan()).kind, 'missing')
  }
  await f.put('src/Target.vue', '<script src="./component.ts"></script>')
  await f.put('src/component.ts', 'export default { name: "Actual" }; export const Named = { name: "Named" }')
  assert.equal((await f.plan()).kind, 'plan')
  f.target.selector = { kind: 'file', path: 'src/Target.vue', exportName: 'Named' }
  assert.equal((await f.plan()).kind, 'plan')
  await f.put('src/component.ts', 'export default {}')
  assert.equal((await f.plan()).kind, 'missing')
  f.target.selector = { kind: 'file', path: 'not-here.vue' }
  assert.equal((await f.plan()).kind, 'missing')
})

test('framework exclusions, unknown installed versions and ambiguous hosts are never silently switched', async t => {
  const f = await fixture(t)
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', nuxt: '^3' } })
  assert.equal((await vueViteAdapter.probe(f.context, f.target)).matched, false)
  assert.equal((await f.plan()).kind, 'missing')
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vue/cli-service': '^5' } })
  assert.equal((await f.plan()).kind, 'missing')
  f.context.config.project.runtime.adapter = 'vue-vite'
  assert.equal((await f.plan()).kind, 'plan')
  await f.installed('vue', '2.5.22')
  assert.equal((await f.plan()).kind, 'missing')
  await rm(join(f.root, 'node_modules/vue'), { recursive: true })
  assert.equal((await f.plan()).kind, 'missing')
})

test('Vue CLI preflight uses the same source/setup rules and actual installed versions', async t => {
  const f = await fixture(t)
  await f.put('package.json', { dependencies: { vue: '^2.6', '@vue/cli-service': '^4' } })
  await f.installed('vue', '2.6.14'); await f.installed('@vue/cli-service', '4.5.19')
  await f.put('src/main.js', `import Vue from 'vue'; import App from './Target.vue'; new Vue({ render: h => h(App) }).$mount('#app')`)
  await f.put('src/Target.vue', '<script>export default { name: "Actual" }</script><template>original</template>')
  assert.equal((await vueCliAdapter.probe(f.context, f.target)).matched, true)
  const result = await vueCliAdapter.plan(f.context, f.target)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected CLI candidate')
  assert.equal(result.plan.toolchain['vue-cli'], '4.5.19')
  assert.equal(result.plan.adapter.id, 'vue-cli')
})

test('unconnected scenario/unknown route fail explicitly; viewport is an owned-page feature (R5-4)',
  async t => {
  const f = await fixture(t)
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'role')).kind, 'missing')
  const viewport = await vueViteAdapter.plan(f.context, f.target, undefined, { requirements: ['mock-only'], viewport: { width: 300, height: 600 } })
  assert.equal(viewport.kind, 'plan')
  if (viewport.kind === 'plan') assert.deepEqual(viewport.plan.viewport, { width: 300, height: 600 })
  assert.equal((await vueViteAdapter.plan(f.context, f.target, undefined,
    { requirements: [], viewport: { width: 0, height: 600 } })).kind, 'missing')
  f.context.config.project.runtime.origin = 'http://127.0.0.1:12345'
  assert.equal((await f.plan()).kind, 'missing')
  delete f.context.config.project.runtime.origin
  // R5-4：route 目标经静态 route-map 解析——本 fixture 无路由模块，如实报未匹配，不猜组件。
  f.target.selector = { kind: 'route', path: '/actual' }
  const routed = await f.plan()
  assert.equal(routed.kind, 'missing')
  if (routed.kind === 'missing') assert.ok(routed.missing.some(value =>
    value.code === 'unsupported_capability' && /No statically known route/.test(value.message)))
})

test('target symlinks to an environment file are rejected rather than read as source', async t => {
  const f = await fixture(t)
  await f.put('.env.private', 'NEVER_READ_THIS_VALUE')
  await symlink(join(f.root, '.env.private'), join(f.root, 'src/Private.vue'))
  f.target.selector = { kind: 'file', path: 'src/Private.vue' }
  await assert.rejects(f.plan(), /project metadata/)
})

test('file navigation preserves concrete context only with reviewed setup; vague/external routes fail',
  async t => {
  const f = await fixture(t)
  const route = {path:'/orders/:id#details',params:{id:'42'},query:{tab:'active'}}
  assert.equal((await vueViteAdapter.plan(f.context, f.target, undefined, {requirements:[],route})).kind, 'missing')
  f.context.config.project.runtime.setup = 'setup.js'
  await f.put('setup.js', 'throw new Error("MUST_NOT_EXECUTE"); export default { navigate() {} }')
  const result = await vueViteAdapter.plan(f.context, f.target, undefined, {requirements:[],route})
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected explicit file navigation plan')
  assert.deepEqual(result.plan.route, route)
  assert.equal((await vueViteAdapter.plan(f.context, f.target, undefined, {requirements:[],route:{path:'/orders/:id'}})).kind, 'missing')
  assert.equal((await vueViteAdapter.plan(f.context, f.target, undefined, {requirements:[],route:{path:'//outside.invalid'}})).kind, 'missing')
})

test('initial scenario preflight fingerprints fixture bytes and rejects unknown scope, missing bindings and invalid fixture origins without execution', async t => {
  const f = await fixture(t)
  f.context.config.project.scenarios = { own: { props: { title: 'Fixture' }, businessPaths: ['/api/**'], http: [{ method: 'GET', path: '/api/value', response: { status: 200, bodyFile: 'response.json' } }] } }
  await f.put('response.json', '{"value":1}')
  const planned = await vueViteAdapter.plan(f.context, f.target, 'own')
  assert.ok(planned.kind === 'plan')
  assert.equal(planned.plan.scenario, 'own')
  assert.ok(planned.plan.fingerprints.scenario)
  await f.put('response.json', '{"value":2}')
  const changed = await vueViteAdapter.plan(f.context, f.target, 'own')
  assert.ok(changed.kind === 'plan')
  assert.notEqual(planned.plan.fingerprints.sources, changed.plan.fingerprints.sources)
  assert.notEqual(planned.plan.fingerprints.scenario, changed.plan.fingerprints.scenario)
  const scene = f.context.config.project.scenarios.own!
  scene.http![0]!.response.bodyFile = '__proto__'
  await f.put('__proto__', 'first fixture')
  const specialFirst = await vueViteAdapter.plan(f.context, f.target, 'own')
  await f.put('__proto__', 'changed fixture')
  const specialSecond = await vueViteAdapter.plan(f.context, f.target, 'own')
  assert.ok(specialFirst.kind === 'plan' && specialSecond.kind === 'plan')
  assert.notEqual(specialFirst.plan.fingerprints.scenario, specialSecond.plan.fingerprints.scenario)
  delete scene.businessPaths
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing')
  scene.businessPaths = ['/api/**']
  // R5-1c：显式 origin 的 fixture 经同源 remote 通道按原 origin 匹配，预检放行；
  // 纯跨源场景没有可推断的同源范围，businessPaths 非必需。
  scene.http![0]!.origin = 'https://outside.invalid'
  const remote = await vueViteAdapter.plan(f.context, f.target, 'own')
  assert.equal(remote.kind, 'plan')
  delete scene.businessPaths
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'plan',
    'cross-origin-only fixtures do not need same-origin businessPaths')
  scene.businessPaths = ['/api/**']
  // 非法 origin 仍拒：非 URL、带凭据、非规范化（含路径/端口错写）。
  for (const invalid of ['not-a-url', 'https://user:pw@outside.invalid', 'https://outside.invalid/api',
    'ftp://outside.invalid', 'javascript:alert(1)']) {
    scene.http![0]!.origin = invalid
    assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing',
      'invalid fixture origin must be rejected: ' + invalid)
  }
  scene.http![0]!.origin = 'https://outside.invalid'
  // 同源 fixture 与跨源 fixture 共存时 businessPaths 仍必需。
  scene.http!.push({ method: 'GET', path: '/api/local', response: { status: 200, body: 1 } })
  delete scene.businessPaths
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing',
    'same-origin fixtures still require explicit businessPaths')
  scene.businessPaths = ['/api/**']
  scene.http!.pop()
  delete scene.http![0]!.origin
  scene.permissions = []
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing')
  delete scene.permissions
  scene.handlers = 'unapproved.js'
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing')
})

test('handler preflight reads scoped Node module bytes without evaluating exports or granting execution', async t => {
  const f = await fixture(t)
  f.context.config.project.scenarios = { own: {businessPaths:['/api/**'], handlers:'handlers.ts'} }
  await f.put('handlers.ts', 'throw new Error("HOST_MUST_NOT_IMPORT"); export default []')
  const first = await vueViteAdapter.plan(f.context, f.target, 'own')
  await f.put('handlers.ts', 'throw new Error("HOST_MUST_NOT_IMPORT_CHANGED"); export default []')
  const changed = await vueViteAdapter.plan(f.context, f.target, 'own')
  assert.ok(first.kind === 'plan' && changed.kind === 'plan')
  assert.notEqual(first.plan.fingerprints.sources, changed.plan.fingerprints.sources)
  assert.notEqual(first.plan.fingerprints.scenario, changed.plan.fingerprints.scenario)
  assert.equal(changed.plan.capabilities.network.find(value => value.channel === 'browser-http')?.control, 'mock')
  assert.equal(changed.plan.capabilities.network.find(value => value.channel === 'server-process')?.control, 'none')
  // 选中 Node handler 时 mock-only 另要求 server-process 的实际 mock/block；Vue 如实声明 none → 预检拒绝而非放行。
  const checked = await buildPlan({ workspaceRoot: f.root, config: f.context.config, profile: f.context.profile, target: f.target, strategy: 'isolated', scenario: 'own', adapters: [vueViteAdapter] })
  assert.equal(checked.kind, 'needs-configuration')
  if (checked.kind === 'needs-configuration') assert.equal(checked.missing[0]?.code, 'requirement_unsatisfied')
  const scene = f.context.config.project.scenarios.own!
  delete scene.businessPaths
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing')
  scene.businessPaths = ['/api/**']
  scene.handlers = '.env.private'
  await f.put('.env.private', 'MUST_NOT_READ')
  assert.equal((await vueViteAdapter.plan(f.context, f.target, 'own')).kind, 'missing')
})

test('JSX/TSX targets run through the project vue-jsx plugin as unverified; without it the hint is actionable',
  async t => {
  // overview/web 形态（2026-11-03）：登录页是 .tsx，项目 vite.config 引入了 @vitejs/plugin-vue-jsx。
  const f = await fixture(t)
  await f.put('src/Login.tsx', `import { defineComponent } from 'vue'
export default defineComponent({ setup: () => () => <main class="login">login</main> })`)
  const target: ResolvedTarget = { ...f.target, selector: { kind: 'file', path: 'src/Login.tsx' } }
  await f.put('vite.config.ts', `import vue from '@vitejs/plugin-vue'
export default { plugins: [vue()] }`)
  const blocked = await vueViteAdapter.plan(f.context, target)
  assert.equal(blocked.kind, 'missing')
  if (blocked.kind !== 'missing') throw new Error('expected missing')
  const jsx = blocked.missing.find(value => /plugin-vue-jsx/.test(value.message))
  assert.ok(jsx, 'without the JSX plugin the target is refused honestly')
  assert.match(jsx.hint ?? '', /\.vue SFC target|plugin-vue-jsx/)
  await f.put('vite.config.ts', `import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
export default { plugins: [vue(), vueJsx()] }`)
  const notInstalled = await vueViteAdapter.plan(f.context, target)
  assert.ok(notInstalled.kind === 'missing' && notInstalled.missing.some(value => /not installed/.test(value.message)))
  await f.installed('@vitejs/plugin-vue-jsx', '4.0.1')
  const planned = await vueViteAdapter.plan(f.context, target)
  assert.equal(planned.kind, 'plan', JSON.stringify(planned))
  if (planned.kind !== 'plan') return
  assert.equal(planned.plan.toolchain.vueJsx, '4.0.1')
  assert.equal(planned.plan.capabilities.scopes.component?.status, 'unknown', 'JSX targets have no verified sample')
  assert.ok(planned.plan.knownDifferences.some(value => /JSX\/TSX target/.test(value)))
})

test('unknown entries and unreplayable app creation hint at the config field and setup shape', async t => {
  const f = await fixture(t)
  await f.put('index.html',
    '<script type="module">window.x = 1</script><script type="module" src="/src/main.js"></script>')
  const unknown = await f.plan()
  assert.ok(unknown.kind === 'missing')
  const entry = unknown.missing.find(value => /Original entry is unknown/.test(value.message))
  assert.match(entry?.message ?? '', /Inline HTML module scripts/)
  assert.match(entry?.hint ?? '', /"entry"/)
  assert.match(entry?.hint ?? '', /page-preview\.config\.json/)
  await f.put('index.html', '<script type="module" src="/src/main.js"></script>')
  // 搬运不了的包裹写法（初始化函数调用入口内其他函数）仍给出手写 setup 的确切形态。
  await f.put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'
function extend(app) { return app }
async function initVue() { extend(createApp(App)).mount('#app') }
initVue()`)
  const wrapped = await f.plan()
  assert.ok(wrapped.kind === 'missing')
  const setup = wrapped.missing.find(value => /explicit reviewed runtime\.setup/.test(value.message))
  assert.match(setup?.hint ?? '', /export default \{ async install\(\{ app \}\)/)
  assert.match(setup?.hint ?? '', /"setup": "preview\/setup\.js"/)
})

test('configured setup that omits entry style imports gets a non-blocking advisory with an actionable hint',
  async t => {
  // 任务 C（2026-11-03）：手写 setup 接管后自动重放关闭，漏掉入口样式曾静默无提示。
  const styled = `import { createApp } from 'vue'; import App from './Target.vue'
import './tailwind.css'; import 'test-ui/dist/reset.css'; import './theme/index.less'
createApp(App).mount('#app')`
  const f = await fixture(t)
  const gaps = (result: Awaited<ReturnType<typeof f.plan>>) => {
    assert.equal(result.kind, 'plan', 'style gaps are advisory, never blocking')
    if (result.kind !== 'plan') return []
    return (result.diagnostics ?? []).filter(value => value.code === 'setup_missing_styles')
  }
  await f.put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5', 'test-ui': '^1' } })
  await f.put('src/main.js', styled)
  await f.put('src/tailwind.css', 'body {}'); await f.put('src/theme/index.less', '@c: red')
  f.context.config.project.runtime.setup = 'setup.js'
  // 全漏：诊断列出全部三个说明符，hint 可执行，location 指向 setup。
  await f.put('setup.js', 'export default {}')
  let found = gaps(await f.plan())
  assert.equal(found.length, 1)
  assert.match(found[0]!.message, /may be missing 3 entry style import\(s\)/)
  assert.match(found[0]!.message, /\.\/tailwind\.css.*test-ui\/dist\/reset\.css.*\.\/theme\/index\.less/s)
  assert.match(found[0]!.hint ?? '', /Remove runtime\.setup.*generated setup.*or import these styles in setup\.js/s)
  assert.equal(found[0]!.location?.file, 'setup.js')
  // 漏一部分：只列出缺失的那一条（同一说明符按 import 方目录解析，setup 在根目录要写 ./src/...）。
  await f.put('setup.js', `import './src/tailwind.css'; import 'test-ui/dist/reset.css'; export default {}`)
  found = gaps(await f.plan())
  assert.equal(found.length, 1)
  assert.match(found[0]!.message, /may be missing 1 entry style import\(s\): "\.\/theme\/index\.less"/)
  // 直接导入全部样式：无诊断。
  await f.put('setup.js', `import './src/tailwind.css'; import 'test-ui/dist/reset.css'; import './src/theme/index.less'
export default {}`)
  assert.equal(gaps(await f.plan()).length, 0)
  // 经深度 1 的本地模块间接导入样式：无诊断。
  await f.put('setup.js', `import './src/register.js'; export default {}`)
  await f.put('src/register.js',
    `import './tailwind.css'; import 'test-ui/dist/reset.css'; import './theme/index.less'`)
  assert.equal(gaps(await f.plan()).length, 0)
  // 未配置 setup（走自动生成）：无诊断。
  delete f.context.config.project.runtime.setup
  assert.equal(gaps(await f.plan()).length, 0)
})

test('setup style comparison resolves configured aliases and caps the specifier list', async t => {
  const f = await fixture(t)
  await f.put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'
import '@/a.css'; import '@theme/b.css'; import '/@fs-external/c.css'; import './d.css'; import './e.css'
import './f.css'; import './g.css'
createApp(App).mount('#app')`)
  for (const name of ['a', 'd', 'e', 'f', 'g']) await f.put('src/' + name + '.css', 'x {}')
  await f.put('src/theme/b.css', 'x {}')
  // 静态别名 @ → <root>/src、@theme → <root>/src/theme；setup 用别名导入即算覆盖。
  await f.put('vite.config.ts',
    `export default { resolve: { alias: { '@': '${f.root}/src', '@theme': '${f.root}/src/theme' } } }`)
  f.context.config.project.runtime.setup = 'setup.js'
  await f.put('setup.js', `import '@/a.css'; export default {}`)
  const result = await f.plan()
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('expected plan')
  const gap = (result.diagnostics ?? []).find(value => value.code === 'setup_missing_styles')
  assert.ok(gap, 'the six uncovered styles must be reported')
  assert.match(gap.message, /may be missing 6 entry style import\(s\)/)
  // the listing caps at five shown specifiers; the sixth is folded into "and 1 more"
  const listed = /"\/@fs-external\/c\.css", "@theme\/b\.css", "\.\/d\.css", "\.\/e\.css", "\.\/f\.css"/
  assert.match(gap.message, listed)
  assert.match(gap.message, /\(and 1 more\)/)
  assert.doesNotMatch(gap.message, /g\.css|\.\/a\.css|"@\/a\.css"/)
})
