/** Tier 1 UI 组件库矩阵补齐（r5-plan R5-2、方案 §6.9、§15.3）：真实工具链 + headless Chrome
 *  证明按需引入、全局 API 与同预览完整重置三项；通过后才允许 profile verified: true。
 *  element-ui 本轮不升 verified（决策 S），但同样跑齐矩阵项，结果登记进 fixtures README。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { vueCliAdapter } from '../../src/adapters/vue/cli/index.ts'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import { createCliAppRoot } from '../helpers/vue-cli-fixture.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'
import { inspectApp } from '../../src/shared/profile.ts'
import { launchChrome, chromeAvailable } from '../helpers/headless-chrome.ts'
import type { ChromePage } from '../helpers/headless-chrome.ts'
import type { RunningHandle } from '../../src/adapters/types.ts'
import type { CliFixtureSpec } from '../helpers/vue-cli-fixture.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'

const cliModules = fileURLToPath(new URL('../toolchains/vue26-cli/node_modules', import.meta.url))
const cliAvailable = existsSync(cliModules + '/@vue/cli-service/package.json')

const text = async (chrome: ChromePage) => {
  try { return String(await chrome.evaluate('document.body.innerText')) } catch { return '' }
}
const waitText = async (chrome: ChromePage, needle: string) => {
  for (let i = 0; i < 150; i++) {
    const value = await text(chrome)
    if (value.includes(needle)) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return ''
}
const present = async (chrome: ChromePage, selector: string) =>
  Boolean(await chrome.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'))
const click = (chrome: ChromePage, selector: string) =>
  chrome.evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')

/** 借显式工具链包进 appRoot 并核对锁定版本（不修改业务 package.json 安装行为）。 */
const borrow = async (f: { appRoot: string }, name: string, version: string) => {
  const installed = await realpath(join(modules!, name))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
  assert.equal(metadata.version, version, 'matrix sample requires its explicit installed version')
  await symlink(installed, join(f.appRoot, 'node_modules', name))
}

/** 换绑场景后浏览器经构建长轮询整页重载：旧场景弹层节点不存活，新场景标记出现。 */
const assertReset = async (running: RunningHandle, chrome: ChromePage, marker: string) => {
  const outcome = await running.switchScenario!({
    name: 'other', scenario: { props: { marker: 'other' } }, fingerprint: 'matrix-other' })
  assert.equal(outcome.kind, 'updated',
    'scenario switch must apply in place: ' + JSON.stringify(outcome))
  assert.ok((await waitText(chrome, marker)).includes(marker),
    'the new scenario props must render after the reload')
  assert.equal(await chrome.evaluate('document.querySelector(".el-message,.ant-message")'),
    null, 'a popup appended to body by the previous scene must not survive the reset')
}

