/** Tier 2 UI 组件库冒烟（r5-plan R5-8、方案 §6.9）：真实工具链 + headless Chrome 证明
 *  profile 检出、入口 `.use` 重放、真实组件渲染、免费的全局 API 与同预览场景重置。
 *  通过的样本登记 fixtures README；verified 仍按 §0.3 决策逐项放行，不由本文件直接升档。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
const cliAvailable = existsSync(cliModules + '/view-design/package.json')

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

const borrow = async (f: { appRoot: string }, name: string, version: string) => {
  const installed = await realpath(join(modules!, name))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
  assert.equal(metadata.version, version, 'smoke sample requires its explicit installed version')
  const dest = join(f.appRoot, 'node_modules', name)
  await mkdir(dirname(dest), { recursive: true })
  await symlink(installed, dest)
}

interface SmokeSpec {
  /** 业务项目真实形态的全量注册入口（含样式导入）。 */
  entry: string
  /** package.json dependencies 里除 vue/vite/plugin-vue 外要借的包名→锁定版本。 */
  packages: Record<string, string>
  componentTag: string
  componentSelector: string
  /** 无需 Provider 即可直接调用的全局 API（可选；无则只验渲染）。 */
  api?: { call: string, popupSelector: string, teardown: string }
}

const specs: Record<string, SmokeSpec> = {
  'naive-ui': {
    packages: { 'naive-ui': '2.45.3' },
    entry: `import { createApp } from 'vue'; import naive from 'naive-ui';
import App from './Target.vue'; createApp(App).use(naive).mount('#app')\n`,
    componentTag: 'n-button', componentSelector: '.n-button',
  },
  'arco-design-vue': {
    packages: { '@arco-design/web-vue': '2.59.0' },
    entry: `import { createApp } from 'vue'; import ArcoVue from '@arco-design/web-vue';
import '@arco-design/web-vue/dist/arco.css';
import App from './Target.vue'; createApp(App).use(ArcoVue).mount('#app')\n`,
    componentTag: 'a-button', componentSelector: '.arco-btn',
    api: { call: "Message.success('arco-toast-' + this.marker)", popupSelector: '.arco-message',
      teardown: '.arco-message' },
  },
  'tdesign-vue': {
    packages: { 'tdesign-vue-next': '1.20.10' },
    entry: `import { createApp } from 'vue'; import TDesign from 'tdesign-vue-next';
import 'tdesign-vue-next/es/style/index.css';
import App from './Target.vue'; createApp(App).use(TDesign).mount('#app')\n`,
    componentTag: 't-button', componentSelector: '.t-button',
    api: { call: "MessagePlugin.success('td-toast-' + this.marker)", popupSelector: '.t-message',
      teardown: '.t-message' },
  },
  'primevue': {
    packages: { 'primevue': '4.2.5', '@primevue/themes': '4.2.5' },
    entry: `import { createApp } from 'vue'; import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura'; import ToastService from 'primevue/toastservice';
import App from './Target.vue';
createApp(App).use(PrimeVue, { theme: { preset: Aura } }).use(ToastService).mount('#app')\n`,
    componentTag: 'Button', componentSelector: '.p-button',
    api: { call: "this.$toast.add({ severity: 'success', summary: 'pv-toast-' + this.marker, life: 60000 })",
      popupSelector: '.p-toast-message', teardown: '.p-toast-message' },
  },
  'vant': {
    packages: { 'vant': '4.10.2' },
    entry: `import { createApp } from 'vue'; import { Button } from 'vant';
import 'vant/lib/index.css';
import App from './Target.vue'; createApp(App).use(Button).mount('#app')\n`,
    componentTag: 'van-button', componentSelector: '.van-button',
    api: { call: "showToast('vant-toast-' + this.marker)", popupSelector: '.van-toast',
      teardown: '.van-toast' },
  },
  'vuetify': {
    packages: { 'vuetify': '3.7.19' },
    entry: `import { createApp } from 'vue'; import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import App from './Target.vue';
const vuetify = createVuetify()
createApp(App).use(vuetify).mount('#app')\n`,
    // Vuetify 组件须包在 v-app 内（profile pitfall 如实记录）。
    componentTag: 'v-btn', componentSelector: '.v-btn',
  },
}

