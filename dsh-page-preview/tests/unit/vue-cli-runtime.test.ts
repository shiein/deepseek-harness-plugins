/** 真 Vue CLI 执行器（方案 §6.9、§9.2、§15.3）；自有样本，使用显式工具链，不在 Host 执行项目配置。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { vueCliAdapter } from '../../src/adapters/vue/cli/index.ts'
import { createCliAppRoot, createVueCliFixture } from '../helpers/vue-cli-fixture.ts'
import type { CliFixtureSpec } from '../helpers/vue-cli-fixture.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { setCliWorkerState, resolveBase, mergeConfig } from '../../src/adapters/vue/cli/dev-server-hook.ts'
import { launchChrome, chromeAvailable } from '../helpers/headless-chrome.ts'
import type { ChromePage } from '../helpers/headless-chrome.ts'
import type { RunningHandle, RunEvent, StartContext } from '../../src/adapters/types.ts'
import type { Diagnostic } from '../../src/shared/contracts.ts'
import { strict } from '../helpers/test-gate.ts'

const toolchain = (name: string) => fileURLToPath(new URL('../toolchains/' + name + '/node_modules', import.meta.url))
const available = (name: string) => existsSync(toolchain(name) + '/@vue/cli-service/package.json')
const skipFor = (name: string) => !available(name) && !strict

const vue27 = (): CliFixtureSpec => ({
  modules: toolchain('vue27-cli'),
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', '@vue/cli-plugin-typescript', 'vue-template-compiler', 'typescript', 'ant-design-vue', 'core-js'],
  packageDeps: { vue: '2.7.16', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9', '@vue/cli-plugin-typescript': '5.0.9', 'vue-template-compiler': '2.7.16', typescript: '5.9.3', 'ant-design-vue': '1.7.8', 'core-js': '3.51.0' },
  targetPath: 'src/Target.vue',
  fixtureId: 'vue27-cli-app',
  files: {
    'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js': `module.exports = api => { api.cache(true); require('fs').writeFileSync('__CONFIG_MARKER__', String(process.pid), { mode: 0o600 }); return { presets: ['@vue/cli-plugin-babel/preset'] } }\n`,
    'tsconfig.json': `{"compilerOptions":{"target":"es2018","module":"esnext","strict":false,"moduleResolution":"node","esModuleInterop":true,"experimentalDecorators":true,"lib":["es2018","dom","dom.iterable"]}}\n`,
    'src/vue-shims.d.ts': `declare module '*.vue' { import Vue from 'vue'; export default Vue }\n`,
    'src/main.js': `import Vue from 'vue'; import App from './Target.vue'; export { Vue, App }\n`,
    'src/Target.vue': `<script lang="ts">
import Vue from 'vue'
import { Button } from 'ant-design-vue'
export default Vue.extend({ name: 'CliTarget', components: { AButton: Button }, data: () => ({ count: 0 }) })
</script>
<template><article><h1>cli-target-27</h1><a-button @click="count++">antdv count: {{ count }}</a-button></article></template>
<style scoped>article { padding: 8px }</style>\n`,
  },
})

const vue26 = (): CliFixtureSpec => ({
  modules: toolchain('vue26-cli'),
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler', 'element-ui', 'core-js'],
  packageDeps: { vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9', 'vue-template-compiler': '2.6.14', 'element-ui': '2.15.14', 'core-js': '3.51.0' },
  targetPath: 'src/Target.vue',
  fixtureId: 'vue26-cli-app',
  files: {
    'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js': `module.exports = api => { api.cache(true); require('fs').writeFileSync('__CONFIG_MARKER__', String(process.pid), { mode: 0o600 }); return { presets: ['@vue/cli-plugin-babel/preset'] } }\n`,
    'src/main.js': `import Vue from 'vue'; import App from './Target.vue'; export { Vue, App }\n`,
    'src/Target.vue': `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button }, data: () => ({ count: 0 }) }
</script>
<template><article><h1>cli-target-26</h1><el-button @click="count++">element count: {{ count }}</el-button></article></template>
<style scoped>article { padding: 8px }</style>\n`,
  },
})

for (const [name, spec] of [['vue27-ts-antdv1', vue27], ['vue26-js-element-ui', vue26]] as const) {
  test('real Vue CLI worker (' + name + ') owns listener, serves owned document and cleans process/port/temp paths', { skip: skipFor(name === 'vue27-ts-antdv1' ? 'vue27-cli' : 'vue26-cli'), timeout: 150000 }, async t => {
    const f = await createVueCliFixture(spec())
    let running: RunningHandle | undefined
    t.after(async () => { if (running) await running.stop(); await f.cleanup() })
    const handle = await vueCliAdapter.start(f.input)
    running = handle
    assert.equal(f.verifications(), 3)
    const entries = await f.ledger.listByPreview(f.input.previewId)
    const proc = entries.find(value => value.resource.kind === 'process')?.resource
    assert.ok(proc?.kind === 'process')
    assert.notEqual(proc.pid, process.pid)
    assert.equal(Number(await readFile(f.configMarker, 'utf8')), proc.pid, 'Project build configuration must execute in the owned worker')
    const url = new URL(handle.url)
    assert.equal(url.pathname, '/__dsh_page_preview__/index.html')
    assert.deepEqual(await findListeningPids(Number(url.port)), [proc.pid])
    const document = await fetch(handle.url)
    assert.equal(document.status, 200)
    const html = await document.text()
    assert.ok(html.includes('__dsh_preview_root'), 'Owned mount container must be present')
    assert.ok(html.includes('__DSH_PREVIEW__'), 'Bootstrap script must be injected into the owned document')
    assert.match(document.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
    const entry = await fetch(url.origin + '/js/' + 'dshPagePreview' + '.js')
    assert.equal(entry.status, 200)
    const bundle = await entry.text()
    assert.match(bundle, /startVuePreview/)
    const unmatched = await fetch(url.origin + '/api/unknown')
    assert.equal(unmatched.status, 404)
    assert.deepEqual(await unmatched.json(), { code: 'unmatched_request' })
    assert.equal((await fetch(url.origin + '/__dsh_preview/health')).status, 403)
    assert.ok(f.events.some(value => value.type === 'evidence' && value.layer === 'serviceReachable' && value.evidence.status === 'proven'))
    assert.ok(f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'unverified_toolchain'), 'vue-cli stays unverified until samples pass')
    const diagnostics = f.events.filter((value): value is Extract<typeof value, { type: 'diagnostic' }> => value.type === 'diagnostic').map(value => value.diagnostic as Diagnostic)
    assert.ok(!JSON.stringify(diagnostics).includes(String(proc.pid) + ' leaked'), 'Diagnostics must not leak raw worker output')
    assert.deepEqual(await handle.stop(), { residual: [] })
    assert.deepEqual(await handle.stop(), { residual: [] })
    assert.equal(await readProcessStartTime(proc.pid), undefined)
    assert.deepEqual(await findListeningPids(Number(url.port)), [])
    assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
  })
}

test('project publicPath under a subpath still serves the owned transformed document and its assets', { skip: skipFor('vue27-cli'), timeout: 150000 }, async t => {
  const spec = vue27()
  spec.files['vue.config.js'] = `module.exports = { productionSourceMap: false, transpileDependencies: [], publicPath: '/app/' }\n`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const url = new URL(handle.url)
  // 预览文档仍在根路径供出（运行时发布的 URL 不变），同一变换后的文档在产物前缀下也可达。
  const document = await fetch(handle.url)
  assert.equal(document.status, 200)
  const html = await document.text()
  assert.ok(html.includes('__DSH_PREVIEW__'), 'Bootstrap must be injected under a sub-path publicPath')
  const prefixed = await fetch(url.origin + '/app/__dsh_page_preview__/index.html')
  assert.equal(prefixed.status, 200)
  assert.ok((await prefixed.text()).includes('__DSH_PREVIEW__'), 'The emitted-path URL must serve the transformed document, not raw webpack output')
  // publicPath 下的 webpack 产物由 dev-server 供出，准入不误拦。
  const entry = await fetch(url.origin + '/app/js/' + 'dshPagePreview' + '.js')
  assert.equal(entry.status, 200)
  assert.match(await entry.text(), /startVuePreview/)
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('vue-element-admin shaped devServer is taken over: fields recorded, proxy/mock never executed',
  { skip: skipFor('vue27-cli'), timeout: 150000 }, async t => {
  const spec = vue27()
  // 仿 vue-element-admin 的真实 devServer：port/open/proxy 转发真实后端/before 挂 mock-server。
  spec.files['vue.config.js'] = `const path = require('path')
module.exports = {
  publicPath: '/',
  outputDir: 'dist',
  lintOnSave: false,
  productionSourceMap: false,
  transpileDependencies: [],
  devServer: {
    port: 9527,
    open: true,
    allowedHosts: 'all',
    headers: { 'X-Admin': '1' },
    proxy: { '/dev-api': { target: 'http://localhost:3000', changeOrigin: true, pathRewrite: { '^/dev-api': '' } } },
    before: require('./mock/mock-server.js'),
    historyApiFallback: { index: '/index.html' },
  },
}
`
  // vue-element-admin 的 mock-server.js 形态：app 上注册 mock 路由；被执行会写标记证明。
  spec.files['mock/mock-server.js'] = `module.exports = app => {
  require('node:fs').writeFileSync('__CONFIG_MARKER__' + '.mock-ran', '1')
  app.get('/dev-api/user', (req, res) => res.json({ code: 20000, data: { name: 'mock-admin' } }))
}
`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const document = await fetch(handle.url)
  assert.equal(document.status, 200, 'preview must open under an element-admin shaped devServer')
  assert.ok((await document.text()).includes('__DSH_PREVIEW__'))
  const url = new URL(handle.url)
  assert.notEqual(url.port, '9527', 'the project port must not bind')
  // 逐项接管清单进入诊断：removed 的钩子/proxy 与 overridden 的监听/头字段都列出。
  const diff = f.events.find(value => value.type === 'diagnostic' && value.diagnostic.code === 'devserver_taken_over')
  assert.ok(diff?.type === 'diagnostic', 'a devserver_taken_over diagnostic must list every taken-over field')
  const text = diff.diagnostic.message
  for (const key of ['port', 'allowedHosts', 'headers', 'historyApiFallback'])
    assert.match(text, new RegExp(key + ' \\(overridden\\)'), key + ' overridden')
  for (const key of ['proxy', 'before', 'open'])
    assert.match(text, new RegExp(key + ' \\(removed\\)'), key + ' removed')
  assert.match(diff.diagnostic.hint ?? '', /scenario/, 'the hint must point agents at scenario fixtures')
  // proxy 从未执行：/dev-api 按未命中明确 404，绝不转发真实后端。
  const proxied = await fetch(url.origin + '/dev-api/user')
  assert.equal(proxied.status, 404)
  assert.deepEqual(await proxied.json(), { code: 'unmatched_request' })
  // before mock-server 从未执行：标记文件不存在，mock 路由不存在。
  assert.equal(existsSync(f.configMarker + '.mock-ran'), false, 'the project before hook must never run')
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

/** configureWebpack/插件钩子形态：不经 vue.config.js 顶层 devServer 的业务中间件与 proxy（2026-11-03 review）。 */
const bypassFiles = (marker: string, deps: Record<string, string>) => ({
  'package.json': JSON.stringify({ private: true, devDependencies: deps,
    vuePlugins: { service: ['./local-mock-plugin.js'] } }),
  'local-mock-plugin.js': `module.exports = api => {
  api.configureDevServer(app => app.get('/api/plugin', (req, res) => res.end('plugin-mock')))
}
`,
  'vue.config.js': `const fs = require('fs')
module.exports = {
  productionSourceMap: false,
  transpileDependencies: [],
  configureWebpack: { devServer: {
    proxy: { '/api': { target: 'http://127.0.0.1:9', changeOrigin: true } },
    onListening() { fs.writeFileSync('${marker}.listening', '1') },
    onBeforeSetupMiddleware(ds) { ds.app.get('/api/leak', (req, res) => res.end('leak-from-project')) },
    before(app) { app.get('/api/leak', (req, res) => res.end('leak-from-project')) },
    after(app) { app.get('/api/after', (req, res) => res.end('after')) },
  } },
}
`,
})
const assertBypassClosed = async (
  f: Awaited<ReturnType<typeof createVueCliFixture>>, handle: RunningHandle, marker: string,
) => {
  const origin = new URL(handle.url).origin
  for (const path of ['/api/leak', '/api/plugin', '/api/after', '/__open-in-editor', '/__open-in-editor?file=x.js']) {
    const response = await fetch(origin + path)
    const body = await response.clone().text()
    assert.equal(response.status, 404,
      path + ' must not reach project/plugin/cli-service middleware: ' + body.slice(0, 200))
    assert.equal(body, JSON.stringify({ code: 'unmatched_request' }), path + ': ' + body.slice(0, 200))
  }
  assert.equal(existsSync(marker + '.listening'), false, 'webpack devServer onListening must never run')
  const diff = f.events.filter(value => value.type === 'diagnostic' && value.diagnostic.code === 'devserver_taken_over')
    .map(value => value.type === 'diagnostic' ? value.diagnostic.message : '').join(' ')
  for (const key of ['webpack.devServer.proxy', 'webpack.devServer.onListening', 'plugin.configureDevServer x1'])
    assert.ok(diff.includes(key + ' (removed)'), key + ' must be reported as removed: ' + diff)
  // 业务 Upgrade（含 ws 代理）在 HTTP server 入口就被销毁，不进入任何项目监听器。
  const upgraded = await new Promise<string>(resolve => {
    const socket = connect(Number(new URL(origin).port), '127.0.0.1', () => socket.write(
      'GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'))
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('close', () => resolve(data))
    socket.on('error', () => resolve(data))
  })
  assert.equal(upgraded, '', 'business Upgrade must be destroyed without a response')
  assert.ok(f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'blocked_request'))
}