for (const [kit, resolver, tag, apiImport, apiCall, popupSel] of [
  ['element-plus', 'ElementPlusResolver()', 'el-button', "{ ElMessage } from 'element-plus'",
    "ElMessage({ message: 'ep-toast-' + this.marker, type: 'success' })", '.el-message'],
  // antdv 4.x 为 CSS-in-JS：项目真实用法必须 importStyle:false，否则 resolver 注入不存在的样式文件。
  ['ant-design-vue', 'AntDesignVueResolver({ importStyle: false })', 'a-button',
    "{ message } from 'ant-design-vue'", "message.success('antdv-toast-' + this.marker)", '.ant-message'],
] as const) {
  test('Tier 1 ' + kit + ' matrix: on-demand resolver, global API and in-preview reset (R5-2)',
    { skip: integrationSkip || !chromeAvailable(), timeout: 120000 }, async t => {
    if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
    const f = await createVueViteFixture(modules)
    let running: RunningHandle | undefined
    let chrome: ChromePage | undefined
    t.after(async () => { if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup() })
    const versions = { 'element-plus': '2.14.2', 'ant-design-vue': '4.2.5', 'unplugin-vue-components': '0.27.5' }
    for (const name of [kit, 'unplugin-vue-components'] as const) await borrow(f, name, versions[name])
    await f.put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: {
      vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4', [kit]: versions[kit],
      'unplugin-vue-components': versions['unplugin-vue-components'] } }))
    await f.put('vite.config.mjs', `import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ` + resolver.split('(')[0] + ` } from 'unplugin-vue-components/resolvers'
export default { plugins: [vue(), Components({ resolvers: [` + resolver + `] })] }\n`)
    await f.put('src/main.js',
      `import { createApp } from 'vue'; import App from './Target.vue'; createApp(App).mount('#app')`)
    await f.put('src/Target.vue', `<script>
import ` + apiImport + `
export default { name: 'MatrixTarget', props: { marker: { type: String, default: 'none' } },
  methods: { toast() { ` + apiCall + ` } } }
</script>
<template><article><h1>` + kit + `-matrix-{{ marker }}</h1>
<` + tag + ` @click="toast">toast</` + tag + `></article></template>\n`)
    const project = { ...f.input.config.project,
      scenarios: { own: { props: { marker: 'own' } }, other: { props: { marker: 'other' } } } }
    const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
      profile: await inspectApp(f.input.workspaceRoot, f.input.appRoot), config: { ...f.input.config, project } }
    const outcome = await vueViteAdapter.plan(context, { projectId: 'vue-app', targetId: 'actual',
      scope: 'component', selector: { kind: 'file', path: 'src/Target.vue' } }, 'own')
    if (outcome.kind !== 'plan') throw new Error(kit + ' matrix plan failed: '
      + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code).join(',') : outcome.reason))
    running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
    const origin = new URL(running.url).origin
    chrome = await launchChrome(t)
    await chrome.navigate(running.url)
    assert.ok((await waitText(chrome, kit + '-matrix-own')).includes('own'),
      'initial mount with scenario props: ' + chrome.events().join(' ; ').slice(0, 1500))
    // 按需引入：resolver 把模板组件改写成具名组件导入（__unplugin_components_N），
    // 不是全量默认导入，也不引未用组件。
    const transformed = await fetch(origin + '/src/Target.vue').then(value => value.text())
    assert.match(transformed, /Button as __unplugin_components_\d+/,
      kit + ' template usage must become a named on-demand import: ' + transformed.slice(0, 500))
    assert.ok(!transformed.includes('components_table') && !transformed.includes('_es_table'),
      'on-demand imports must not pull unused components: ' + transformed.slice(0, 800))
    assert.ok(await present(chrome, tag === 'el-button' ? '.el-button' : '.ant-btn'),
      'the resolved component must render in the real browser')
    // 全局 API：点击真实按钮调用项目方式的全局 API，弹层出现在 body。
    await click(chrome, tag === 'el-button' ? '.el-button' : '.ant-btn')
    for (let i = 0; i < 50 && !(await present(chrome, popupSel)); i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(await present(chrome, popupSel),
      'the global API call must produce its popup: ' + chrome.events().join(' ; ').slice(0, 800))
    // 同预览完整重置：切场景整页重载，旧弹层不残留、新场景标记生效。
    await assertReset(running, chrome, kit + '-matrix-other')
    assert.deepEqual(await running.stop(), { residual: [] })
    running = undefined
  })
}

