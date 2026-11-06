/** 公开 SDK→只读计划→Root→Vite worker（方案 §6.2、§6.5、§8、§9.2）；临时样本与合成批准，不调用模型。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import { requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { runnerPaths } from '../../src/shared/runner/paths.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'
import { createVueViteFixture, fixtureFiles } from '../helpers/vue-vite-fixture.ts'
import { prepareAntdvFixture } from '../helpers/vue-antdv-fixture.ts'
import { prepareElementFixture } from '../helpers/vue-element-fixture.ts'
import { prepareVueNetworkFixture } from '../helpers/vue-network-fixture.ts'
import { prepareNavigationFixture } from '../helpers/vue-navigation-fixture.ts'

import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'

const options = { skip: integrationSkip, timeout: 30000 }
const openArgs = { projectId: 'vue-app', target: { kind: 'file', path: 'src/Target.vue' }, scope: 'component', requirements: ['isolated-target'] }

async function setup(t) {
  if (!modules) throw new Error('Explicit existing DSH_PREVIEW_TEST_MODULES is required')
  const fixture = await createVueViteFixture(modules)
  const dataDir = join(fixture.root, 'plugin')
  const project = structuredClone(fixture.input.config.project)
  const save = async () => writeFile(join(fixture.root, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  await save()
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  new ApprovalService(ctx, {})
  const session = sessions.create(SessionId('vue-public-user'), { meta: { cwd: fixture.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir,
    requestApproval: (caller, config, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated) })
  registerTools(ctx, registry)
  let call = 0
  const invoke = async (name, args = {}) => {
    const result = await tools.execute({ callId: ToolCallId('vue-public-' + ++call), name: 'page_preview_' + name, arguments: args, signal: AbortSignal.timeout(15000), agent })
    assert.equal(result.isError, false, 'Actual SDK must return a domain result')
    return result.value
  }
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await fixture.cleanup()
  })
  return {
    ...fixture, dataDir, project, save, ctx, client, registry, invoke, paths: runnerPaths(dataDir, fixture.root),
  }
}

test('public Vue open executes reviewed setup/styles only through owned Runner workers and preserves truthful evidence', options, async t => {
  const f = await setup(t)
  f.project.runtime.setup = 'reviewed-setup.ts'
  f.project.runtime.styles = ['theme.css']
  await f.put('reviewed-setup.ts', 'export default { install() { throw new Error("BROWSER_ONLY_SETUP_SENTINEL") } }')
  await f.put('theme.css', 'body { margin: 8px }')
  await f.save()
  const before = await fixtureFiles(f.appRoot)
  let questions = 0
  f.ctx.on('approval/request', async () => {
    questions++
    await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
    assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
    return 'allowed-once'
  })
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  assert.equal(opened.preview.strategy, 'isolated')
  assert.equal(opened.preview.scope, 'component')
  assert.equal(opened.preview.freshness, 'unverified')
  assert.equal(opened.preview.readiness.targetMounted.status, 'unverified')
  const id = opened.preview.previewId
  const resources = await createFileLedger(f.paths.services).listByPreview(id)
  const worker = resources.find(value => value.resource.kind === 'process').resource
  const root = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0].resource
  assert.notEqual(root.pid, worker.pid)
  assert.notEqual(worker.pid, process.pid)
  assert.equal(Number(await readFile(f.configMarker, 'utf8')), worker.pid)
  const url = new URL(opened.preview.url)
  assert.deepEqual(await findListeningPids(Number(url.port)), [worker.pid])
  assert.equal((await fetch(url)).status, 200)
  assert.equal((await fetch(new URL('/src/Target.vue', url))).status, 200)
  assert.equal((await fetch(new URL('/api/unmatched', url))).status, 404)
  const entry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', url)).then(response => response.text())
  assert.match(entry, /reviewed-setup\.ts/)
  assert.match(entry, /theme\.css/)
  const detail = await f.invoke('status', { previewId: id, detail: true })
  assert.equal(detail.plan.adapter.id, 'vue-vite')
  assert.equal(detail.plan.capabilities.isolatedRender.status,
    process.platform === 'darwin' ? 'supported' : 'unknown')
  assert.equal(detail.plan.capabilities.scopes.shell.status, 'unknown')
  // §0.3 方案 A：浏览器通道如实声明为自有响应层的 mock/block；Node 侧进程保持 none。
  assert.deepEqual(Object.fromEntries(detail.plan.capabilities.network.map(value => [value.channel, value.control + '/' + value.location])), {
    'browser-http': 'block/response-layer', 'browser-ws': 'block/response-layer', 'browser-sse': 'block/response-layer',
    'service-worker': 'block/response-layer', 'dev-server-proxy': 'block/response-layer',
    'build-process': 'none/none', 'server-process': 'none/none',
  })
  assert.ok(!JSON.stringify(detail).includes('DO_NOT_EXPOSE_FIXTURE_OUTPUT'))
  assert.deepEqual(await fixtureFiles(f.appRoot), before)
  assert.equal((await f.invoke('open', openArgs)).preview.previewId, id)
  assert.equal(questions, 1)
  const stopped = await f.invoke('stop', { previewId: id })
  assert.equal(stopped.stopped[0].state, 'stopped')
  assert.equal(await readProcessStartTime(worker.pid), undefined)
  assert.deepEqual(await findListeningPids(Number(url.port)), [])
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(id), [])
})

test('public Vue default mock-only opens through owned channels while relaxed/invalid options still fail', options, async t => {
  const f = await setup(t)
  delete f.project.runtime.requirements
  await f.save()
  const defaultArgs = { projectId: openArgs.projectId, target: openArgs.target, scope: 'component' }
  assert.equal((await f.invoke('open', { ...defaultArgs, requirements: [] })).diagnostics[0].code, 'requirement_unsatisfied')
  f.project.runtime.requirements = []
  await f.save()
  // 视口之外的可配置缺失仍返回 needs_configuration 并保留各自诊断，不被 unsupported 吞并。
  const missingExport = await f.invoke('open', { ...defaultArgs, target: { kind: 'file', path: 'src/Target.vue', exportName: 'Missing' } })
  assert.equal(missingExport.status, 'needs_configuration')
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
  await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
  // R5-4：viewport 经插件自有框架页在 isolated 路径可用——打开后如实停止。
  const viewport = await f.invoke('open', { ...defaultArgs, viewport: { width: 320, height: 640 } })
  assert.equal(viewport.status, 'ok')
  assert.ok(viewport.preview.url.endsWith('/__dsh_preview/frame'), 'viewport opens the owned frame page')
  const viewportStopped = await f.invoke('stop', { previewId: viewport.preview.previewId })
  assert.equal(viewportStopped.stopped[0].state, 'stopped')
  // §0.3：unknown scope 不再是门禁；shell 请求照常打开并如实报告未知能力。
  const shell = await f.invoke('open', { ...defaultArgs, scope: 'shell' })
  assert.equal(shell.status, 'ok')
  assert.equal(shell.preview.readiness.targetMounted.status, 'unverified')
  const stopped = await f.invoke('stop', { previewId: shell.preview.previewId })
  assert.equal(stopped.stopped[0].state, 'stopped')
  // §0.3 第 3 条（方案 A）：浏览器通道由自有响应层如实声明 mock/block，默认 mock-only 不再是门禁；
  // 未命中的业务请求仍明确 404。
  delete f.project.runtime.requirements
  await f.save()
  const opened = await f.invoke('open', defaultArgs)
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  assert.equal((await fetch(new URL('/api/unknown', opened.preview.url))).status, 404)
  const seen = await f.invoke('status', { previewId: opened.preview.previewId, detail: true })
  // §13 第 8 条：被拦截请求转发 method、origin 与 path。
  const expected = 'GET ' + new URL(opened.preview.url).origin + '/api/unknown'
  assert.ok(seen.diagnostics.some(value => value.code === 'unmatched_request' && value.location?.request === expected))
  const stoppedDefault = await f.invoke('stop', { previewId: opened.preview.previewId })
  assert.equal(stoppedDefault.stopped[0].state, 'stopped')
})

test('public Vue entry initialization runs through the generated setup: wrapped initializer, shell, remote requests',
  { ...options, skip: integrationSkip || !chromeAvailable(), timeout: 90000 }, async t => {
  // 2026-11-03（§0.3 第 10 条）：项目不手写 setup——入口在 initVue() 里 createApp、注册业务插件与全局组件，
  // index.html 带 html.dark 与内联 polyfill，接口用绝对地址跨源请求。插件应自动重放初始化、沿用文档外壳、
  // 把跨源请求导回自有 Mock（未命中带原 origin），并在入口变化后重新审批。
  const f = await setup(t)
  await f.put('index.html', '<!doctype html><html class="dark" lang="zh"><head>'
    + '<script>window.__INLINE_POLYFILL__ = "ok"</script></head><body data-shell="app"><div id="app"></div>'
    + '<script type="module" src="/src/main.js"></script></body></html>')
  await f.put('src/brand.js',
    `export const brand = { install(app) { app.config.globalProperties.$brand = 'brand-plugin' } }`)
  await f.put('src/badge.js',
    `import { h } from 'vue'; export default { name: 'GlobalBadge', render: () => h('em', 'global-badge') }`)
  await f.put('src/theme.css', 'em { color: rgb(1, 2, 3) }')
  await f.put('src/main.js', `import { createApp } from 'vue'
import Target from './Target.vue'
import { brand } from './brand.js'
import GlobalBadge from './badge.js'
import './theme.css'
async function login() { await fetch('http://127.0.0.1:9/api/login') }
async function initVue() {
  let app = createApp(Target)
  app.use(brand)
  app.component('GlobalBadge', GlobalBadge)
  app.mount('#app')
}
if (localStorage.getItem('token')) login(); else initVue()`)
  await f.put('src/Target.vue', `<script setup>
import { getCurrentInstance, ref, onMounted } from 'vue'
const brand = getCurrentInstance().appContext.config.globalProperties.$brand
const remote = ref('pending')
onMounted(async () => {
  try { const response = await fetch('http://127.0.0.1:9/api/data?page=1'); remote.value = 'status-' + response.status }
  catch (error) { remote.value = 'error' }
})
</script>
<template><article><h1>{{ brand }}</h1><GlobalBadge /><p>{{ remote }}</p></article></template>`)
  await f.save()
  const prompts = []
  f.ctx.on('approval/request', async request => {
    prompts.push(request.displayReason?.en ?? '')
    return 'allowed-once'
  })
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok', JSON.stringify(opened.diagnostics))
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Generated setup: replays the registrations of src\/main\.js/)
  const chrome = await launchChrome(t)
  let text = ''
  let shell = ''
  try {
    await chrome.navigate(opened.preview.url)
    for (let attempt = 0; attempt < 100 && !/status-404/.test(text); attempt++) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (!/status-404/.test(text)) await new Promise(resolve => setTimeout(resolve, 200))
    }
    shell = String(await chrome.evaluate('[document.documentElement.className, document.documentElement.lang, '
      + 'document.body.dataset.shell, window.__INLINE_POLYFILL__, '
      + 'getComputedStyle(document.querySelector("em")).color].join("|")'))
  } finally { await chrome.close() }
  assert.match(text, /brand-plugin/, 'business plugin from the wrapped initializer was replayed: ' + text)
  assert.match(text, /global-badge/, 'global component registration was replayed')
  assert.match(text, /status-404/, 'the cross-origin request reached the owned Mock and failed explicitly')
  assert.equal(shell, 'dark|zh|app|ok|rgb(1, 2, 3)', 'document shell, inline polyfill and entry styles are kept')
  const status = await f.invoke('status', { previewId: opened.preview.previewId })
  assert.ok(status.diagnostics.some(value => value.code === 'unmatched_request'
    && /127\.0\.0\.1:9/.test(JSON.stringify(value)) && /\/api\/data/.test(JSON.stringify(value))),
    'the unmatched diagnostic names the original origin and path: ' + JSON.stringify(status.diagnostics))
  assert.ok(!status.diagnostics.some(value => /\/api\/login/.test(JSON.stringify(value))),
    'entry login is not executed')
  assert.equal((await f.invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
  // 入口改动后生成 setup 的摘要变化：同会话也要重新审批。
  const entry = await readFile(join(f.appRoot, 'src/main.js'), 'utf8')
  await f.put('src/main.js', entry.replace('app.use(brand)', 'app.use(brand, {})'))
  const reopened = await f.invoke('open', openArgs)
  assert.equal(reopened.status, 'ok')
  assert.equal(prompts.length, 2, 'a changed entry changes the generated setup and asks again')
  assert.equal((await f.invoke('stop', { previewId: reopened.preview.previewId })).stopped[0].state, 'stopped')
})

test('generated setup from a TS entry resolves `.js` specifiers of `.ts` files via regex aliases and relative paths',
  { ...options, skip: integrationSkip || !chromeAvailable(), timeout: 90000 }, async t => {
  // 2026-11-04 overview/web 实测：main.ts 写 `import … from '/@/utils/local-util.js'`（磁盘为 .ts，`/@/` 为正则别名）。
  // 生成的 setup 是虚拟模块，Vite 仅在导入方为 TS 模块时把 .js 解析到 .ts；setup 须按入口语言参与解析。
  const f = await setup(t)
  const config = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  await f.put('vite.config.mjs', config.replace(/alias: \{ '@': ([^}]+) \}/,
    "alias: [{ find: /\\/@\\//, replacement: $1 + '/' }]"))
  await f.put('index.html', '<div id="app"></div><script type="module" src="/src/main.ts"></script>')
  await f.put('src/utils/brand.ts',
    `export const brand = { install(app: any) { app.config.globalProperties.$brand = 'ts-brand' } }`)
  await f.put('src/utils/badge.ts', `import { h } from 'vue'
export default { name: 'GlobalBadge', render: () => h('em', 'ts-badge') }`)
  await f.put('src/main.ts', `import { createApp } from 'vue'
import Target from './Target.vue'
import { brand } from '/@/utils/brand.js'
import GlobalBadge from './utils/badge.js'
const app = createApp(Target)
app.use(brand)
app.component('GlobalBadge', GlobalBadge)
app.mount('#app')`)
  await f.put('src/Target.vue', `<script setup>
import { getCurrentInstance } from 'vue'
const brand = getCurrentInstance().appContext.config.globalProperties.$brand
</script>
<template><article><h1>{{ brand }}</h1><GlobalBadge /></article></template>`)
  f.project.runtime.entry = 'src/main.ts'
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok', JSON.stringify(opened.diagnostics))
  const chrome = await launchChrome(t)
  let text = ''
  try {
    await chrome.navigate(opened.preview.url)
    for (let attempt = 0; attempt < 100 && !/ts-badge/.test(text); attempt++) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (!/ts-badge/.test(text)) await delay(200)
    }
  } finally { await chrome.close() }
  const status = await f.invoke('status', { previewId: opened.preview.previewId })
  assert.ok(!status.diagnostics.some(value => value.code === 'compile_error'),
    'no compile error: ' + JSON.stringify(status.diagnostics))
  assert.match(text, /ts-brand/, 'aliased `.js` import of a `.ts` plugin was replayed: ' + text
    + JSON.stringify(status.diagnostics))
  assert.match(text, /ts-badge/, 'relative `.js` import of a `.ts` component was replayed')
  assert.equal((await f.invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
})

test('public Vue setup rejection or changed reviewed bytes never executes the build or creates a Runner', options, async t => {
  const f = await setup(t)
  f.project.runtime.setup = 'reviewed.js'
  await f.put('reviewed.js', 'export default {}')
  await f.save()
  let answer = 'rejected'
  f.ctx.on('approval/request', async () => {
    if (answer === 'allowed-once') await f.put('reviewed.js', 'export default { changed: true }')
    return answer
  })
  assert.equal((await f.invoke('open', openArgs)).status, 'needs_configuration')
  answer = 'allowed-once'
  const changed = await f.invoke('open', openArgs)
  assert.equal(changed.status, 'needs_configuration')
  assert.match(changed.diagnostics[0].message, /changed/)
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
  await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
})

test('an unproven configured Vue target fails its real deadline and cleans the owned service instead of becoming ready', options, async t => {
  const f = await setup(t)
  f.project.targets = [{ id: 'asserted', selector: openArgs.target, scope: 'component', assertions: [{ kind: 'text-present', text: 'Required target proof' }] }]
  f.project.runtime.readiness = { targetDeadlineMs: 200 }
  await f.save()
  const result = await f.invoke('open', { ...openArgs, target: { kind: 'registered', id: 'asserted' } })
  // 带断言计划在等待窗口内亲自到达期限失败：open 直接如实返回 error/failed，不再先报 reachable。
  assert.equal(result.status, 'error')
  const observed = result
  assert.equal(observed.preview.state, 'failed')
  assert.notEqual(observed.preview.readiness.targetMounted.status, 'proven')
  assert.ok(observed.diagnostics.some(value => value.code === 'target_not_ready'))
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
})

test('initial Vue scenario preserves props/data fingerprints and serves only declared HTTP fixtures', options, async t => {
  const f = await setup(t)
  f.project.scenarios = { own: { props: { title: 'Initial scene' }, businessPaths: ['/api/**'], http: [
    { method: 'GET', path: '/api/greeting', response: { status: 200, body: { text: 'Fixture greeting' } } },
    { method: 'GET', path: '/api/file', response: { status: 200, headers: { 'Content-Type': 'application/json' }, bodyFile: 'reply.json' } },
  ] }, other: { props: { title: 'Other scene' } } }
  await f.put('reply.json', '{"from":"file"}')
  await f.save()
  const before = await fixtureFiles(f.appRoot)
  const opened = await f.invoke('open', { ...openArgs, scenario: 'own' })
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.scenario, 'own')
  const base = new URL(opened.preview.url)
  assert.deepEqual(await (await fetch(new URL('/api/greeting', base))).json(), { text: 'Fixture greeting' })
  assert.deepEqual(await (await fetch(new URL('/api/file', base))).json(), { from: 'file' })
  assert.equal((await fetch(new URL('/api/missing?secret=DO_NOT_REPORT_QUERY', base))).status, 404)
  const entry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', base)).then(response => response.text())
  assert.match(entry, /Initial scene/)
  assert.ok(!entry.includes('Fixture greeting'), 'Server response fixtures are not copied into browser initialization')
  const detail = await f.invoke('status', { previewId: opened.preview.previewId, detail: true })
  assert.ok(detail.plan.fingerprints.scenario)
  assert.equal(detail.plan.capabilities.scenarioApply.status,
    process.platform === 'darwin' ? 'supported' : 'unknown')
  // R3-2：就地场景重载/切换经 toolchain-scenario E2E（macOS + Linux Docker）取得 HTTP 级样本证据。
  assert.equal(detail.plan.capabilities.scenarioReset.status,
    process.platform === 'darwin' ? 'supported' : 'unknown')
  // R5-3：headless Chrome 实测 HMR 就地应用（新标记+探针存活+印章变更）后，
  // refresh 在已验证 macOS 组合升回 supported；其余平台/组合仍 unknown。
  assert.equal(detail.plan.capabilities.refresh.status,
    process.platform === 'darwin' ? 'supported' : 'unknown')
  // 已配置 HTTP fixtures 时 browser-http 如实为 mock；其余通道不变。
  assert.equal(detail.plan.capabilities.network.find(value => value.channel === 'browser-http').control, 'mock')
  // P1-4：场景或同名数据指纹变化自动停旧启新，不再要求已验证的就地 scenarioReset；
  // preview_restarted 诊断如实说明「状态不保留、不代表身份隔离」。
  const other = await f.invoke('open', { ...openArgs, scenario: 'other' })
  assert.equal(other.status, 'ok')
  assert.equal(other.preview.scenario, 'other')
  assert.notEqual(other.preview.previewId, opened.preview.previewId)
  const restarted = other.diagnostics.find(value => value.code === 'preview_restarted')
  assert.ok(restarted, 'Scenario switch must surface a preview_restarted diagnostic')
  assert.match(restarted.hint ?? '', /not preserved.*not isolate|not isolate.*not preserved/i, 'Restart hint must state that state is not preserved and identity is not isolated')
  assert.equal((await f.invoke('status', { previewId: opened.preview.previewId })).preview.state, 'stopped')
  const otherBase = new URL(other.preview.url)
  assert.equal((await fetch(new URL('/api/greeting', otherBase))).status, 404, 'Scenario "other" has no declared fixtures and must not reuse the previous mock data')
  const otherEntry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', otherBase)).then(response => response.text())
  assert.match(otherEntry, /Other scene/, 'Restarted preview applies the new scenario props')
  f.project.scenarios.own.props.title = 'Changed data under same scenario name'
  await f.save()
  const changed = await f.invoke('open', { ...openArgs, scenario: 'own' })
  assert.equal(changed.status, 'ok')
  assert.ok(changed.diagnostics.some(value => value.code === 'preview_restarted'), 'Changed scenario data fingerprints must also restart honestly')
  assert.equal((await f.invoke('status', { previewId: other.preview.previewId })).preview.state, 'stopped')
  const changedEntry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', new URL(changed.preview.url))).then(response => response.text())
  assert.match(changedEntry, /Changed data under same scenario name/, 'Restarted preview applies the changed scenario data')
  assert.deepEqual(await fixtureFiles(f.appRoot), before)
})

test('Vite config cannot publish a preview after changing previously approved setup bytes', options, async t => {
  const f = await setup(t)
  f.project.runtime.setup = 'reviewed.js'
  await f.put('reviewed.js', 'export default {}')
  const source = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  await f.put('vite.config.mjs', source.replace("return vue()", `writeFileSync(${JSON.stringify(join(f.appRoot, 'reviewed.js'))}, 'export default { changedAfterApproval: true }'); return vue()`))
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', openArgs)
  let observed = opened
  for (let i = 0; i < 100 && observed.preview?.state !== 'failed'; i++) { await delay(25); observed = await f.invoke('status', { previewId: opened.preview.previewId }) }
  assert.equal(observed.preview.state, 'failed')
  assert.ok(observed.diagnostics.some(value => value.code === 'config_changed_needs_approval'))
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId), [])
})

test('public Vue Node handlers execute only in their worker and retain project write/read semantics', options, async t => {
  const f = await setup(t)
  const marker = join(f.root, 'handler-imported')
  await f.put('handler-domain.ts', `export const reply = (scenario: string, value: number) => ({scenario, value})`)
  await f.put('handlers.ts', `import {writeFileSync} from 'node:fs'
    import {reply} from './handler-domain.ts'
    writeFileSync(${JSON.stringify(marker)}, String(process.pid))
    export default [async (request, store) => {
      if (request.path === '/api/value') {
        if (request.method === 'POST') { store.set('value', request.body.value); return {status:201, body:reply(store.scenario, store.get('value'))} }
        if (request.method === 'GET') return {status:200, body:reply(store.scenario, store.get('value') ?? 0)}
        if (request.method === 'DELETE') { store.delete('value'); return {status:204} }
      }
      if (request.path === '/api/throw') throw new Error('DO_NOT_EXPOSE_HANDLER_ERROR')
      if (request.path === '/api/policy') return {status:200, headers:{'Content-Security-Policy':'default-src *'}}
    }]`)
  f.project.scenarios = { own: { businessPaths: ['/api/**'], handlers: 'handlers.ts', http: [{method:'GET', path:'/api/fixed', response:{status:200, body:{fixture:true}}}] } }
  await f.save()
  const before = await fixtureFiles(f.appRoot)
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; await assert.rejects(access(marker), {code:'ENOENT'}); return 'allowed-once' })
  const args = {...openArgs, scenario:'own'}
  const opened = await f.invoke('open', args)
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  const resources = await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId)
  const worker = resources.find(value => value.resource.kind === 'process').resource
  assert.equal(Number(await readFile(marker, 'utf8')), worker.pid)
  assert.notEqual(worker.pid, process.pid)
  const url = new URL(opened.preview.url)
  const request = (path, init) => fetch(new URL(path, url), init)
  assert.deepEqual(await (await request('/api/value')).json(), {scenario:'own', value:0})
  const written = await request('/api/value', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"value":7}'})
  assert.equal(written.status, 201)
  assert.deepEqual(await written.json(), {scenario:'own', value:7})
  assert.deepEqual(await (await request('/api/value')).json(), {scenario:'own', value:7})
  assert.deepEqual(await (await request('/api/fixed')).json(), {fixture:true})
  assert.equal((await request('/api/throw?secret=DO_NOT_EXPOSE_HANDLER_QUERY')).status, 500)
  const policy = await request('/api/policy')
  assert.equal(policy.status, 500)
  assert.notEqual(policy.headers.get('Content-Security-Policy'), 'default-src *')
  assert.equal((await request('/api/missing')).status, 404)
  assert.equal((await request('/api/value', {method:'DELETE'})).status, 204)
  assert.deepEqual(await (await request('/api/value')).json(), {scenario:'own', value:0})
  assert.equal((await f.invoke('open', args)).preview.previewId, opened.preview.previewId)
  const detail = await f.invoke('status', {previewId:opened.preview.previewId, detail:true})
  assert.ok(detail.plan.fingerprints.scenario)
  // Node handler 场景：browser-http 为 mock，server-process 如实保持 none。
  assert.equal(detail.plan.capabilities.network.find(value => value.channel === 'browser-http').control, 'mock')
  assert.equal(detail.plan.capabilities.network.find(value => value.channel === 'server-process').control, 'none')
  assert.ok(!/DO_NOT_EXPOSE_HANDLER/.test(JSON.stringify(detail)))
  assert.deepEqual(await fixtureFiles(f.appRoot), before)
  assert.equal(questions, 1)
  assert.equal((await f.invoke('stop', {previewId:opened.preview.previewId})).stopped[0].state, 'stopped')
  assert.equal(await readProcessStartTime(worker.pid), undefined)
  await assert.rejects(fetch(url))
})

test('Vite configuration changing approved handlers is rejected before handler import', options, async t => {
  const f = await setup(t)
  const marker = join(f.root, 'handler-must-not-import')
  await f.put('handlers.mjs', 'export default []')
  f.project.scenarios = { own: {businessPaths:['/api/**'], handlers:'handlers.mjs'} }
  const source = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  const changed = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'UNAPPROVED_IMPORT'); export default []`
  await f.put('vite.config.mjs', source.replace('return vue()', `writeFileSync(${JSON.stringify(join(f.appRoot, 'handlers.mjs'))}, ${JSON.stringify(changed)}); return vue()`))
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', {...openArgs, scenario:'own'})
  let observed = opened
  for (let i=0; i<100 && observed.preview?.state !== 'failed'; i++) { await delay(25); observed = await f.invoke('status', {previewId:opened.preview.previewId}) }
  assert.equal(observed.preview.state, 'failed')
  assert.ok(observed.diagnostics.some(value => value.code === 'config_changed_needs_approval'))
  await assert.rejects(access(marker), {code:'ENOENT'})
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId), [])
})

test('invalid handler exports fail startup visibly and clean the worker without publishing a URL', options, async t => {
  const f = await setup(t)
  await f.put('handlers.cjs', 'module.exports = [42]')
  f.project.scenarios = { own: {businessPaths:['/api/**'], handlers:'handlers.cjs'} }
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', {...openArgs, scenario:'own'})
  let observed = opened
  for (let i=0; i<100 && observed.preview?.state !== 'failed'; i++) { await delay(25); observed = await f.invoke('status', {previewId:opened.preview.previewId}) }
  assert.equal(observed.preview.state, 'failed')
  assert.ok(observed.diagnostics.some(value => value.code === 'config_invalid'))
  assert.equal(observed.preview.url, undefined)
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId), [])
})

test('denied handler approval never allocates Root or imports a project module', options, async t => {
  const f = await setup(t)
  const marker = join(f.root, 'denied-handler')
  await f.put('handlers.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'SHOULD_NOT_RUN'); export default []`)
  f.project.scenarios = { own: {businessPaths:['/api/**'], handlers:'handlers.mjs'} }
  await f.save()
  f.ctx.on('approval/request', async () => 'rejected')
  assert.equal((await f.invoke('open', {...openArgs, scenario:'own'})).status, 'needs_configuration')
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
  await assert.rejects(access(marker), {code:'ENOENT'})
  await assert.rejects(access(f.configMarker), {code:'ENOENT'})
})

test('named TS SFC and explicit Ant Design Vue setup compile through the public path without package-specific adapter branches', options, async t => {
  const f = await setup(t)
  const selector = await prepareAntdvFixture(f, f.project, modules)
  await f.save()
  const before = await fixtureFiles(f.appRoot)
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', {...openArgs, target:selector})
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  const url = new URL(opened.preview.url)
  const entry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', url)).then(response => response.text())
  assert.match(entry, /exportName: "NamedPage"/)
  const target = await fetch(new URL('/src/Target.vue', url))
  assert.equal(target.status, 200)
  assert.match(await target.text(), /NamedPage/)
  const detail = await f.invoke('status', {previewId:opened.preview.previewId, detail:true})
  assert.equal(detail.plan.selector.exportName, 'NamedPage')
  assert.equal(detail.plan.capabilities.network.find(value => value.channel === 'browser-http').control, 'block')
  assert.deepEqual(await fixtureFiles(f.appRoot), before)
  assert.equal((await f.invoke('stop', {previewId:opened.preview.previewId})).stopped[0].state, 'stopped')
})

test('original Element Plus/Pinia initial scene bindings compile with explicit permissions and unchanged sources', options, async t => {
  for (const role of ['viewer', 'editor', 'denied']) {
    const editable = role === 'editor'
    const f = await setup(t)
    const selector = await prepareElementFixture(f, f.project, modules, role)
    await f.save()
    const before = await fixtureFiles(f.appRoot)
    f.ctx.on('approval/request', async () => 'allowed-once')
    const opened = await f.invoke('open', {...openArgs, target:selector, scenario:'own'})
    assert.equal(opened.status, 'ok')
    assert.equal(opened.preview.state, 'reachable')
    const url = new URL(opened.preview.url)
    const entry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', url)).then(response => response.text())
    assert.equal(entry.includes('orders:edit'), editable)
    assert.match(entry, /exportName: "OrdersPage"/)
    assert.equal((await fetch(new URL('/src/Target.vue', url))).status, 200)
    assert.deepEqual(await fixtureFiles(f.appRoot), before)
    assert.equal((await f.invoke('stop', {previewId:opened.preview.previewId})).stopped[0].state, 'stopped')
  }
})

test('owned Worker scripts and child HTML retain controlled responses without publishing arbitrary same-origin business paths', options, async t => {
  const f = await setup(t)
  const network = await prepareVueNetworkFixture(f, f.project)
  try {
    await f.save()
    const before = await fixtureFiles(f.appRoot)
    const opened = await f.invoke('open', {...openArgs, scenario:'own'})
    assert.equal(opened.status, 'ok')
    const url = new URL(opened.preview.url)
    for (const [file, destination] of [['worker.js','worker'],['shared.js','sharedworker'],['sw.js','serviceworker']]) {
      const response = await fetch(new URL('/__vue_net/'+file, url), {headers:{'Sec-Fetch-Dest':destination}})
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Type') ?? '', /javascript/)
      assert.ok(response.headers.get('Content-Security-Policy')?.includes("connect-src 'self'"))
    }
    const child = await fetch(new URL('/__vue_net/frame.html', url), {headers:{'Sec-Fetch-Dest':'iframe'}})
    assert.equal(child.status, 200)
    assert.ok(child.headers.get('Content-Security-Policy')?.includes("connect-src 'self'"))
    const html = await child.text()
    assert.ok(html.includes('Owned child document'))
    assert.ok(!html.includes('data-dsh-preview-bootstrap'), 'Child documents must not inject parent target assertions or reporter')
    assert.equal((await fetch(new URL('/__vue_net/worker.js', url))).status, 404)
    assert.equal((await fetch(new URL('/api/proxy', url))).status, 404)
    assert.equal((await fetch(new URL('/.env', url), {headers:{'Sec-Fetch-Dest':'worker'}})).status, 404)
    assert.deepEqual(network.hits, {})
    assert.deepEqual(await fixtureFiles(f.appRoot), before)
    assert.equal((await f.invoke('stop', {previewId:opened.preview.previewId})).stopped[0].state, 'stopped')
  } finally { await network.close() }
})

test('public file navigation preserves explicit scenario route and compiles the reviewed original router binding', options, async t => {
  const f = await setup(t)
  await prepareNavigationFixture(f, f.project, modules)
  await f.save()
  const before = await fixtureFiles(f.appRoot)
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', {...openArgs,scenario:'own'})
  assert.equal(opened.status, 'ok')
  const detail = await f.invoke('status', {previewId:opened.preview.previewId,detail:true})
  assert.deepEqual(detail.plan.route, f.project.scenarios.own.route)
  const entry = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', opened.preview.url)).then(r=>r.text())
  assert.ok(entry.includes('/orders/42?tab=active&note=from+fixture#details'))
  const compiledSetup = await fetch(new URL('/reviewed-setup.js', opened.preview.url)).then(r=>r.text())
  assert.ok(compiledSetup.includes('router.currentRoute.value.fullPath'))
  assert.deepEqual(await fixtureFiles(f.appRoot), before)
  assert.equal((await f.invoke('stop', {previewId:opened.preview.previewId})).stopped[0].state, 'stopped')
})

test('with a sidebar follower, open returns once the sidebar loaded the document and says the task is done',
  { ...options, skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // 2026-11-03 实机：没有浏览器证据时 Agent 自己开 Chrome 截图验证约 60 秒。这里用真实 Chrome 扮演
  // DSH 侧边栏 Browser（Client auto-open 在预览可达时加载地址），open 应直接带回挂载证据与页面文本。
  const f = await setup(t)
  const release = f.registry.trackFollower('vue-public-user')
  const chrome = await launchChrome(t)
  t.after(async () => { release(); await chrome.close() })
  let navigated = false
  f.client.onMessage(message => {
    if (message.type !== 'state' || navigated || !message.url || message.state !== 'reachable') return
    navigated = true
    void chrome.navigate(message.url)
  })
  const started = Date.now()
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok')
  assert.equal(navigated, true, 'the simulated sidebar loaded the preview')
  assert.ok(Date.now() - started < 10000, 'returns as soon as the page rendered, not at the wait ceiling')
  assert.equal(opened.preview.readiness.documentLoaded.status, 'proven', JSON.stringify(opened.preview.readiness))
  // 2026-11-03 Aesc：打开侧边栏即结束，不等首次渲染文本；诊断明确告诉 Agent 任务已完成。
  assert.ok(opened.diagnostics.some(value => value.code === 'preview_shown_in_sidebar'
    && /do not wait, poll status, sleep/.test(value.hint ?? '')))
  assert.equal((await f.invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
})

test('without a sidebar follower, open does not wait for browser evidence', options, async t => {
  const f = await setup(t)
  const started = Date.now()
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.readiness.targetMounted.status, 'unverified')
  assert.ok(Date.now() - started < 10000, 'no browser-mount wait without a follower')
  assert.equal((await f.invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
})
