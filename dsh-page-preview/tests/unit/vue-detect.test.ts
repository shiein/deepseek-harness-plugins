/** Vue 只读识别与配置 AST（方案 §6.5、§6.9、§15.3）；仅临时元数据，不执行配置、入口或安装业务依赖。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectVueApp } from '../../src/adapters/vue/detect.ts'
import { readVueBuildConfig } from '../../src/adapters/vue/readonly-config.ts'
import { findUiKitProfile } from '../../src/adapters/vue/ui-kits/registry.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vue space#-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  const installed = (name: string, version: string, prefix = '') => put(prefix + 'node_modules/' + name + '/package.json', { name, version })
  return { root, put, installed }
}

test('static Vite Node path/URL expressions retain exact paths without importing configuration', async t => {
  const { root, put } = await fixture(t)
  await put('vite.config.ts', `import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve } from 'node:path'
export default defineConfig({ plugins: [unknownPlugin()], root: './client', resolve: { alias: {
 '@': fileURLToPath(new URL('./src', import.meta . url)),
 local: pathResolve(__dirname, 'source'), ambiguous: pathResolve('src')
}}, build: { rollupOptions: { input: { first: 'index.html', second: 'other.html' } } } })`)
  const config = await readVueBuildConfig(root, 'vite')
  assert.equal(config.root, join(root, 'client'))
  assert.deepEqual(config.aliases, [{ find: '@', replacement: join(root, 'src') }, { find: 'local', replacement: join(root, 'source') }])
  // 非字面量替换的字符串别名只记匹配范围（交给项目构建器运行时解析），不再让全部别名变为未知。
  assert.equal(config.aliasesUnknown, false)
  assert.deepEqual(config.opaqueAliases, [{ find: 'ambiguous' }])
  assert.equal(config.entryUnknown, false)
  assert.deepEqual(config.entries, ['index.html', 'other.html'])
})

test('root: process.cwd() resolves to the application root the Runner worker starts in', async t => {
  // overview/web 形态（2026-11-03 实机）：root: process.cwd() 曾让入口整体变为 unknown。
  const { root, put } = await fixture(t)
  await put('vite.config.ts', `import { resolve } from 'path'
export default {
  root: process.cwd(), resolve: { alias: [{ find: /@\\//, replacement: resolve(process.cwd(), 'src') }] },
}`)
  const config = await readVueBuildConfig(root, 'vite')
  assert.equal(config.root, root)
  assert.equal(config.entryUnknown, false)
  // 本地遮蔽的 process 不是 Node 全局，不解释。
  await put('vite.config.ts', `const process = { cwd: () => '/elsewhere' }
export default { root: process.cwd() }`)
  assert.equal((await readVueBuildConfig(root, 'vite')).entryUnknown, true)
})

test('CLI pages and configureWebpack entries remain multiple candidates; chainWebpack is unknown', async t => {
  const { root, put } = await fixture(t)
  await put('vue.config.js', `const path = require('path')
module.exports = { configureWebpack: { resolve: { alias: { '@': path.join(__dirname, 'src') } }, entry: './custom.js' },
 pages: { admin: { entry: 'src/admin.ts', title: 'not-an-entry' }, public: 'src/public.js' } }`)
  const config = await readVueBuildConfig(root, 'vue-cli')
  assert.equal(config.entryUnknown, false)
  assert.deepEqual(config.entries, ['./custom.js', 'src/admin.ts', 'src/public.js'])
  assert.deepEqual(config.aliases, [{ find: '@', replacement: join(root, 'src') }])
  await put('vue.config.js', `module.exports = { chainWebpack(config) { config.entry('app').clear() } }`)
  assert.equal((await readVueBuildConfig(root, 'vue-cli')).entryUnknown, true)
})

test('dynamic, mutated, duplicate, malformed and missing-page-entry configurations do not gain certainty', async t => {
  const { root, put } = await fixture(t)
  for (const source of [
    `export default ({ mode }) => ({ resolve: { alias: aliasesFor(mode) } })`,
    `const config = {}; config.resolve = makeAliases(); export default config`,
    `export default { resolve: { alias: { ...otherAliases } }, build: { rollupOptions: { input: getInput() } } }`,
    `export default { build: { rollupOptions: { input: 'a.js', input: 'b.js' } } }`,
    `export default {`,
  ]) {
    await put('vite.config.ts', source)
    const config = await readVueBuildConfig(root, 'vite')
    assert.equal(config.entryUnknown, true, source)
  }
  await put('vue.config.js', 'module.exports = { pages: { app: { title: "missing entry" } } }')
  assert.equal((await readVueBuildConfig(root, 'vue-cli')).entryUnknown, true)
  assert.equal((await readVueBuildConfig(root)).entryUnknown, true)
})

test('Vue 3 workspace versions and active HTML module entry are metadata, not execution proof', async t => {
  const { root, put, installed } = await fixture(t)
  await put('apps/web/package.json', { dependencies: { vue: '^2.6', vite: '^5', 'element-plus': '^2', pinia: '^2', 'vue-router': '^4' } })
  for (const [name, version] of [['vue', '3.5.13'], ['vite', '5.4.0'], ['@vitejs/plugin-vue', '5.2.0'], ['element-plus', '2.8.0'], ['pinia', '2.2.0'], ['vue-router', '4.4.0']]) await installed(name!, version!)
  await put('apps/web/index.html', `<!-- <script type="module" src="/fake.js"></script> --><link rel="modulepreload" href="/preload.js"><template><script type="module" src="/template.js"></script></template><script type="module" src="/src/start.ts"></script>`)
  await put('apps/web/src/start.ts', 'throw new Error("ENTRY_MUST_NOT_RUN")')
  const info = await detectVueApp(join(root, 'apps/web'), { workspaceRoot: root })
  assert.equal(info?.vue.major, '3')
  assert.deepEqual(info?.buildHost, { kind: 'vite', viteVersion: '5.4.0', vuePlugin: '@vitejs/plugin-vue' })
  assert.equal(info?.entry, join(root, 'apps/web/src/start.ts'))
  assert.equal(info?.typescript, true)
  assert.deepEqual(info?.stores, [{ package: 'pinia', major: 2 }])
  assert.equal(info?.router?.major, 4)
  assert.deepEqual(info?.uiKits, [{ packageName: 'element-plus', version: '2.8.0', profileId: 'element-plus' }])
  assert.deepEqual(info?.unresolved, [])
  // R5-2b/c：element-plus 经 Tier 1 矩阵证据升级 verified: true（element-ui 按决策 S 仍 false）。
  assert.equal(findUiKitProfile('element-plus', '2.8.0', '3')?.verified, true)
})

test('declared ranges, unsupported Vue versions and incompatible profiles stay unknown', async t => {
  const { root, put, installed } = await fixture(t)
  await put('package.json', { dependencies: { vue: '^3', 'element-plus': '^2', 'ant-design-vue': '^4' } })
  let info = await detectVueApp(root)
  assert.deepEqual(info?.vue, { major: 'unknown' })
  assert.ok(info?.uiKits.every(value => value.profileId === undefined))
  await installed('vue', '2.7.16')
  await installed('element-plus', '2.8.0')
  await installed('ant-design-vue', '1.7.8')
  info = await detectVueApp(root)
  assert.equal(info?.vue.major, '2.7')
  assert.deepEqual(info?.uiKits.map(value => value.profileId), [undefined, 'ant-design-vue'])
  await installed('vue', '2.5.22')
  assert.equal((await detectVueApp(root))?.vue.major, 'unknown')
  assert.equal(findUiKitProfile('ant-design-vue', '^4.0.0', '3'), undefined)
  assert.equal(findUiKitProfile('ant-design-vue', '4.0.0-beta.1', '3'), undefined)
  assert.equal(findUiKitProfile('ant-design-vue', '5.0.0', '3'), undefined)
  assert.equal(findUiKitProfile('ant-design-vue', '4.2.6', '2'), undefined)
})

test('Vue CLI conventions never choose between main.js and main.ts; explicit entry binds dynamic config', async t => {
  const { root, put, installed } = await fixture(t)
  await put('package.json', { dependencies: { vue: '^2.6', '@vue/cli-service': '^4' } })
  await installed('vue', '2.6.14')
  await installed('@vue/cli-service', '4.5.19')
  await installed('webpack', '4.47.0')
  await put('src/main.js', 'throw new Error("never execute")')
  let info = await detectVueApp(root)
  assert.equal(info?.entry, join(root, 'src/main.js'))
  assert.deepEqual(info?.buildHost, { kind: 'vue-cli', cliServiceVersion: '4.5.19', webpackMajor: 4 })
  await put('src/main.ts', 'export {}')
  info = await detectVueApp(root)
  assert.equal(info?.entry, undefined)
  assert.equal(info?.entryCandidates.length, 2)
  await put('vue.config.js', 'throw new Error("CONFIG_MUST_NOT_RUN"); module.exports = getConfig()')
  assert.equal((await detectVueApp(root))?.entry, undefined)
  assert.equal((await detectVueApp(root, { entry: 'src/main.js' }))?.entry, join(root, 'src/main.js'))
})

test('multiple hosts require explicit choice and framework exclusion stays visible', async t => {
  const { root, put, installed } = await fixture(t)
  await put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vue/cli-service': '^5', nuxt: '^3' } })
  await installed('vue', '3.5.13')
  await put('index.html', '<script type="module" src="/main.js"></script>')
  await put('main.js', 'export {}')
  const info = await detectVueApp(root)
  assert.equal(info?.buildHost.kind, 'unknown')
  assert.equal(info?.entry, undefined)
  assert.deepEqual(info?.isolationExcluded, ['nuxt'])
  assert.equal((await detectVueApp(root, { buildHost: 'vite' }))?.entry, join(root, 'main.js'))
})

test('multi-page Vite inputs, invalid HTML bases and inline initialization do not guess a single entry', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { dependencies: { vue: '^3', vite: '^5' } })
  await put('vite.config.js', `export default { root: './web', build: { rollupOptions: { input: ['first.html', 'second.html'] } } }`)
  await put('web/first.html', '<script type="module" src="/src/first.ts"></script>')
  await put('web/second.html', '<script type="module" src="/src/second.ts"></script>')
  await put('web/src/first.ts', 'export {}')
  await put('web/src/second.ts', 'export {}')
  assert.equal((await detectVueApp(root))?.entryCandidates.length, 2)
  assert.equal((await detectVueApp(root))?.entry, undefined)
  await put('vite.config.js', `export default { root: './web' }`)
  for (const html of [
    '<base href="https://external.invalid/"><script type="module" src="/src/first.ts"></script>',
    '<script type="module">window.init = true</script><script type="module" src="/src/first.ts"></script>',
    '<script type="module" src="/index.html"></script>',
  ]) {
    await put('web/index.html', html)
    assert.equal((await detectVueApp(root))?.entry, undefined)
  }
  // 内联经典脚本（polyfill 等）不阻断入口判定：预览文档原样带上它们（2026-11-03，§0.3 第 10 条）。
  await put('web/index.html', '<script>window.init = true</script><script type="module" src="/src/first.ts"></script>')
  assert.equal((await detectVueApp(root))?.entry, join(root, 'web/src/first.ts'))
})

test('metadata corruption, outside roots and environment-file symlinks are rejected visibly', async t => {
  const { root, put } = await fixture(t)
  assert.equal(await detectVueApp(root), undefined)
  await put('package.json', { dependencies: { vue: '^3', vite: '^5' } })
  await put('.env.private', 'DO_NOT_READ_SECRET')
  await symlink(join(root, '.env.private'), join(root, 'vite.config.js'))
  await assert.rejects(readVueBuildConfig(root), /project metadata/)
  await rm(join(root, 'vite.config.js'))
  await put('node_modules/vue/package.json', '{broken')
  await assert.rejects(detectVueApp(root), /project metadata/)
  await assert.rejects(detectVueApp(root, { workspaceRoot: join(root, 'node_modules') }), /inside the declared workspace/)
})

test('vite-plugin-mock options are read statically; unresolved shapes stay unexecuted (R5-1e)', async t => {
  const { root, put } = await fixture(t)
  await put('vite.config.mjs', `import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [viteMockServe({ mockPath: 'mock/server', localEnabled: true })] }`)
  let config = await readVueBuildConfig(root, 'vite')
  assert.deepEqual(config.mockPlugin, { mockPath: 'mock/server' })
  // 无参调用 → 默认 mockPath；import 别名绑定同样识别。
  await put('vite.config.mjs', `import mock from 'vite-plugin-mock'
export default { plugins: [mock()] }`)
  config = await readVueBuildConfig(root, 'vite')
  assert.deepEqual(config.mockPlugin, { mockPath: 'mock' })
  // 非字面量选项、未知选项、显式关闭、多个调用都如实 unresolved——不猜默认值执行。
  for (const options of [
    `{ mockPath: process.env.MOCK_DIR }`, `{ mockPath: 'mock', ignore: 'index.ts' }`,
    `{ localEnabled: false }`, `{ enable: false }`, `{ watchFiles: dynamic() }`,
  ]) {
    await put('vite.config.mjs', `import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [viteMockServe(${options})] }`)
    assert.equal((await readVueBuildConfig(root, 'vite')).mockPlugin, 'unresolved', options)
  }
  await put('vite.config.mjs', `import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [viteMockServe(), viteMockServe({ mockPath: 'x' })] }`)
  assert.equal((await readVueBuildConfig(root, 'vite')).mockPlugin, 'unresolved')
  // 不是 vite-plugin-mock 的调用、非数组插件、缺失插件都不产生 mockPlugin。
  await put('vite.config.mjs', `import other from 'other-plugin'
export default { plugins: [other({ mockPath: 'nope' })] }`)
  assert.equal((await readVueBuildConfig(root, 'vite')).mockPlugin, undefined)
})
