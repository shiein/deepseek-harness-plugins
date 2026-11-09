/** 公开 SDK→Registry→只读计划→Root→Vue CLI worker（方案 §6.2、§6.5、§8、§9.2）；回归：vue-cli 注册+controller 放行。 */
import { executeTool, installApproval } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
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
import { createCliAppRoot } from '../helpers/vue-cli-fixture.ts'
import { launchChrome, chromeAvailable } from '../helpers/headless-chrome.ts'
import { strict } from '../helpers/test-gate.ts'

const modules = fileURLToPath(new URL('../toolchains/vue26-cli/node_modules', import.meta.url))
const installed = existsSync(modules + '/@vue/cli-service/package.json')
const skip = (!['darwin', 'linux'].includes(process.platform) || !installed) && !strict
const openArgs = {
  projectId: 'vue26-cli-app',
  target: { kind: 'file', path: 'src/Target.vue' },
  scope: 'component',
  requirements: ['isolated-target'],
}

const spec = () => ({
  modules,
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler', 'element-ui', 'core-js'],
  packageDeps: {
    vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
    'vue-template-compiler': '2.6.14', 'element-ui': '2.15.14', 'core-js': '3.51.0',
  },
  targetPath: 'src/Target.vue',
  fixtureId: 'vue26-cli-app',
  files: {
    'vue.config.js':
      `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js':
      `module.exports = api => { api.cache(true); return { presets: ['@vue/cli-plugin-babel/preset'] } }\n`,
    'src/main.js': `import Vue from 'vue'; import App from './Target.vue'; export { Vue, App }\n`,
    'src/Target.vue': `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button }, data: () => ({ count: 0 }) }
</script>
<template>
<article><h1>cli-target-26</h1><el-button @click="count++">element count: {{ count }}</el-button></article>
</template>
<style scoped>article { padding: 8px }</style>\n`,
  },
})

async function setup(t) {
  const fixture = await createCliAppRoot(spec())
  const dataDir = join(fixture.root, 'plugin')
  const project = structuredClone(fixture.context.config.project)
  const configFile = JSON.stringify({ schemaVersion: 1, projects: [project] })
  await writeFile(join(fixture.root, 'page-preview.config.json'), configFile)
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  await installApproval(ctx, {})
  const session = sessions.create(SessionId('vue-cli-public-user'), { meta: { cwd: fixture.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const approve = (caller, config, exec, previous, generated) =>
    requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated)
  const registry = new SessionRegistry(client, undefined, { dataDir, requestApproval: approve })
  registerTools(ctx, registry)
  let call = 0
  const invoke = async (name, args = {}) => {
    const request = {
      callId: ToolCallId('vue-cli-public-' + ++call), name: 'page_preview_' + name,
      arguments: args, signal: AbortSignal.timeout(30000), agent,
    }
    const result = await executeTool(tools, request)
    assert.equal(result.isError, false, 'Actual SDK must return a domain result')
    return result.value
  }
  ctx.on('approval/request', async () => 'allowed-once')
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await fixture.cleanup()
  })
  return { fixture, invoke, client }
}

test('public Vue CLI open plans via the registered adapter and serves the owned document',
  { skip, timeout: 60000 }, async t => {
    const f = await setup(t)
    const opened = await f.invoke('open', openArgs)
    assert.equal(opened.status, 'ok', JSON.stringify(opened.diagnostics ?? opened, null, 1).slice(0, 1500))
    let preview = opened.preview
    for (let i = 0; i < 40 && !(preview.url && ['reachable', 'ready'].includes(preview.state)); i++) {
      await delay(500)
      preview = (await f.invoke('status', { previewId: preview.previewId })).previews[0] ?? preview
    }
    const detail = await f.invoke('status', { previewId: preview.previewId, detail: true })
    assert.equal(detail.plan.adapter.id, 'vue-cli')
    const url = new URL(preview.url)
    assert.ok(['reachable', 'ready'].includes(preview.state), 'Preview must become reachable: ' + preview.state)
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.ok(html.includes('__dsh_preview_root'), 'Owned mount container must be present')
    assert.ok(html.includes('__DSH_PREVIEW__'), 'Bootstrap script must be injected into the owned document')
    const entry = await fetch(url.origin + '/js/dshPagePreview.js')
    assert.equal(entry.status, 200)
    assert.match(await entry.text(), /startVuePreview/)
    const stopped = await f.invoke('stop', { previewId: preview.previewId })
    assert.equal(stopped.status, 'ok')
  })

test('CLI navigation and assertions run through the shared mechanism with real browser proof (R5-2)',
  { skip: skip || !chromeAvailable(), timeout: 150000 }, async t => {
    const f = await setup(t)
    const { fixture } = f
    // vue-router 3 显式符号链接进 appRoot（借用已批准工具链，不修改业务 package.json）。
    const router = await realpath(join(modules, 'vue-router'))
    const version = JSON.parse(await readFile(join(router, 'package.json'), 'utf8')).version
    assert.equal(version, '3.6.5', 'Own navigation sample requires its explicit installed router version')
    await symlink(router, join(fixture.appRoot, 'node_modules/vue-router'))
    await fixture.put('src/Target.vue', `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button } }