const elementUiSpec = (): CliFixtureSpec => ({
  modules: cliModules,
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler', 'element-ui',
    'core-js', 'babel-plugin-component'],
  packageDeps: { vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
    'vue-template-compiler': '2.6.14', 'element-ui': '2.15.14', 'core-js': '3.51.0',
    'babel-plugin-component': '1.1.1' },
  targetPath: 'src/Target.vue',
  fixtureId: 'vue26-cli-app',
  files: {
    'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js': `module.exports = { presets: ['@vue/cli-plugin-babel/preset'],
  plugins: [['component', { libraryName: 'element-ui', styleLibraryName: 'theme-chalk' }]] }\n`,
    'src/main.js': `import Vue from 'vue'
import { Button, Message } from 'element-ui'
import App from './Target.vue'
Vue.use(Button)
Vue.prototype.$message = Message
new Vue({ render: h => h(App) }).$mount('#app')\n`,
    'src/Target.vue': `<script>
import { Button } from 'element-ui'
export default { name: 'MatrixTarget', components: { ElButton: Button },
  props: { marker: { type: String, default: 'none' } },
  methods: { toast() { this.$message({ message: 'eui-toast-' + this.marker, type: 'success' }) } } }
</script>
<template><article><h1>element-ui-matrix-{{ marker }}</h1>
<el-button @click="toast">toast</el-button></article></template>\n`,
  },
})

test('Tier 1 element-ui matrix (verified stays false): on-demand plugin, $message and in-preview reset (R5-2)',
  { skip: !cliAvailable || !chromeAvailable(), timeout: 150000 }, async t => {
  const f = await createCliAppRoot(elementUiSpec())
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  t.after(async () => {
    if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup()
  })
  const installed = await realpath(join(cliModules, 'element-ui'))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
  assert.equal(metadata.version, '2.15.14', 'matrix sample requires its explicit installed version')
  const project = { ...f.context.config.project,
    scenarios: { own: { props: { marker: 'own' } }, other: { props: { marker: 'other' } } } }
  const context = { ...f.context, config: { ...f.context.config, project } }
  const outcome = await vueCliAdapter.plan(context, f.target, 'own')
  if (outcome.kind !== 'plan') throw new Error('element-ui matrix plan failed: '
    + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code).join(',') : outcome.reason))
  const ledger = createFileLedger(join(f.root, 'control'))
  const events: unknown[] = []
  running = await vueCliAdapter.start({ ...context, previewId: 'matrix-eui', ownerSessionId: 'own-test',
    plan: outcome.plan, signal: new AbortController().signal, deadline: Date.now() + 120000, ledger,
    async verifyExecution() {}, emit(event) { events.push(event) } })
  const origin = new URL(running.url).origin
  chrome = await launchChrome(t)
  await chrome.navigate(running.url)
  assert.ok((await waitText(chrome, 'element-ui-matrix-own')).includes('own'),
    'initial mount with scenario props: ' + chrome.events().join(' ; ').slice(0, 1500))
  // 按需引入：babel-plugin-component 只编译 lib/button/lib/message，不引全量入口。
  // 目标经动态 import 进独立 chunk——收集浏览器实际加载的全部 JS 资源核对模块路径。
  assert.ok(await present(chrome, '.el-button'), 'the resolved component must render in the real browser')
  const resources = await chrome.evaluate(
    'performance.getEntriesByType("resource").map(e => e.name).filter(n => n.endsWith(".js"))') as string[]
  assert.ok(resources.length > 0, 'the page must have loaded JS resources')
  let bundle = ''
  for (const url of resources) bundle += await fetch(url).then(value => value.text())
  const elementPaths = bundle.match(/element-ui[^"'\s]{0,60}/g)?.slice(0, 30).join(' | ')
  assert.ok(bundle.includes('element-ui/lib/button'),
    'on-demand import must emit lib/button modules: ' + elementPaths)
  assert.ok(!bundle.includes('element-ui/lib/table') && !bundle.includes('element-ui/lib/index'),
    'on-demand imports must not pull the full library entry: ' + elementPaths)
  await click(chrome, '.el-button')
  for (let i = 0; i < 50 && !(await present(chrome, '.el-message')); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(await present(chrome, '.el-message'),
    '$message on Vue.prototype must produce its popup: ' + chrome.events().join(' ; ').slice(0, 800))
  await assertReset(running, chrome, 'element-ui-matrix-other')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})
