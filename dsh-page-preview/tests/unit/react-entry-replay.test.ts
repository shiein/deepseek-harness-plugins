/** React 入口重放（方案 §6.3、§6.9、§0.3 第 10 条；R5-7）；生成代码只在临时受控子进程执行，不加载真实项目。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEntryRegistrations } from '../../src/adapters/react/entry-replay.ts'
import { buildGeneratedSetup, generateSetupDraft } from '../../src/adapters/react/generated-setup.ts'
import { viteResolvableImport } from '../../src/adapters/vite/paths.ts'
const execute = promisify(execFile)

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-react-entry-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  await put('package.json', { type: 'module',
    dependencies: { react: '^18', 'react-dom': '^18', 'react-router-dom': '^6',
      'test-ui': '^1', 'undeclared-ok': '^1' } })
  return { root, put }
}

test('provider chain keeps entry order; router tags become MemoryRouter; the leaf is never imported', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.jsx', `import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, ThemeProvider, createTheme } from 'test-ui'
import LocalWrapper from './LocalWrapper.js'
import App from './App.jsx'
const muiTheme = createTheme()
const color = '#00b96b'
createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><ConfigProvider theme={{ token: { colorPrimary: color } }}>
    <ThemeProvider theme={muiTheme}><LocalWrapper><App /></LocalWrapper></ThemeProvider>
  </ConfigProvider></BrowserRouter></React.StrictMode>)`)
  const result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.equal(result.invalid, false)
  assert.equal(result.draft.leaf, 'App')
  assert.equal(result.draft.routerAvailable, true)
  assert.deepEqual(result.draft.layers.map(layer => [layer.kind, 'name' in layer ? layer.name : '']),
    [['strict', ''], ['router', 'BrowserRouter'], ['provider', 'ConfigProvider'],
      ['provider', 'ThemeProvider'], ['provider', 'LocalWrapper']])
  assert.deepEqual(result.draft.layers.filter(layer => layer.kind === 'provider')
    .map(layer => layer.origin), ['third-party', 'third-party', 'business'])
  assert.deepEqual(result.draft.declarations.map(value => value.name), ['color', 'muiTheme'])
  const draft = generateSetupDraft(result)
  assert.match(draft, /import \{ MemoryRouter as __MemoryRouter \} from 'react-router-dom'/)
  assert.match(draft, /import \{ ConfigProvider, ThemeProvider, createTheme \} from "test-ui"/)
  assert.match(draft, /import LocalWrapper from ".*src\/LocalWrapper\.js"/)
  assert.match(draft, /const muiTheme = createTheme\(\)/)
  assert.match(draft, /const color = '#00b96b'/)
  // 生成体由内向外赋值：LocalWrapper 最先出现，StrictMode 在最外最后出现；
  // BrowserRouter 换成 MemoryRouter，叶子由 wrap 的入参占位。
  const order = ['__e(LocalWrapper', '__e(ThemeProvider', '__e(ConfigProvider',
    '__e(__MemoryRouter', '__e(__StrictMode']
  for (let index = 1; index < order.length; index++)
    assert.ok(draft.indexOf(order[index - 1]!) < draft.indexOf(order[index]!),
      order[index] + ' must wrap ' + order[index - 1])
  assert.doesNotMatch(draft, /BrowserRouter|App\.jsx|import React/)
})

test('Windows-resolved imports stay absolute in the generated setup (C:\\ is absolute there)', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import LocalWrapper from './LocalWrapper.js'
import './styles/base.css'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<LocalWrapper><App /></LocalWrapper>)`)
  await put('src/LocalWrapper.js', 'export default function LocalWrapper(props) { return props.children }')
  await put('src/styles/base.css', 'body { margin: 0 }')
  await put('src/App.jsx', 'export default function App() { return null }')
  const result = await parseEntryRegistrations(root, 'src/main.jsx')
  // Re-home the resolved paths as Windows would report them (drive letter, backslashes).
  const windows = (file: string) => 'C:\\proj' + file.slice(root.length).replace(/\//g, '\\')
  const imports = result.draft.imports.map(item => item.resolvedSource.startsWith(root)
    ? { ...item, resolvedSource: windows(item.resolvedSource) } : item)
  const replay = { ...result, draft: { ...result.draft, imports } }
  const draft = generateSetupDraft(replay, { importPath: viteResolvableImport, platform: 'win32' })
  assert.match(draft, /import LocalWrapper from "C:\/proj\/src\/LocalWrapper\.js"/)
  assert.match(draft, /import "C:\/proj\/src\/styles\/base\.css"/)
  assert.doesNotMatch(draft, /from "\.\/LocalWrapper\.js"|import "\.\/styles/)
})

test('RouterProvider marks the data-router style; HashRouter also maps to the in-memory context', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router.js'
createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)`)
  let result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.equal(result.draft.dataRouter, true)
  const dataLayer = result.draft.layers.find(layer => layer.kind === 'router')
  assert.equal(dataLayer?.kind === 'router' ? dataLayer.style : '', 'data')
  // RouterProvider 无子元素：叶子本身是路由组件——转为路由层，预览目标获得 MemoryRouter 上下文。
  assert.equal(result.draft.leaf, 'RouterProvider')
  const built = await buildGeneratedSetup(root, 'src/main.jsx', '18')
  assert.ok(!('reason' in built), 'RouterProvider leaf still yields a router-context setup')
  if (!('reason' in built)) {
    assert.match(built.source, /__e\(__MemoryRouter, \{ initialEntries: __pending \}, el\)/)
    assert.doesNotMatch(built.source, /import .*RouterProvider/)
  }
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<HashRouter><App /></HashRouter>)`)
  result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.equal(result.draft.dataRouter, false)
  const hashLayer = result.draft.layers.find(layer => layer.kind === 'router')
  assert.equal(hashLayer?.kind === 'router' ? hashLayer.style : '', 'declarative')
  assert.match(generateSetupDraft(result), /__e\(__MemoryRouter, \{ initialEntries: __pending \}, el\)/)
})

test('style and side-effect imports replay in entry order; unresolved specifiers are diagnosed', async t => {
  const { root, put } = await fixture(t)
  await put('src/styles/base.css', 'body { margin: 0 }')
  await put('src/polyfill.js', 'globalThis.polyfilled = true')
  await put('src/main.jsx', `import 'test-ui/theme.css'
import './polyfill.js'
import './styles/base.css'
import './missing.css'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)`)
  const result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.deepEqual(result.registrations.map(value => [value.kind, value.origin]), [
    ['style-import', 'third-party'], ['side-effect-import', 'business'],
    ['style-import', 'business'], ['style-import', 'unresolved'],
    ['provider', 'unresolved'],
  ])
  assert.ok(result.diagnostics.some(value => /style-import at line 4/.test(value)))
  const draft = generateSetupDraft(result)
  assert.ok(draft.indexOf('test-ui/theme.css') < draft.indexOf('polyfill'))
  assert.ok(draft.indexOf('polyfill') < draft.indexOf('styles/base.css'))
  // 诊断过的缺失导入不写入草稿——否则生成模块运行时直接 import 失败。
  assert.doesNotMatch(draft, /missing\.css/)
  // 叶 <App/> 无绑定来源时按 business 登记（第 5 条 registration 来自叶子）。
})

test('conditional, sibling and unresolved-provider renders are refused rather than silently replayed',
  async t => {
    const { root, put } = await fixture(t)
    await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import App from './App.jsx'
if (condition) createRoot(document.getElementById('root')).render(<App />)`)
    let result = await parseEntryRegistrations(root, 'src/main.jsx')
    assert.ok(result.diagnostics.some(value => /Conditional or wrapped React render/.test(value)))
    assert.equal(result.draft.leaf, undefined)
    const noTree = await buildGeneratedSetup(root, 'src/main.jsx', '18')
    assert.ok('reason' in noTree && noTree.reason === 'The entry has no replayable React render tree')
    await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<><App /><App /></>)`)
    result = await parseEntryRegistrations(root, 'src/main.jsx')
    assert.ok(result.diagnostics.some(value => /not a JSX element|sibling\/expression/.test(value)))
    await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import Other from './Other.jsx'
createRoot(document.getElementById('root')).render(<main><App /><Other /></main>)`)
    result = await parseEntryRegistrations(root, 'src/main.jsx')
    assert.ok(result.diagnostics.some(value => /sibling\/expression/.test(value)))
    await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import { XProvider } from 'not-installed'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<XProvider><App /></XProvider>)`)
    result = await parseEntryRegistrations(root, 'src/main.jsx')
    assert.ok(result.diagnostics.some(value => /Provider XProvider/.test(value)))
    const unresolvable = await buildGeneratedSetup(root, 'src/main.jsx', '18')
    assert.ok('reason' in unresolvable
      && unresolvable.reason === 'The entry provider chain cannot be fully resolved')
  })

test('spread, dynamic and mutated props make the provider unresolved instead of replaying a stale value',
  async t => {
    const { root, put } = await fixture(t)
    const entries = [
      '<Provider {...options}><App /></Provider>',
      '<Provider theme={compute()}><App /></Provider>',
      '<Provider theme={options}><App /></Provider>',
    ]
    const prologs = [
      'import { Provider } from \'test-ui\'\nconst options = {}',
      'import { Provider } from \'test-ui\'\nfunction compute() { return {} }',
      'import { Provider } from \'test-ui\'\nconst options = { theme: \'a\' }\noptions.theme = \'b\'',
    ]
    for (let index = 0; index < entries.length; index++) {
      await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
${prologs[index]}
import App from './App.jsx'
createRoot(document.getElementById('root')).render(${entries[index]})`)
      const result = await parseEntryRegistrations(root, 'src/main.jsx')
      const provider = result.draft.layers.find(layer => layer.kind === 'provider')
      assert.equal(provider?.kind === 'provider' ? provider.origin : '', 'unresolved', entries[index])
      assert.ok(result.diagnostics.some(value => /Provider Provider/.test(value)), entries[index])
      const built = await buildGeneratedSetup(root, 'src/main.jsx', '18')
      assert.ok('reason' in built && /provider chain/.test(built.reason), entries[index])
    }
  })

test('several roots are diagnosed; invalid syntax, missing and escaping entries fail explicitly', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('a')).render(<App />)
createRoot(document.getElementById('b')).render(<App />)`)
  let result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.ok(result.diagnostics.some(value => /Several React roots/.test(value)))
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'; createRoot(`)
  result = await parseEntryRegistrations(root, 'src/main.jsx')
  assert.equal(result.invalid, true)
  const invalidBuild = await buildGeneratedSetup(root, 'src/main.jsx', '18')
  assert.ok('reason' in invalidBuild && invalidBuild.reason === 'Entry syntax is invalid')
  await assert.rejects(parseEntryRegistrations(root, 'missing.jsx'), /entry is missing/i)
  await assert.rejects(parseEntryRegistrations(root, '../outside.jsx'), /outside application/)
  await put('src/main.jsx', `import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)`)
  const unknownMajor = await buildGeneratedSetup(root, 'src/main.jsx', 'unknown')
  assert.ok('reason' in unknownMajor
    && unknownMajor.reason === 'Installed React major version is unknown')
})

test('generated setup executes in a controlled child with exact provider order, props and navigate',
  async t => {
    const { root, put } = await fixture(t)
    await put('node_modules/react/package.json', { name: 'react', type: 'module',
      exports: { '.': './index.js' } })
    await put('node_modules/react/index.js', `export function createElement(type, props, child) {
  globalThis.events.push({ type: typeof type === 'string' ? type : type.name, props: props })
  return { type: type, props: props, child: child }
}
export const StrictMode = 'StrictModeTag'
export default {}`)
    await put('node_modules/react-router-dom/package.json', { name: 'react-router-dom', type: 'module',
      exports: { '.': './index.js' } })
    await put('node_modules/react-router-dom/index.js',
      `export function MemoryRouter() {}`)
    await put('node_modules/test-ui/package.json', { name: 'test-ui', type: 'module',
      exports: { '.': './index.js', './setup.js': './setup.js' } })
    await put('node_modules/test-ui/index.js', `export function ConfigProvider() {}
export function ThemeProvider() {}
export function createTheme() { return { mui: true } }`)
    await put('node_modules/test-ui/setup.js', `globalThis.events.push({ type: 'side-effect' })`)
    await put('src/LocalWrapper.js', `export default function LocalWrapper() {}`)
    await put('src/App.jsx', `export default function App() {}`)
    await put('src/main.jsx', `import 'test-ui/setup.js'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, ThemeProvider, createTheme } from 'test-ui'
import LocalWrapper from './LocalWrapper.js'
import App from './App.jsx'
const muiTheme = createTheme()
createRoot(document.getElementById('root')).render(
  <BrowserRouter><ConfigProvider theme={{ token: { colorPrimary: '#00b96b' } }}>
    <ThemeProvider theme={muiTheme}><LocalWrapper><App /></LocalWrapper></ThemeProvider>
  </ConfigProvider></BrowserRouter>)`)
    const replay = await parseEntryRegistrations(root, 'src/main.jsx')
    const draft = generateSetupDraft(replay)
    await put('preview.setup.mjs', draft)
    await put('run.mjs', `import assert from 'node:assert/strict'
globalThis.events = []
const setup = (await import('./preview.setup.mjs')).default
assert.equal(globalThis.events.length, 1, 'the side-effect import runs at module evaluation')
const context = await setup.createContext()
const leaf = { leaf: true }
const wrapped = context.wrap(leaf)
assert.equal(wrapped.type.name, 'MemoryRouter', 'the router layer is outermost as in the entry')
assert.ok(wrapped.props.initialEntries === context.__pending)
const cfg = wrapped.child
assert.equal(cfg.type.name, 'ConfigProvider')
assert.deepEqual(cfg.props, { theme: { token: { colorPrimary: '#00b96b' } } })
const theme = cfg.child
assert.equal(theme.type.name, 'ThemeProvider')
assert.deepEqual(theme.props, { theme: { mui: true } })
assert.equal(theme.child.type.name, 'LocalWrapper')
assert.equal(theme.child.child, leaf)
const resolved = await setup.navigate({ route: { path: '/about' }, href: '/about', context: context })
assert.equal(resolved, '/about')
assert.deepEqual(context.__pending, ['/about'])
console.log('react generated setup passed')`)
    await execute(process.execPath, ['--check', join(root, 'preview.setup.mjs')])
    const child = await execute(process.execPath, [join(root, 'run.mjs')], { cwd: root, env: {} })
    assert.match(child.stdout, /react generated setup passed/)
    assert.equal(child.stderr, '')
    assert.doesNotMatch(draft, /App\.jsx/)
  })
