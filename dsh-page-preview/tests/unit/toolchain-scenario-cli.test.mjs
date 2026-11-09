/** 真实工具链全链路（CLI 腿，方案 §7.4、§9.1、§9.2、R3-1~R3-5）：vue26-cli 与 vue27-cli
 *  worker 上跑同一组场景链路与失败路径。2026-11-03 Aesc 决定放行 CLI scenario；
 *  R5-2 起 navigation 放行但须显式 setup.navigate 绑定（无绑定的带 route 场景做负断言）。
 *  证据级别：HTTP/进程级；webpack dev-middleware 内存包取证，无浏览器侧画面。
 *  能力等级保持 unknown（CLI 非已验证组合），本测试不升级任何能力。 */
import { executeTool, installApproval } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import { ImpactService } from '../../src/host/impact-service.ts'
import { requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { createVueCliFixture } from '../helpers/vue-cli-fixture.ts'
import { integrationSkip, strict } from '../helpers/test-gate.ts'

const toolchain = name => fileURLToPath(new URL('../toolchains/' + name + '/node_modules', import.meta.url))
const available = name => existsSync(toolchain(name) + '/@vue/cli-service/package.json')
const skipFor = name => (integrationSkip || !available(name)) && !strict
const options = name => ({ skip: skipFor(name), timeout: 240000 })

const babelConfig = `module.exports = api => { api.cache(true); `
  + `require('fs').writeFileSync('__CONFIG_MARKER__', String(process.pid), { mode: 0o600 }); `
  + `return { presets: ['@vue/cli-plugin-babel/preset'] } }\n`

const specs = {
  'vue26-cli': () => ({
    modules: toolchain('vue26-cli'),
    packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler',
      'element-ui', 'core-js'],
    packageDeps: { vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
      'vue-template-compiler': '2.6.14', 'element-ui': '2.15.14', 'core-js': '3.51.0' },
    targetPath: 'src/Target.vue',
    fixtureId: 'vue26-cli-app',
    files: {
      'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
      'babel.config.js': babelConfig,
      'src/main.js': `import Vue from 'vue'; import App from './Target.vue'; export { Vue, App }\n`,
      'src/Target.vue': `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button }, data: () => ({ count: 0 }) }
</script>
<template><article><h1>cli-target-26</h1><p>adapter-revision-1</p>`
        + `<el-button @click="count++">element count: {{ count }}</el-button></article></template>
<style scoped>article { padding: 8px }</style>\n`,
    },
  }),
  'vue27-cli': () => ({
    modules: toolchain('vue27-cli'),
    packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', '@vue/cli-plugin-typescript',
      'vue-template-compiler', 'typescript', 'ant-design-vue', 'core-js'],
    packageDeps: { vue: '2.7.16', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
      '@vue/cli-plugin-typescript': '5.0.9', 'vue-template-compiler': '2.7.16', typescript: '5.9.3',
      'ant-design-vue': '1.7.8', 'core-js': '3.51.0' },
    targetPath: 'src/Target.vue',
    fixtureId: 'vue27-cli-app',
    files: {
      'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
      'babel.config.js': babelConfig,
      'tsconfig.json': `{"compilerOptions":{"target":"es2018","module":"esnext","strict":false,`
        + `"moduleResolution":"node","esModuleInterop":true,"experimentalDecorators":true,`
        + `"lib":["es2018","dom","dom.iterable"]}}\n`,
      'src/vue-shims.d.ts': `declare module '*.vue' { import Vue from 'vue'; export default Vue }\n`,
      'src/main.js': `import Vue from 'vue'; import App from './Target.vue'; export { Vue, App }\n`,
      'src/Target.vue': `<script lang="ts">
import Vue from 'vue'
import { Button } from 'ant-design-vue'
export default Vue.extend({ name: 'CliTarget', components: { AButton: Button }, data: () => ({ count: 0 }) })
</script>
<template><article><h1>cli-target-27</h1><p>adapter-revision-1</p>`
        + `<a-button @click="count++">antdv count: {{ count }}</a-button></article></template>
<style scoped>article { padding: 8px }</style>\n`,
    },
  }),
  'vue26-cli4': () => {
    const spec = specs['vue26-cli']()
    spec.modules = toolchain('vue26-cli4')
    spec.fixtureId = 'vue26-cli4-app'
    // Node 24 + webpack4(md4) 的真实组合需要 legacy provider；如实声明为 runtime.env
    // （进执行指纹与 worker env，由批准覆盖）。
    spec.env = { NODE_OPTIONS: '--openssl-legacy-provider' }
    return spec
  },
}