for (const [kit, spec] of Object.entries(specs)) {
  test('Tier 2 ' + kit + ' smoke: entry replay, real component and in-preview reset (R5-8)',
    { skip: integrationSkip || !chromeAvailable(), timeout: 120000 }, async t => {
    if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
    const f = await createVueViteFixture(modules)
    let running: RunningHandle | undefined
    let chrome: ChromePage | undefined
    t.after(async () => { if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup() })
    for (const [name, version] of Object.entries(spec.packages)) await borrow(f, name, version)
    await f.put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: {
      vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4', ...spec.packages } }))
    await f.put('src/main.js', spec.entry)
    const apiImports: Record<string, string> = {
      'arco-design-vue': "import { Message } from '@arco-design/web-vue'",
      'tdesign-vue': "import { MessagePlugin } from 'tdesign-vue-next'",
      'vant': "import { showToast } from 'vant'",
      'primevue': "import Button from 'primevue/button'\nimport Toast from 'primevue/toast'",
      'vuetify': "import { VApp, VBtn, VMain } from 'vuetify/components'",
    }
    const components: Record<string, string> = {
      'primevue': "{ Button, Toast }", 'vuetify': "{ VApp, VBtn, VMain }",
    }
    const componentsLine = components[kit] === undefined ? '' : 'components: ' + components[kit] + ',\n  '
    const inner = kit === 'vuetify'
      ? '<v-app><v-main><h1>vuetify-smoke-{{ marker }}</h1><v-btn @click="toast">toast</v-btn></v-main></v-app>'
      : `<article><h1>` + kit + `-smoke-{{ marker }}</h1>
<` + spec.componentTag + ` @click="toast">toast</` + spec.componentTag + `></article>`
    const toastSlot = kit === 'primevue' ? '<Toast />' : ''
    await f.put('src/Target.vue', `<script>
` + (apiImports[kit] ?? '') + `
export default { name: 'SmokeTarget', ` + componentsLine + `props: { marker: { type: String, default: 'none' } },
  methods: { toast() { ` + (spec.api?.call ?? '') + ` } } }
</script>
<template>` + inner + toastSlot + `</template>\n`)
    const project = { ...f.input.config.project,
      scenarios: { own: { props: { marker: 'own' } }, other: { props: { marker: 'other' } } } }
    const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
      profile: await inspectApp(f.input.workspaceRoot, f.input.appRoot), config: { ...f.input.config, project } }
    const outcome = await vueViteAdapter.plan(context, { projectId: 'vue-app', targetId: 'actual',
      scope: 'component', selector: { kind: 'file', path: 'src/Target.vue' } }, 'own')
    if (outcome.kind !== 'plan') throw new Error(kit + ' smoke plan failed: '
      + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code).join(',') : outcome.reason)
      + ' ' + JSON.stringify((outcome as { diagnostics?: unknown }).diagnostics ?? []))
    running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
    // 预热转换链让 vite 的 dep-optimize 落定（大型库首次扫描会触发 server 重启）；
    // 与真实浏览器首载同一触发路径，只是先等它稳下来再接 Chrome。
    const origin = new URL(running.url).origin
    await fetch(running.url)
    await fetch(origin + '/src/main.js')
    await fetch(origin + '/src/Target.vue')
    await new Promise(resolve => setTimeout(resolve, 2500))
    chrome = await launchChrome(t)
    await chrome.navigate(running.url)
    assert.ok((await waitText(chrome, kit + '-smoke-own')).includes('own'),
      kit + ' initial mount with scenario props: ' + chrome.events().join(' ; ').slice(0, 1500))
    assert.ok(await present(chrome, spec.componentSelector),
      kit + ' component must render its real class in the browser: '
        + chrome.events().join(' ; ').slice(0, 800))
    if (spec.api) {
      await click(chrome, spec.componentSelector)
      for (let i = 0; i < 50 && !(await present(chrome, spec.api.popupSelector)); i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(await present(chrome, spec.api.popupSelector),
        kit + ' global API must produce its popup: ' + chrome.events().join(' ; ').slice(0, 800))
    }
    // 同预览完整重置：切场景整页重载，新场景标记生效、旧弹层不残留。
    const outcome2 = await running.switchScenario!({
      name: 'other', scenario: { props: { marker: 'other' } }, fingerprint: 'smoke-other' })
    assert.equal(outcome2.kind, 'updated', 'scenario switch must apply in place: ' + JSON.stringify(outcome2))
    assert.ok((await waitText(chrome, kit + '-smoke-other')).includes('other'),
      'the new scenario props must render after the reload')
    if (spec.api) {
      assert.equal(await chrome.evaluate('document.querySelector(' + JSON.stringify(spec.api.teardown) + ')'),
        null, 'a popup from the previous scene must not survive the reset')
    }
    assert.deepEqual(await running.stop(), { residual: [] })
    running = undefined
  })
}

