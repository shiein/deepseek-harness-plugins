/**
 * 真实特征样本（R6-0，`docs/r6-plan.md` §3 R6-0）：仿真实业务项目的结构特征，不含任何业务代码。
 * 复用 vue3-self-contained 工具链，所有文件写在可丢弃临时目录。
 *
 * 每个特征可单独开关，便于失败时定位到具体特征：
 * - tsEntry：入口为 src/main.ts（runtime.entry 同步指向它）；关闭为 src/main.js
 * - regexAlias：vite.config 使用 `{ find: /\/@\//, replacement: <src>/ }`；关闭为字面量 `{ '@': <src> }`
 * - jsSuffixToTs：入口用 `'/@/x.js'`（或关闭别名时 `'@/x.js'`）导入磁盘上的 `x.ts`
 * - loginBeforeInit：入口先请求登录信息接口，成功或失败后再 `initVue()`（createApp 在函数内）
 * - inlineScript：index.html 带内联经典脚本
 * - envelopeInterceptor：自写最小请求层（fetch 封装），拦截器 `code !== 0` 即走错误分支；不新增依赖
 * - untypedApi：API 模块只有 `(param) => getRequest(url, param)`，无响应类型；关闭后带显式响应类型
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { inspectApp } from '../../src/shared/profile.ts'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import type { AdapterContext, RunEvent, StartContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'

export interface RealTraitsOptions {
  tsEntry?: boolean
  regexAlias?: boolean
  jsSuffixToTs?: boolean
  loginBeforeInit?: boolean
  inlineScript?: boolean
  envelopeInterceptor?: boolean
  untypedApi?: boolean
}

/** 全部特征默认开启；显式 false 才关闭。 */
const on = (options: RealTraitsOptions) => ({
  tsEntry: options.tsEntry !== false,
  regexAlias: options.regexAlias !== false,
  jsSuffixToTs: options.jsSuffixToTs !== false,
  loginBeforeInit: options.loginBeforeInit !== false,
  inlineScript: options.inlineScript !== false,
  envelopeInterceptor: options.envelopeInterceptor !== false,
  untypedApi: options.untypedApi !== false,
})

const REQUEST_ENVELOPE = `// 自写最小请求层：fetch 封装 + 统一响应包装拦截器（不新增依赖，仿 axios 风格）。
async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json()) as { code: number; msg: string; data: T }
  // 响应拦截器：统一包装 code !== 0 即业务失败
  if (body.code !== 0) throw new Error('business failure: ' + body.msg)
  return body.data
}
export function getRequest<T = unknown>(url: string, params?: Record<string, string>): Promise<T> {
  const query = params === undefined ? '' : '?' + new URLSearchParams(params)
  return send<T>(url + query)
}
export function postRequest<T = unknown>(url: string, body?: unknown): Promise<T> {
  return send<T>(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
`

const REQUEST_PLAIN = `// 自写最小请求层：fetch 封装，无响应包装语义（不新增依赖）。
export function getRequest<T = unknown>(url: string, params?: Record<string, string>): Promise<T> {
  const query = params === undefined ? '' : '?' + new URLSearchParams(params)
  return fetch(url + query).then(response => response.json()) as Promise<T>
}
export function postRequest<T = unknown>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(response => response.json()) as Promise<T>
}
`

const API_UNTYPED = (prefix: string, suffix: string) => `// 无响应类型的 API 模块：只有 url + param 透传。
import { getRequest, postRequest } from '${prefix}request${suffix}'

export function getLoginInfo(params: { user: string }) {
  return postRequest('/api/login', params)
}
export function getUserInfo() {
  return getRequest('/api/user/info')
}
export function getMenuList() {
  return getRequest('/api/menu/list')
}
`

const API_TYPED = (prefix: string, suffix: string) => `// 显式响应类型的 API 模块（untypedApi 关闭时）。
import { getRequest, postRequest } from '${prefix}request${suffix}'

export interface LoginResult { token: string }
export interface UserInfo { name: string; roles: string[] }
export interface MenuItem { id: number; title: string }

export function getLoginInfo(params: { user: string }): Promise<LoginResult> {
  return postRequest<LoginResult>('/api/login', params)
}
export function getUserInfo(): Promise<UserInfo> {
  return getRequest<UserInfo>('/api/user/info')
}
export function getMenuList(): Promise<MenuItem[]> {
  return getRequest<MenuItem[]>('/api/menu/list')
}
`

const APP_VUE = `<script setup>
import HomeView from './views/HomeView.vue'
</script>
<template><HomeView /></template>
`

const HOME_VIEW = (api: string, lang: string) => `<script setup${lang === 'ts' ? ' lang="ts"' : ''}>
import { ref } from 'vue'
import { getUserInfo, getMenuList } from '${api}'

const userName = ref('')
const roles = ref([])
const menus = ref([])
const loadError = ref('')
getUserInfo().then((data) => {
  userName.value = data.name
  roles.value = data.roles
}).catch(() => { loadError.value = 'load-failed' })
getMenuList().then((list) => { menus.value = list }).catch(() => { loadError.value = 'load-failed' })
</script>
<template>
  <article>
    <p v-if="loadError" class="load-error">{{ loadError }}</p>
    <template v-else>
      <h1>real-traits {{ userName }}</h1>
      <p class="roles">{{ roles.join(',') }}</p>
      <ul><li v-for="item in menus" :key="item.id">{{ item.title }}</li></ul>
    </template>
  </article>
</template>
`