/** 项目 Node handler（R3-1 授权路径）：真实进 worker 执行并回 '/api/handled'。 */
const HANDLERS = `export default [function previewHandler(request) {
  if (request.path !== '/api/handled') return undefined
  return { status: 200, body: { value: 'handled' } }
}]\n`

async function setup(t, spec, fixtureId) {
  const fixture = await createVueCliFixture(spec())
  const dataDir = join(fixture.root, 'plugin')
  const project = structuredClone(fixture.input.config.project)
  const save = async () => writeFile(join(fixture.root, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  await save()
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  await installApproval(ctx, {})
  const session = sessions.create(SessionId('toolchain-e2e-' + fixtureId), { meta: { cwd: fixture.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const impact = new ImpactService({ dataDir })
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir, impact, triggerMode: 'smart',
    requestApproval: (caller, config, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated) })
  registerTools(ctx, registry)
  let call = 0
  const invoke = async (name, args = {}) => {
    const result = await executeTool(tools, {
      callId: ToolCallId('toolchain-' + fixtureId + '-' + ++call), name: 'page_preview_' + name,
      arguments: args, signal: AbortSignal.timeout(90000), agent,
    })
    assert.equal(result.isError, false, 'Actual SDK must return a domain result')
    return result.value
  }
  t.after(async () => {
    impact.forget(session.id)
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await fixture.cleanup()
  })
  return { ...fixture, dataDir, project, save, ctx, client, registry, impact, session, invoke }
}

const api = (preview, path) => fetch(new URL(path, preview.url)).then(response => response)

async function chain(t, spec, fixtureId) {
  const f = await setup(t, spec, fixtureId)
  const openArgs = { projectId: fixtureId, target: { kind: 'file', path: 'src/Target.vue' },
    scope: 'component', requirements: ['isolated-target'] }
  const shared = { businessPaths: ['/api/**'], handlers: 'mock/handlers.mjs' }
  f.project.scenarios = {
    // props 进预览入口 JSON：own/alt 切换会真实重写临时入口并等 webpack 落盘，
    // 覆盖「入口变了」的编译等待路径（fixture-only 差异入口字节相同走跳过分支）。
    own: { ...shared, props: { marker: 'own' }, http: [
      { method: 'GET', path: '/api/file-data', response: { status: 200, bodyFile: 'mock/data.bin' } },
    ] },
    alt: { ...shared, props: { marker: 'alt' }, http: [
      { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'alt-orders' } } },
      { method: 'GET', path: '/api/file-data', response: { status: 200, bodyFile: 'mock/data.bin' } },
    ] },
    // navigation 负断言（R5-2 后）：route 已放行执行，但必须显式 setup.navigate 绑定；
    // 本 fixture 未配置 runtime.setup，如实拒绝，不静默跳过导航。
    routed: { ...shared, route: { path: '/in-app' }, http: [] },
  }
  await f.put('mock/handlers.mjs', HANDLERS)
  await f.put('mock/data.bin', 'bin-data')
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')

  const gated = await f.invoke('open', { ...openArgs, scenario: 'routed' })
  assert.equal(gated.status, 'needs_configuration')
  assert.ok(gated.diagnostics?.some(value => value.code === 'unsupported_capability'
      && /setup\.navigate/.test(value.message)),
    'CLI scenario route without setup.navigate must be rejected: ' + JSON.stringify(gated.diagnostics))

  const opened = await f.invoke('open', { ...openArgs, scenario: 'own' })
  assert.equal(opened.status, 'ok', JSON.stringify(opened))
  assert.equal(opened.preview.state, 'reachable')
  const id = opened.preview.previewId

  // Node handler 真实挂上 devServer 自有层并执行；bodyFile fixture 惰性供出。
  assert.deepEqual(await api(opened.preview, '/api/handled').then(r => r.json()), { value: 'handled' })
  assert.equal(await api(opened.preview, '/api/file-data').then(r => r.text()), 'bin-data')

  // R3-1：未命中请求记入 unmatched 与 fixture 草稿（占位 body），不把 404 当成数据。
  assert.equal((await api(opened.preview, '/api/orders?n=1')).status, 404)
  const detail = await f.invoke('status', { previewId: id, detail: true })
  assert.ok(detail.unmatched?.entries?.some(value => value.path === '/api/orders'),
    'status must surface the unmatched request')
  assert.ok(detail.fixtureDraft?.fixtures?.some(value => value.path === '/api/orders'),
    'status must surface a fillable fixture draft')

  // R3-2：把草稿对应的 fixture 填进配置后 refresh 即生效，不需要 reopen。
  f.project.scenarios.own.http.push(
    { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'filled-orders' } } })
  await f.save()
  await f.invoke('refresh', { previewId: id })
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'filled-orders' })
  assert.equal((await api(opened.preview, '/api/other')).status, 404, 'Other paths stay honestly unmatched')

  // 切换场景：refresh 带 scenario，数据换绑后旧 fixture 不再服务，unmatched 清空。
  await f.invoke('refresh', { previewId: id, scenario: 'alt' })
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' })
  const afterSwitch = await f.invoke('status', { previewId: id })
  assert.equal(afterSwitch.preview.scenario, 'alt')
  assert.equal(afterSwitch.preview.freshness, 'unverified')
  assert.equal((await api(opened.preview, '/api/orders')).status, 200)

  // 失败路径 1：场景名不存在 → config_invalid，当前预览不受影响仍服务 alt 数据。
  const missing = await f.invoke('refresh', { previewId: id, scenario: 'missing' })
  assert.equal(missing.status, 'error')
  assert.ok(missing.diagnostics?.some(value => value.code === 'config_invalid'),
    'Unknown scenario must report config_invalid: ' + JSON.stringify(missing.diagnostics))
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' })

  // 失败路径 2：handlers 文件变化 → 执行指纹不再匹配 → config_changed_needs_approval。
  await f.put('mock/handlers.mjs', HANDLERS.replace("'handled'", "'changed'"))
  const changed = await f.invoke('refresh', { previewId: id })
  assert.equal(changed.status, 'error')
  assert.ok(changed.diagnostics?.some(value => value.code === 'config_changed_needs_approval'),
    'Changed handler module must report config_changed_needs_approval: ' + JSON.stringify(changed.diagnostics))
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' })
  await f.put('mock/handlers.mjs', HANDLERS)

  // 失败路径 3：场景数据文件损坏只影响对应请求——bodyFile 缺失 → 该请求 500，其余照常。
  await rm(join(f.appRoot, 'mock/data.bin'))
  assert.equal((await api(opened.preview, '/api/file-data')).status, 500)
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' })
  await f.put('mock/data.bin', 'bin-data')
  assert.equal(await api(opened.preview, '/api/file-data').then(r => r.text()), 'bin-data')

  // R3-4/R3-5：改应用内源文件 → 真实影响分析产生本预览候选 → smart 触发 → Runner inputs-changed。
  // 先取证目标产物路径（编辑前）：目标模块在异步 chunk（__TARGET_IMPORT__ 动态导入），
  // HTML 里可能以 prefetch link 出现（wds3/html 插件注入），也可能完全没有引用（cli5 dev
  // 不发 prefetch）——扫描 src/href 的 .js 引用，并按 webpack named-chunkIds 推导名
  // js/<路径>_<名>.js 兜底。必须在编辑前定位：重建后旧标记即被替换，编辑后定位会拿到新内容。
  const before = await f.invoke('status', { previewId: id })
  const doc = await api(before.preview, '').then(r => r.text())
  const srcs = new Set([...doc.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map(m => m[1]))
  srcs.add('/js/' + openArgs.target.path.replace(/\W+/g, '_') + '.js')
  let chunkPath
  for (const src of srcs) {
    const text = await api(before.preview, src).then(r => r.text()).catch(() => '')
    if (text.includes('adapter-revision-1')) { chunkPath = src; break }
  }
  assert.ok(chunkPath, 'The emitted bundle must expose the target module chunk')
  await f.impact.beginTurn(f.session.id, f.root)
  const source = await readFile(join(f.appRoot, 'src/Target.vue'), 'utf8')
  await f.put('src/Target.vue', source.replace('adapter-revision-1', 'edited-marker'))
  const impact = await f.impact.analyzeNow(f.session.id)
  const candidate = impact.candidates.find(value =>
    value.selector.kind === 'file' && value.selector.path === 'src/Target.vue')
  assert.ok(candidate, 'Editing the previewed source must yield this preview as an impact candidate')
  await f.registry.onTurnAnalyzed(f.session.id, impact)
  // inputs-changed → webpack 重建 → dev-middleware 供出新包；编译窗口内产物请求如实等待，
  // 轮询该 chunk 直到新标记供出（HTTP/进程级证据，不涉及浏览器应用）。
  let seen = before.preview
  let served = ''
  for (let i = 0; i < 240; i++) {
    await delay(50)
    const current = (await f.invoke('status', { previewId: id })).preview
    seen = current
    served = await api(current, chunkPath).then(r => r.text()).catch(() => '')
    if (served.includes('edited-marker') || ['failed', 'stopped'].includes(current.state)) break
  }
  assert.ok(served.includes('edited-marker'),
    'webpack dev-server must serve the edited source in the rebuilt bundle')
  assert.ok(['reachable', 'ready', 'degraded'].includes(seen.state),
    'Preview must return to a serving state')

  // 失败路径 4（R5-0b，决策①）：编译失败的构建上切场景——own/alt 的 props 不同 → 入口重写，
  // 但写后编译失败 → 入口未生效 → 不换绑、不回写 plan.scenario（status 仍是旧场景 alt），
  // 旧 Mock 数据继续一致服务；refresh 结果以 compile_error 如实报告未应用，stale 不谎报 current。
  await f.put('src/Target.vue', '<script>export default { name: this is not valid syntax }</script>\n')
  let broken = before.preview
  for (let i = 0; i < 240; i++) {
    await delay(50)
    broken = (await f.invoke('status', { previewId: id })).preview
    if (broken.freshness === 'stale' || ['failed', 'stopped'].includes(broken.state)) break
  }
  assert.equal(broken.freshness, 'stale',
    'Compile failure must move freshness to stale, never claim current: ' + JSON.stringify(broken))
  const rejected = await f.invoke('refresh', { previewId: id, scenario: 'own' })
  assert.equal(rejected.status, 'ok',
    'An unapplied scenario update stays recoverable: ' + JSON.stringify(rejected))
  assert.ok(rejected.diagnostics?.some(value => value.code === 'compile_error'
      && value.message.includes('was not applied')),
    'The refresh result must report the update was not applied: '
      + JSON.stringify(rejected.diagnostics))
  const stale = await f.invoke('status', { previewId: id })
  assert.equal(stale.preview.freshness, 'stale',
    'An unapplied scenario update must stay stale: ' + JSON.stringify(stale.preview))
  assert.equal(stale.preview.scenario, 'alt',
    'An unapplied scenario update keeps the previous scenario name: ' + JSON.stringify(stale.preview))
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' },
    'The previous scenario data must keep serving when the entry rewrite does not take effect')
}

for (const name of Object.keys(specs)) {
  test('toolchain CLI E2E (' + name + '): scenario chain + failure paths', options(name),
    async t => chain(t, specs[name], specs[name]().fixtureId))
}