test('webpack-config devServer and plugin dev-server hooks never bypass the owned layer (wds v4)',
  { skip: skipFor('vue26-cli'), timeout: 150000 }, async t => {
  const spec = vue26()
  const marker = join(tmpdir(), 'dsh-cli-bypass-' + process.pid + '-v4')
  Object.assign(spec.files, bypassFiles(marker, spec.packageDeps))
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => {
    if (running) await running.stop()
    await f.cleanup()
    await rm(marker + '.listening', { force: true })
  })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  await assertBypassClosed(f, handle, marker)
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('webpack-config devServer and plugin hooks never bypass the owned layer (wds v3 / cli-service 4)',
  { skip: skipFor('vue26-cli4'), timeout: 150000 }, async t => {
  const spec = vue26()
  spec.modules = toolchain('vue26-cli4')
  spec.fixtureId = 'vue26-cli4-bypass'
  spec.env = { NODE_OPTIONS: '--openssl-legacy-provider' }
  const marker = join(tmpdir(), 'dsh-cli-bypass-' + process.pid + '-v3')
  Object.assign(spec.files, bypassFiles(marker, spec.packageDeps))
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => {
    if (running) await running.stop()
    await f.cleanup()
    await rm(marker + '.listening', { force: true })
  })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  await assertBypassClosed(f, handle, marker)
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('project .env files are not loaded into the preview worker',
  { skip: skipFor('vue27-cli'), timeout: 150000 }, async t => {
  // R2-6 受控加载：与 Vite envDir:false 对齐——若 .env 进入 process.env，vue.config.js 立刻抛错。
  const spec = vue27()
  spec.files['.env'] = 'VUE_APP_PREVIEW_MARKER=must-not-load\n'
  spec.files['.env.development'] = 'VUE_APP_PREVIEW_DEV=must-not-load-either\n'
  spec.files['vue.config.js'] = `if (process.env.VUE_APP_PREVIEW_MARKER || process.env.VUE_APP_PREVIEW_DEV) {
  throw new Error('project .env was loaded into the preview worker')
}
module.exports = { productionSourceMap: false, transpileDependencies: [] }
`
  const f = await createVueCliFixture(spec)
  assert.ok(f.input.plan.knownDifferences.some(text => text.includes('.env')),
    'the env-loading difference must be disclosed in the plan')
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const document = await fetch(handle.url)
  assert.equal(document.status, 200, 'preview must open while a project .env exists but is not loaded')
  assert.ok((await document.text()).includes('__DSH_PREVIEW__'))
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('real Vue CLI 4 worker (webpack-dev-server v3) serves owned document via devServer.before', { skip: skipFor('vue26-cli4'), timeout: 150000 }, async t => {
  const spec = vue26()
  spec.modules = toolchain('vue26-cli4')
  spec.fixtureId = 'vue26-cli4-app'
  // Node 24 + webpack4(md4) 的真实组合需要 legacy provider；如实声明为 runtime.env（进执行指纹与 worker env）。
  spec.env = { NODE_OPTIONS: '--openssl-legacy-provider' }
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const url = new URL(handle.url)
  const proc = (await f.ledger.listByPreview(f.input.previewId)).find(value => value.resource.kind === 'process')?.resource
  assert.ok(proc?.kind === 'process')
  assert.equal(Number(await readFile(f.configMarker, 'utf8')), proc.pid, 'Project build configuration must execute in the owned worker')
  const document = await fetch(handle.url)
  assert.equal(document.status, 200)
  const html = await document.text()
  assert.ok(html.includes('__DSH_PREVIEW__'), 'Bootstrap must be injected via the wds v3 before-hook middleware')
  // webpack4 产物命名/分包与 v5 不同：以文档引用的 script src 为准逐一验证准入放行。
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]!)
  assert.ok(scripts.length > 0, 'Preview document must reference emitted scripts')
  for (const src of scripts) {
    const asset = await fetch(new URL(src, url.origin))
    assert.equal(asset.status, 200, 'Emitted script must be served: ' + src)
    assert.ok((await asset.text()).length > 1000, 'Emitted script must be a real bundle: ' + src)
  }
  // 最强证据：真实浏览器执行 webpack4 入口 → startVuePreview 运行 → 目标组件挂载。
  if (chromeAvailable()) {
    const chrome = await launchChrome(t)
    try {
      await chrome.navigate(handle.url)
      let text = ''
      for (let i = 0; i < 150; i++) {
        text = String(await chrome.evaluate('document.body.innerText'))
        if (text.includes('cli-target-26')) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.ok(text.includes('cli-target-26'), 'webpack4 entry must execute and mount Vue 2.6 in a real browser: ' + text.slice(0, 200) + ' | page events: ' + chrome.events().join(' ; ').slice(0, 3000))
      assert.ok(f.events.some(value => value.type === 'evidence' && value.layer === 'documentLoaded' && value.evidence.status === 'proven'), 'documentLoaded must be proven by the real browser')
    } finally { await chrome.close() }
  }
  const unmatched = await fetch(url.origin + '/api/unknown')
  assert.equal(unmatched.status, 404)
  // wdm v3 的 getFilenameFromUrl 对任意 URL 都给映射：未命中必须由自有层明确回 unmatched_request。
  assert.deepEqual(await unmatched.json(), { code: 'unmatched_request' })
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('less theme override compiles and applies in headless Chrome', { skip: skipFor('vue27-cli') || !chromeAvailable(), timeout: 150000 }, async t => {
  const spec = vue27()
  spec.packages = [...spec.packages, 'less', 'less-loader']
  spec.packageDeps = { ...spec.packageDeps, less: '4.2.2', 'less-loader': '11.1.4' }
  spec.files['src/theme.less'] = `@brand: #663399;\n`
  spec.files['src/Target.vue'] = `<script lang="ts">
import Vue from 'vue'
import { Button } from 'ant-design-vue'
export default Vue.extend({ name: 'CliTarget', components: { AButton: Button }, data: () => ({ count: 0 }) })
</script>
<template><article><h1 class="brand-mark">cli-target-27</h1><a-button @click="count++">antdv count: {{ count }}</a-button></article></template>
<style lang="less" scoped>@import './theme.less'; .brand-mark { color: @brand; }</style>\n`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  t.after(async () => { if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  // 编译证据：无 compile_error（less 变量经 less-loader 正常解析）；浏览器证据：计算样式真实生效。
  assert.ok(!f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'compile_error'), 'Less compile must not produce compile_error')
  chrome = await launchChrome(t)
  await chrome.navigate(handle.url)
  let color = ''
  for (let i = 0; i < 150; i++) {
    color = String(await chrome.evaluate("getComputedStyle(document.querySelector('.brand-mark') || document.body).color"))
    if (color === 'rgb(102, 51, 153)') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(color, 'rgb(102, 51, 153)', 'Less-compiled style must apply in a real browser')
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('project with multiple pages config still previews (pages replaced, other pages not served)', { skip: skipFor('vue27-cli'), timeout: 150000 }, async t => {
  const spec = vue27()
  spec.files['vue.config.js'] = `module.exports = { productionSourceMap: false, transpileDependencies: [], pages: { legacy: { entry: 'src/legacy.js' } } }\n`
  spec.files['src/legacy.js'] = `export const legacy = 1\n`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const url = new URL(handle.url)
  assert.equal((await fetch(handle.url)).status, 200, 'Multi-page project config must not break the preview page')
  // 项目的其它页面条目被 pages 覆盖移除——legacy.html 未产出，按未命中如实 404。
  const legacy = await fetch(url.origin + '/legacy.html')
  assert.equal(legacy.status, 404, 'Replaced project pages must not be emitted')
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('headless Chrome mounts the real Vue 2.6 + element-ui target and interaction mutates DOM', { skip: skipFor('vue26-cli') || !chromeAvailable(), timeout: 150000 }, async t => {
  const f = await createVueCliFixture(vue26())
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  t.after(async () => { if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  chrome = await launchChrome(t)
  await chrome.navigate(handle.url)
  // 真实浏览器加载预览：等待 Vue 2.6 挂载目标组件（element-ui 按钮渲染为 .el-button）。
  let text = ''
  for (let i = 0; i < 150; i++) {
    text = String(await chrome.evaluate('document.body.innerText'))
    if (text.includes('cli-target-26')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(text.includes('cli-target-26'), 'Vue 2 target component must mount in a real browser: ' + text.slice(0, 200))
  assert.ok(text.includes('element count: 0'), 'element-ui counter button must render: ' + text.slice(0, 200))
  await chrome.evaluate("document.querySelector('.el-button').click()")
  for (let i = 0; i < 50; i++) {
    text = String(await chrome.evaluate('document.body.innerText'))
    if (text.includes('element count: 1')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(text.includes('element count: 1'), 'Click must drive Vue 2 reactivity in a real browser: ' + text.slice(0, 200))
  // bootstrap 的 document-loaded 报告经回传通道送达 → documentLoaded 层 proven（真实浏览器路径）。
  assert.ok(f.events.some(value => value.type === 'evidence' && value.layer === 'documentLoaded' && value.evidence.status === 'proven'), 'Real browser navigation must prove documentLoaded')
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('recompilation auto-reloads the owned document (unverified → current); compile failure stays stale', {
  skip: skipFor('vue26-cli') || !chromeAvailable(), timeout: 150000,
}, async t => {
  const f = await createVueCliFixture(vue26())
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  t.after(async () => { if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  chrome = await launchChrome(t)
  await chrome.navigate(handle.url)
  const freshness = () => f.events
    .filter((value): value is Extract<typeof value, { type: 'freshness' }> => value.type === 'freshness')
    .map(value => value.freshness)
  const text = async () => {
    // reload 切换执行上下文期间瞬时失败，下一轮再读
    try { return String(await chrome!.evaluate('document.body.innerText')) } catch { return '' }
  }
  const waitText = async (needle: string) => {
    for (let i = 0; i < 150; i++) {
      const value = await text()
      if (value.includes(needle)) return value
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return ''
  }
  const waitFreshness = async (value: string) => {
    for (let i = 0; i < 150; i++) {
      if (freshness().at(-1) === value) return true
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return false
  }
  assert.ok((await waitText('cli-target-26')).includes('element count: 0'), 'initial mount')
  assert.ok(await waitFreshness('current'), 'initial document load must prove applied → current')
  // 手动 refresh 序列化：第二个并发调用明确拒绝；seq 递增触发浏览器经构建轮询重载。
  const first = handle.refresh!()
  await assert.rejects(handle.refresh!(), /already in flight/)
  assert.deepEqual(await first, { kind: 'updated', freshness: 'unverified' })
  assert.ok(await waitFreshness('current'), 'manual refresh reload must prove applied → current')
  // 修改 SFC：webpack 重编译 → servedBuild 变化 → 构建长轮询自动重载（无人介入），新文本真实出现。
  await f.put('src/Target.vue', `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button }, data: () => ({ count: 0 }) }
</script>
<template><article><h1>edited-target-26</h1>
<el-button @click="count++">edited count: {{ count }}</el-button></article></template>
<style scoped>article { padding: 8px }</style>\n`)
  const page = await waitText('edited-target-26')
  assert.ok(page.includes('edited count: 0'), 'edited SFC must reach the page without manual reload; freshness=' +
    freshness().join('>') + ' | events: ' + chrome.events().join(' ; ').slice(0, 2000))
  assert.ok(await waitFreshness('current'), 'auto reload after recompilation must prove applied → current')
  const tail = freshness()
  assert.deepEqual(tail.slice(-2), ['unverified', 'current'],
    'recompilation must pass unverified → current: ' + tail.join('>'))
  // 编译失败：freshness 如实 stale，诊断带文件/行列位置；手动 refresh 不冒充 current。
  await f.put('src/Target.vue', `<script>export default { broken syntax !!! }</script>\n`)
  assert.ok(await waitFreshness('stale'), 'compile failure must report stale freshness')
  const compileDiag = f.events.find(value => value.type === 'diagnostic' && value.diagnostic.code === 'compile_error')
  assert.ok(compileDiag?.type === 'diagnostic', 'compile failure must forward a compile_error diagnostic')
  assert.match(compileDiag.diagnostic.message, /Target\.vue/)
  assert.ok(compileDiag.diagnostic.location?.file || /\(3:\d+\)|:\d+/.test(compileDiag.diagnostic.message),
    'compile diagnostic must carry a file/line location')
  assert.deepEqual(await handle.refresh!(), { kind: 'updated', freshness: 'stale' },
    'refresh during a failed build must stay stale')
  // 修复 SFC → 重编译成功 → 自动重载证明 applied → current。
  await f.put('src/Target.vue', `<script>
import { Button } from 'element-ui'
export default { name: 'CliTarget', components: { ElButton: Button }, data: () => ({ count: 0 }) }
</script>
<template><article><h1>recovered-target-26</h1>
<el-button @click="count++">recovered count: {{ count }}</el-button></article></template>
<style scoped>article { padding: 8px }</style>\n`)
  assert.ok((await waitText('recovered-target-26')).includes('recovered count: 0'), 'fixed SFC must auto reload')
  assert.ok(await waitFreshness('current'), 'recovered compilation must return to current')
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('real Vue 2 entry is replayed through the generated setup without a hand-written setup and mounts Element UI',
  { skip: skipFor('vue26-cli'), timeout: 150000 }, async t => {
  // 2026-11-03（§0.3 第 10 条）：未配置 setup 时插件自动使用从入口生成的 setup（webpack 路径写入本预览临时目录）。
  const spec = vue26()
  spec.files['src/main.js'] = `import Vue from 'vue'
import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'
import App from './Target.vue'
Vue.use(ElementUI)
new Vue({ el: '#app', render: h => h(App) })
`
  spec.files['src/Target.vue'] = `<script>export default { name: 'CliTarget', data: () => ({ count: 0 }) }</script>
<template><article><h1>cli-target-26</h1><el-button @click="count++">element count: {{ count }}</el-button></article></template>`
  const base = await createCliAppRoot(spec)
  t.after(base.cleanup)
  const planned = await vueCliAdapter.plan(base.context, base.target)
  if (planned.kind !== 'plan') throw new Error('Generated-setup plan failed: ' + JSON.stringify(planned))
  assert.equal(planned.plan.generatedSetup?.entry, 'src/main.js')
  const ledger = createFileLedger(join(base.root, 'control'))
  const events: RunEvent[] = []
  const input: StartContext = { ...base.context, previewId: spec.fixtureId + '-generated', ownerSessionId: 'own-test',
    plan: planned.plan, signal: new AbortController().signal, deadline: Date.now() + 120000, ledger,
    async verifyExecution() {}, emit(event) { events.push(event) },
  }
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop() })
  const handle = await vueCliAdapter.start(input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  const { assets } = await readAssets(new URL(handle.url).origin)
  assert.match(assets, /element-ui/, 'The generated setup must replay the ElementUI registration through webpack')
  assert.match(assets, /theme-chalk/, 'The generated setup must replay the style import')
  if (chromeAvailable()) {
    const chrome = await launchChrome(t)
    try {
      await chrome.navigate(handle.url)
      let rendered = ''
      for (let attempt = 0; attempt < 150 && rendered !== 'button'; attempt++) {
        rendered = String(await chrome.evaluate(
          'document.querySelector(".el-button") ? "button" : document.body.innerText'))
        if (rendered !== 'button') await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.equal(rendered, 'button',
        'Element UI components are registered by the replayed entry: ' + chrome.events().join(' ; ').slice(0, 2000))
    } finally { await chrome.close() }
  }
  // 批准后改动入口：worker 重新生成的摘要与计划不符，拒绝执行而不是运行未批准的初始化。
  await base.put('src/main.js',
    spec.files['src/main.js']!.replace('Vue.use(ElementUI)', 'Vue.use(ElementUI, { size: "mini" })'))
  assert.deepEqual(await handle.stop(), { residual: [] })
  running = undefined
  const stale: StartContext = { ...input, previewId: spec.fixtureId + '-stale' }
  // 源文件指纹（含入口）先拦截；生成 setup 的摘要核对是第二道防线。两者都拒绝执行。
  await assert.rejects(vueCliAdapter.start(stale),
    /bindings changed before execution|entry changed after the generated setup/)
  assert.deepEqual(await ledger.listByPreview(stale.previewId), [])
})

/** 入口 bundle 只含 webpack runtime；setup/目标经动态 import() 拆成异步 chunk（js/<chunkId>.js），取回后合并断言。 */
async function readAssets(origin: string) {
  const bundle = await (await fetch(origin + '/js/dshPagePreview.js')).text()
  const ids = [...new Set([...bundle.matchAll(/__webpack_require__\.e\((?:\/\*!?\s*import\(\)\s*\*\/)?\s*\\?"([\w-]+)\\?"\)/g)].map(value => value[1]))]
  let assets = bundle
  for (const id of ids) assets += '\n' + await (await fetch(origin + '/js/' + id + '.js')).text()
  return { assets, chunkIds: ids }
}

test('vue26 Element UI full registration + scss theme override + Vuex/router via reviewed setup', { skip: skipFor('vue26-cli'), timeout: 150000 }, async t => {
  const spec = vue26()
  spec.setup = 'src/setup.js'
  spec.packages.push('vuex', 'vue-router', 'sass', 'sass-loader')
  Object.assign(spec.packageDeps, { vuex: '3.6.2', 'vue-router': '3.6.5', sass: '1.69.7', 'sass-loader': '13.3.3' })
  spec.files['src/setup.js'] = `import Vue from 'vue'
import ElementUI from 'element-ui'
import Vuex from 'vuex'
import VueRouter from 'vue-router'
import './element-variables.scss'
import Home from './Home.vue'
Vue.use(ElementUI)
Vue.use(Vuex)
Vue.use(VueRouter)
const store = new Vuex.Store({ state: { count: 41 }, mutations: { bump(state) { state.count += 1 } } })
const router = new VueRouter({ routes: [{ path: '/', component: Home }] })
export default { install() {}, createContext() { return { rootOptions: { store, router } } } }
`
  spec.files['src/element-variables.scss'] = `$--color-primary: #13c2c2;
$--font-path: '~element-ui/lib/theme-chalk/fonts';
@import '~element-ui/packages/theme-chalk/src/index';
`
  spec.files['src/Home.vue'] = `<script>export default { name: 'HomeView' }</script>\n<template><section>home-route-26</section></template>\n`
  spec.files['src/Target.vue'] = `<script>export default { name: 'CliTarget' }</script>
<template><article><el-button type="primary">{{ $store.state.count }}</el-button><router-view/></article></template>`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  const { assets } = await readAssets(new URL(handle.url).origin)
  assert.match(assets, /element-ui\/lib\/element-ui\.common/, 'Full ElementUI registration must pull the library bundle')
  assert.match(assets, /13c2c2/, 'SCSS theme override must be compiled into the served css')
  assert.match(assets, /vuex\.esm/, 'Vuex store from setup.rootOptions must be bundled')
  assert.match(assets, /vue-router\.esm/, 'Vue Router from setup.rootOptions must be bundled')
  assert.match(assets, /home-route-26/, 'Routed component must be bundled')
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('vue27 ant-design-vue 1.x resolves on-demand through babel-plugin-import', { skip: skipFor('vue27-cli'), timeout: 150000 }, async t => {
  const spec = vue27()
  spec.packages.push('babel-plugin-import')
  Object.assign(spec.packageDeps, { 'babel-plugin-import': '1.13.8' })
  spec.files['babel.config.js'] = `module.exports = api => { api.cache(true); require('fs').writeFileSync('__CONFIG_MARKER__', String(process.pid), { mode: 0o600 }); return { presets: ['@vue/cli-plugin-babel/preset'], plugins: [['import', { libraryName: 'ant-design-vue', style: 'css' }]] } }\n`
  const f = await createVueCliFixture(spec)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  const { assets } = await readAssets(new URL(handle.url).origin)
  assert.match(assets, /ant-design-vue\/lib\/button/, 'babel-plugin-import must rewrite { Button } to lib/button')
  assert.match(assets, /ant-design-vue\/lib\/button\/style\/css/, 'On-demand style must be included')
  // button 的 icon/locale-provider 传递依赖（如 date-picker/locale）会随行，属于真实依赖；未引入的重组件与全量入口不得出现。
  assert.doesNotMatch(assets, /ant-design-vue\/lib\/table\//, 'Unimported components must stay out of the bundle')
  assert.doesNotMatch(assets, /ant-design-vue\/lib\/index/, 'Full-library entry must not be bundled')
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('real Vue CLI worker forwards webpack compile errors with file/line and turns freshness stale', { skip: skipFor('vue26-cli'), timeout: 150000 }, async t => {
  const f = await createVueCliFixture(vue26())
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  assert.equal((await fetch(handle.url)).status, 200)
  await f.put('src/Target.vue', `<script>\nexport default { name: 'Broken',\n</script>\n<template><div/></template>`)
  const isDiagnostic = (value: RunEvent): value is Extract<RunEvent, { type: 'diagnostic' }> => value.type === 'diagnostic'
  const deadline = Date.now() + 60000
  let diagnostic: Diagnostic | undefined
  while (diagnostic === undefined && Date.now() < deadline) {
    diagnostic = f.events.filter(isDiagnostic).map(value => value.diagnostic).find(value => value.code === 'compile_error' && value.location?.file === 'src/Target.vue')
    if (diagnostic === undefined) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(diagnostic, 'Webpack compile error must be forwarded as a compile_error diagnostic')
  assert.equal(diagnostic.location?.file, 'src/Target.vue')
  assert.ok(typeof diagnostic.location?.line === 'number' && diagnostic.location.line > 0, 'compile_error must carry the offending line number')
  assert.ok(f.events.some(value => value.type === 'freshness' && value.freshness === 'stale'), 'Failed compilation must turn freshness stale')
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('real Vue CLI worker advances freshness to current only after a document reload proves the latest build', { skip: skipFor('vue26-cli'), timeout: 150000 }, async t => {
  const f = await createVueCliFixture(vue26())
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const handle = await vueCliAdapter.start(f.input)
  running = handle
  const url = new URL(running.url)
  const current = () => f.events.filter(event => event.type === 'freshness' && event.freshness === 'current').length
  const stamp = async () => {
    const html = await (await fetch(running!.url)).text()
    return { build: /__DSH_BUILD__="([^"]+)"/.exec(html)?.[1], nonce: /"nonce":"([a-f0-9]+)"/.exec(html)?.[1] }
  }
  const post = (report: unknown, nonce: string) => fetch(url.origin + '/__dsh_preview/report', { method: 'POST', body: JSON.stringify({ nonce, previewId: f.input.previewId, report }) })
  const wait = async (freshness: 'current' | 'stale' | 'unverified', count = 1) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (f.events.filter(event => event.type === 'freshness' && event.freshness === freshness).length >= count) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Freshness not observed: ' + freshness)
  }
  // webpack done 已给初始文档编译 hash；document-loaded 带同印章 → current。
  const first = await stamp()
  assert.ok(first.build, 'initial document must carry the webpack build stamp')
  assert.ok(first.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: 'forged-stamp' }, first.nonce)).status, 204)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(current(), 0, 'a forged build stamp must not advance freshness')
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: first.build }, first.nonce)).status, 204)
  await wait('current')
  assert.equal(current(), 1)
  // SFC 修改 → done → compiled/unverified → 重载文档新印章 → current；HMR 已禁用，只能经 document-loaded 证明。
  await f.put('src/Target.vue', `<script>\nexport default { name: 'CliTarget' }\n</script>\n<template><article><h1>cli-freshness-v2</h1></article></template>`)
  await wait('unverified', 2)
  const second = await stamp()
  assert.ok(second.build && second.build !== first.build, 'a recompile must carry a new webpack hash')
  assert.ok(second.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: second.build }, second.nonce)).status, 204)
  await wait('current')
  assert.equal(current(), 2)
  // 编译错误 → stale；服务仍是旧产物，document-loaded 旧印章不能冒充 current。
  await f.put('src/Target.vue', `<script>\nexport default { name: 'Broken',\n</script>\n<template><div/></template>`)
  await wait('stale')
  const stale = await stamp()
  assert.ok(stale.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: stale.build }, stale.nonce)).status, 204)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(current(), 2, 'no applied claim may fire while the last compile failed')
  // 修复 → 新编译 → 重载证明 → current 恢复（初始+v2+修复共第 3 次 unverified，确保新编译已发生）。
  await f.put('src/Target.vue', `<script>\nexport default { name: 'CliTarget' }\n</script>\n<template><article><h1>cli-freshness-v3</h1></article></template>`)
  await wait('unverified', 3)
  const fixed = await stamp()
  assert.ok(fixed.build && fixed.build !== stale.build)
  assert.ok(fixed.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: fixed.build }, fixed.nonce)).status, 204)
  await wait('current')
  assert.equal(current(), 3)
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('scenario update whose entry rewrite never reaches webpack is not applied and keeps the old binding',
  { skip: skipFor('vue26-cli'), timeout: 120000 }, async t => {
  // R5-0b（决策①）：watchOptions.ignored 覆盖自有临时目录 → 入口重写后 invalid 永不触发 →
  // 30s 期限到仍无新构建 → worker 如实 ack applied:false（不换绑、回滚入口文件），
  // 宿主落成 compile-error outcome——旧场景 Mock/Store 一致服务。
  const spec = vue26()
  spec.files['vue.config.js'] = `module.exports = {
  productionSourceMap: false, transpileDependencies: [],
  configureWebpack: { watchOptions: { ignored: ['**/dsh-preview-vue-cli-*/**'] } },
}\n`
  const base = await createCliAppRoot(spec)
  t.after(base.cleanup)
  base.context.config.project.scenarios = {
    own: { businessPaths: ['/api/**'], props: { marker: 'own' }, http: [
      { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'own-orders' } } }] },
    alt: { businessPaths: ['/api/**'], props: { marker: 'alt' }, http: [
      { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'alt-orders' } } }] },
  }
  const planned = await vueCliAdapter.plan(base.context, base.target, 'own')
  if (planned.kind !== 'plan') throw new Error('Scenario plan failed: ' + JSON.stringify(planned))
  const ledger = createFileLedger(join(base.root, 'control'))
  const events: RunEvent[] = []
  const input: StartContext = { ...base.context, previewId: spec.fixtureId + '-unapplied',
    ownerSessionId: 'own-test', plan: planned.plan, signal: new AbortController().signal,
    deadline: Date.now() + 90000, ledger,
    async verifyExecution() {}, emit(event) { events.push(event) },
  }
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop() })
  const handle = await vueCliAdapter.start(input)
  running = handle
  const origin = new URL(handle.url).origin
  assert.deepEqual(await fetch(origin + '/api/orders').then(value => value.json()),
    { value: 'own-orders' }, 'the initial scenario must serve its own fixtures')
  // props marker 不同 → 入口字节不同 → 真实重写；watch 忽略 → 30s 期限内 webpack 不知变更。
  const outcome = await handle.switchScenario!({
    name: 'alt',
    scenario: base.context.config.project.scenarios.alt!,
    fingerprint: 'unapplied-alt',
  })
  if (outcome.kind !== 'compile-error') {
    throw new Error('Unapplied update must surface compile-error: ' + JSON.stringify(outcome))
  }
  assert.match(outcome.diagnostics[0]?.message ?? '', /not applied/)
  assert.deepEqual(await fetch(origin + '/api/orders').then(value => value.json()),
    { value: 'own-orders' }, 'the previous scenario Mock must keep serving after an unapplied update')
  assert.deepEqual(await handle.stop(), { residual: [] })
  running = undefined
  assert.deepEqual(await ledger.listByPreview(input.previewId), [])
})

test('Vue CLI mergeConfig preserves base config and takes over devServer with per-field records', () => {
  let docBase = '/'
  let takenOver: { key: string; action: string }[] = []
  const spec = { entry: '/tmp/e.js', template: '/tmp/t.html', pageName: 'p', pageFile: 'p/index.html' }
  const stub = (legacy: boolean) => setCliWorkerState({
    owned: (_req, _res, next) => next(), bindDevServer() {}, legacyDevServerHooks: legacy,
    bindDocBase(value) { docBase = value }, onDevServerTakenOver(fields) { takenOver = fields },
    onCompiled() {}, onInvalidated() {}, onCompileError() {}, onReady() {},
  })
  stub(false)
  const base = { publicPath: '/app/', css: { loaderOptions: { less: {} } }, devServer: { compress: true } }
  const merged = mergeConfig(base, spec) as Record<string, unknown>
  assert.equal(merged.publicPath, '/app/')
  assert.equal(docBase, '/app/', 'publicPath prefix must reach the worker document resolver')
  const crossOrigin = { publicPath: 'https://cdn.example.com/app/' }
  assert.throws(() => mergeConfig(crossOrigin, spec), /another origin/, 'Cross-origin publicPath must fail visibly')
  const relativePath = { publicPath: './' }
  assert.throws(() => mergeConfig(relativePath, spec), /Relative publicPath/, 'Relative publicPath must fail visibly')
  const dev = merged.devServer as Record<string, unknown>
  assert.equal(dev.host, '127.0.0.1')
  assert.equal(dev.port, 0, 'OS-assigned port: parallel CLI previews must not collide on the 8080 default')
  assert.equal(dev.hot, false)
  assert.equal(dev.webSocketServer, false)
  assert.equal(dev.compress, true, 'pass-through devServer keys are preserved')
  assert.equal(typeof dev.setupMiddlewares, 'function')
  // wds v3（cli-service 4）：无 setupMiddlewares，改走 devServer.before(app) + inline:false。
  stub(true)
  const legacy = mergeConfig({ publicPath: '/' }, spec) as Record<string, unknown>
  const legacyDev = legacy.devServer as Record<string, unknown>
  assert.equal(legacyDev.port, 0)
  assert.equal(legacyDev.inline, false)
  assert.equal(legacyDev.webSocketServer, undefined)
  assert.equal(legacyDev.setupMiddlewares, undefined)
  assert.equal(typeof legacyDev.before, 'function')
  // R2-P0-1：网络成形/中间件/函数字段被接管而非拒绝——逐项记录 removed/overridden，项目钩子不进入合并配置。
  stub(false)
  takenOver = []
  const projectDev = {
    port: 9527, host: '0.0.0.0', https: true, http2: true, server: 'https', allowedHosts: 'all', public: 'dev.local',
    headers: { 'X-Mock': '1' }, devMiddleware: { writeToDisk: true }, ipc: '/tmp/x.sock',
    hot: true, liveReload: true, historyApiFallback: { index: '/index.html' },
    proxy: { '/dev-api': { target: 'http://localhost:3000', changeOrigin: true } },
    before: () => {}, after: () => {}, setupMiddlewares: () => [], onBeforeSetupMiddleware: () => {},
    onAfterSetupMiddleware: () => {}, onListening: () => {}, open: true, bonjour: true,
    progress: () => {}, compress: true, watchFiles: ['src/**'],
  }
  const taken = mergeConfig({ publicPath: '/', devServer: projectDev }, spec) as Record<string, unknown>
  const takenDev = taken.devServer as Record<string, unknown>
  // 插件注入键（setupMiddlewares/before）与固定值键承载自有值（port=0: OS 分配，避免并行预览冲突）；其余项目值一律不保留。
  const ownedOrFixed = ['setupMiddlewares', 'before', 'host', 'port', 'hot', 'liveReload', 'historyApiFallback']
  for (const key of Object.keys(projectDev).filter(key => !['compress', 'watchFiles', ...ownedOrFixed].includes(key)))
    assert.equal(takenDev[key], undefined, 'devServer.' + key + ' must not keep the project value')
  assert.equal(takenDev.compress, true)
  assert.deepEqual(takenDev.watchFiles, ['src/**'])
  const actions = new Map(takenOver.map(field => [field.key, field.action]))
  const removedKeys = ['proxy', 'before', 'after', 'setupMiddlewares', 'onBeforeSetupMiddleware',
    'onAfterSetupMiddleware', 'onListening', 'open', 'bonjour', 'progress']
  for (const key of removedKeys)
    assert.equal(actions.get(key), 'removed', 'devServer.' + key + ' must be recorded as removed')
  const overriddenKeys = ['port', 'host', 'https', 'http2', 'server', 'allowedHosts', 'public',
    'headers', 'devMiddleware', 'ipc', 'hot', 'liveReload', 'historyApiFallback']
  for (const key of overriddenKeys)
    assert.equal(actions.get(key), 'overridden', 'devServer.' + key + ' must be recorded as overridden')
  assert.ok(!actions.has('compress') && !actions.has('watchFiles'), 'pass-through keys are not reported')
  assert.equal(typeof takenDev.setupMiddlewares, 'function', 'the owned middleware injection replaces the project hook')
})

test('Vue CLI resolveBase accepts object/sync exports and rejects async exports honestly', () => {
  assert.deepEqual(resolveBase({ a: 1 }), { a: 1 })
  assert.deepEqual(resolveBase(() => ({ b: 2 })), { b: 2 })
  assert.deepEqual(resolveBase(undefined), {})
  assert.throws(() => resolveBase(Promise.resolve({})), /Asynchronous vue\.config\.js/)
})