export async function createRealTraitsFixture(modules: string, options: RealTraitsOptions = {}) {
  const traits = on(options)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-real-traits-')))
  try {
    const appRoot = join(root, 'app')
    const put = async (path: string, source: string) => {
      const file = join(appRoot, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source)
    }
    await put('package.json', JSON.stringify({ private: true, type: 'module',
      dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4' } }))
    for (const name of ['vue', 'vite', '@vitejs/plugin-vue']) {
      await mkdir(dirname(join(appRoot, 'node_modules', name)), { recursive: true })
      await symlink(await realpath(join(modules, name)), join(appRoot, 'node_modules', name))
    }
    const vuePluginUrl = pathToFileURL(
      join(await realpath(join(modules, '@vitejs/plugin-vue')), 'dist/index.mjs')).href
    const alias = traits.regexAlias
      ? `[{ find: /\\/@\\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) }]`
      : `{ '@': fileURLToPath(new URL('./src', import.meta.url)) }`
    await put('vite.config.mjs', `import vue from ${JSON.stringify(vuePluginUrl)}
import { fileURLToPath } from 'node:url'
export default {
  plugins: [vue()],
  resolve: { alias: ${alias} },
}
`)
    const entryExt = traits.tsEntry ? 'ts' : 'js'
    const entry = 'src/main.' + entryExt
    const inline = traits.inlineScript
      ? '<script>window.__APP_INLINE__ = true</script>' : ''
    await put('index.html', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + inline
      + '</head><body><div id="app"></div><script type="module" src="/' + entry + '"></script></body></html>')
    // API 模块：jsSuffixToTs 时说明符写 .js 而磁盘为 .ts；否则说明符省略扩展名（磁盘语言跟随入口）。
    const apiExt = traits.jsSuffixToTs ? 'ts' : entryExt
    const specifier = (name: string) =>
      (traits.regexAlias ? '/@/' : '@/') + name + (traits.jsSuffixToTs ? '.js' : '')
    await put('src/request.' + apiExt, traits.envelopeInterceptor ? REQUEST_ENVELOPE : REQUEST_PLAIN)
    const apiPrefix = traits.regexAlias ? '/@/' : '@/'
    await put('src/api/user.' + apiExt,
      (traits.untypedApi ? API_UNTYPED : API_TYPED)(apiPrefix, traits.jsSuffixToTs ? '.js' : ''))
    await put('src/App.vue', APP_VUE)
    await put('src/views/HomeView.vue', HOME_VIEW(specifier('api/user'), apiExt))
    const login = `import { getLoginInfo } from '${specifier('api/user')}'`
    const main = !traits.loginBeforeInit
      ? `import { createApp } from 'vue'
import App from './App.vue'
createApp(App).mount('#app')
`
      : `import { createApp } from 'vue'
import App from './App.vue'
${login}

async function initVue() {
  const app = createApp(App)
  app.mount('#app')
}
async function bootstrap() {
  try {
    await getLoginInfo({ user: 'reader' })
  } catch (error) {
    // 登录信息缺失不阻断页面初始化
  }
  initVue()
}
bootstrap()
`
    await put(entry, main)
    const context: AdapterContext = { workspaceRoot: root, appRoot,
      profile: await inspectApp(root, appRoot),
      config: { source: { kind: 'detected' }, diagnostics: [], project: { id: 'real-traits-app',
        root: 'app', runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [], entry } } } }
    const target: ResolvedTarget = { projectId: 'real-traits-app', targetId: 'page', scope: 'page',
      selector: { kind: 'file', path: 'src/views/HomeView.vue' } }
    const outcome = await vueViteAdapter.plan(context, target)
    if (outcome.kind !== 'plan') {
      throw new Error('Real-traits fixture plan failed: ' + (outcome.kind === 'missing'
        ? outcome.missing.map(value => value.code).join(',') : outcome.reason))
    }
    const ledger = createFileLedger(join(root, 'control'))
    const events: RunEvent[] = []
    let verifications = 0
    const input: StartContext = { ...context, previewId: 'real-traits-preview', ownerSessionId: 'own-test',
      plan: outcome.plan, signal: new AbortController().signal, deadline: Date.now() + 15000, ledger,
      async verifyExecution() { verifications++ }, emit(event) { events.push(event) },
    }
    const cleanup = async () => {
      if ((await ledger.listByPreview(input.previewId)).length) {
        throw new Error('Real-traits fixture still has resource records: ' + join(root, 'control'))
      }
      await rm(root, { recursive: true, force: true })
    }
    return { root, appRoot, input, events, ledger, put, traits,
      verifications: () => verifications, cleanup }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