</script>
<template><article><h1>cli-target-26</h1><p>Routed id: {{ $route.params.id }}</p>
<p>Routed fullPath: {{ $route.fullPath }}</p><el-button>element</el-button></article></template>\n`)
    // 已审阅 setup：原样使用项目 vue-router 3（abstract 模式不改文档 URL），navigate 返回真实 fullPath。
    await fixture.put('reviewed-setup.js', `import VueRouter from 'vue-router'
export default {
  install({ Vue }) {
    Vue.use(VueRouter)
    const router = new VueRouter({ mode: 'abstract', routes: [
      { path: '/orders/:id', component: { render: h => h('p', 'order stub') } },
      { path: '/login', component: { render: h => h('p', 'login stub') } },
    ] })
    return { router }
  },
  createContext({ installation }) {
    return { ...installation, rootOptions: { router: installation.router } }
  },
  async navigate({ href, context }) {
    await context.router.push(href)
    return context.router.currentRoute.fullPath
  },
}\n`)
    const project = fixture.context.config.project
    project.runtime.setup = 'reviewed-setup.js'
    project.scenarios = {
      own: { route: { path: '/orders/:id#details', params: { id: '42' }, query: { tab: 'active' } } },
    }
    project.targets = [{ id: 'asserted', selector: { kind: 'file', path: 'src/Target.vue' },
      scope: 'component', assertions: [{ kind: 'text-present', text: 'Routed id: 42' },
        { kind: 'selector-visible', selector: 'article h1' }] }]
    await writeFile(join(fixture.root, 'page-preview.config.json'),
      JSON.stringify({ schemaVersion: 1, projects: [project] }))
    const chrome = await launchChrome(t)
    let navigated = false
    f.client.onMessage(message => {
      if (message.type !== 'state' || navigated || !message.url || message.state !== 'reachable') return
      navigated = true
      void chrome.navigate(message.url)
    })
    const opened = await f.invoke('open', {
      ...openArgs, target: { kind: 'registered', id: 'asserted' }, scenario: 'own' })
    assert.equal(opened.status, 'ok', JSON.stringify(opened.diagnostics ?? opened, null, 1).slice(0, 2000))
    assert.equal(navigated, true, 'a real browser must have loaded the preview')
    assert.equal(opened.preview.readiness.targetMounted.status, 'proven',
      JSON.stringify(opened.preview.readiness))
    const detail = await f.invoke('status', { previewId: opened.preview.previewId, detail: true })
    assert.deepEqual(detail.plan.route, project.scenarios.own.route)
    // 浏览器内核对：abstract router 解析到 /orders/42?tab=active#details 且 $route 已渲染。
    let text = ''
    for (let i = 0; i < 40 && !text.includes('Routed id: 42'); i++) {
      await delay(500)
      text = String(await chrome.evaluate('document.body.innerText'))
    }
    assert.ok(text.includes('Routed id: 42'), 'navigated target must render route params: ' + text.slice(0, 300))
    assert.ok(text.includes('Routed fullPath: /orders/42?tab=active#details'),
      'final fullPath must match the declared route: ' + text.slice(0, 300))
    const stopped = await f.invoke('stop', { previewId: opened.preview.previewId })
    assert.equal(stopped.status, 'ok')
  })