const viewDesignSpec = (): CliFixtureSpec => ({
  modules: cliModules,
  packages: ['vue', '@vue/cli-service', '@vue/cli-plugin-babel', 'vue-template-compiler',
    'view-design', 'core-js'],
  packageDeps: { vue: '2.6.14', '@vue/cli-service': '5.0.9', '@vue/cli-plugin-babel': '5.0.9',
    'vue-template-compiler': '2.6.14', 'view-design': '4.7.0', 'core-js': '3.51.0' },
  targetPath: 'src/Target.vue',
  fixtureId: 'vue26-cli-app',
  files: {
    'vue.config.js': `module.exports = { productionSourceMap: false, transpileDependencies: [] }\n`,
    'babel.config.js': `module.exports = { presets: ['@vue/cli-plugin-babel/preset'] }\n`,
    'src/main.js': `import Vue from 'vue'
import ViewUI from 'view-design'
import 'view-design/dist/styles/iview.css'
import App from './Target.vue'
Vue.use(ViewUI)
new Vue({ render: h => h(App) }).$mount('#app')\n`,
    'src/Target.vue': `<script>
export default { name: 'SmokeTarget',
  props: { marker: { type: String, default: 'none' } },
  methods: { toast() { this.$Message.success('iview-toast-' + this.marker) } } }
</script>
<template><article><h1>view-design-smoke-{{ marker }}</h1>
<Button @click="toast">toast</Button></article></template>\n`,
  },
})

test('Tier 2 view-design smoke (Vue 2.6 + vue-cli 5): $Message and in-preview reset (R5-8)',
  { skip: !cliAvailable || !chromeAvailable(), timeout: 150000 }, async t => {
  const f = await createCliAppRoot(viewDesignSpec())
  let running: RunningHandle | undefined
  let chrome: ChromePage | undefined
  t.after(async () => {
    if (chrome) await chrome.close(); if (running) await running.stop(); await f.cleanup()
  })
  const installed = await realpath(join(cliModules, 'view-design'))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
  assert.equal(metadata.version, '4.7.0', 'smoke sample requires its explicit installed version')
  const project = { ...f.context.config.project,
    scenarios: { own: { props: { marker: 'own' } }, other: { props: { marker: 'other' } } } }
  const context = { ...f.context, config: { ...f.context.config, project } }
  const outcome = await vueCliAdapter.plan(context, f.target, 'own')
  if (outcome.kind !== 'plan') throw new Error('view-design smoke plan failed: '
    + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code).join(',') : outcome.reason))
  const ledger = createFileLedger(join(f.root, 'control'))
  const events: unknown[] = []
  running = await vueCliAdapter.start({ ...context, previewId: 'smoke-viewui', ownerSessionId: 'smoke-test',
    plan: outcome.plan, signal: new AbortController().signal, deadline: Date.now() + 120000, ledger,
    async verifyExecution() {}, emit(event) { events.push(event) } })
  chrome = await launchChrome(t)
  await chrome.navigate(running.url)
  assert.ok((await waitText(chrome, 'view-design-smoke-own')).includes('own'),
    'initial mount with scenario props: ' + chrome.events().join(' ; ').slice(0, 1500))
  assert.ok(await present(chrome, '.ivu-btn'), 'view-design Button must render .ivu-btn')
  await click(chrome, '.ivu-btn')
  for (let i = 0; i < 50 && !(await present(chrome, '.ivu-message')); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(await present(chrome, '.ivu-message'),
    '$Message on Vue.prototype must produce its popup: ' + chrome.events().join(' ; ').slice(0, 800))
  const outcome2 = await running.switchScenario!({
    name: 'other', scenario: { props: { marker: 'other' } }, fingerprint: 'smoke-other' })
  assert.equal(outcome2.kind, 'updated', 'scenario switch must apply in place: ' + JSON.stringify(outcome2))
  assert.ok((await waitText(chrome, 'view-design-smoke-other')).includes('other'))
  assert.equal(await chrome.evaluate('document.querySelector(".ivu-message")'), null,
    'a popup from the previous scene must not survive the reset')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})
