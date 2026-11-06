/** 真 React Vite 执行器（方案 §6.5、§6.8、§9.2、§15.3；R5-7）；自有样本，使用显式已有依赖。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { reactViteAdapter } from '../../src/adapters/react/vite/index.ts'
import { createReactViteFixture, fixtureFiles as files } from '../helpers/react-vite-fixture.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'
import { readProcessStartTime } from '../../src/runner/ledger.ts'
import type { RunningHandle } from '../../src/adapters/types.ts'
import { reactModules as modules, reactIntegrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'

test('real React Vite worker replays the entry provider chain and mounts the leaf target in a real browser',
  { skip: reactIntegrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // R5-7 核心证据：入口 <StrictMode><BrowserRouter><App/></BrowserRouter></StrictMode> 的
  // Provider 链经生成 setup 重放（BrowserRouter→MemoryRouter、StrictMode 保留），
  // 叶组件替换为 Target；Target 内 useLocation/Link 依赖路由上下文，缺链即崩。
  if (!modules) throw new Error('Explicit React toolchain modules are required')
  const f = await createReactViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const before = await files(f.appRoot)
  const handle = await reactViteAdapter.start(f.input)
  running = handle
  const entries = await f.ledger.listByPreview(f.input.previewId)
  const proc = entries.find(value => value.resource.kind === 'process')?.resource
  assert.ok(proc?.kind === 'process')
  assert.equal(Number(await (await import('node:fs/promises')).readFile(f.configMarker, 'utf8')), proc.pid,
    'Project configuration must execute in the owned worker')
  const url = new URL(handle.url)
  assert.deepEqual(await findListeningPids(Number(url.port)), [proc.pid])
  const document = await fetch(handle.url)
  assert.equal(document.status, 200)
  const html = await document.text()
  assert.ok(html.includes('__dsh_preview_root'), 'Owned mount container must be present')
  const entry = await fetch(url.origin + '/@id/__x00__dsh-page-preview:entry')
  assert.equal(entry.status, 200)
  assert.match(await entry.text(), /startReactPreview/)
  const target = await fetch(url.origin + '/src/Target.jsx', { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal(target.status, 200)
  const targetCode = await target.text()
  assert.ok(!targetCode.includes('THIS_VALUE_MUST_NOT_BE_EXPOSED'))
  assert.equal((await fetch(url.origin + '/api/unknown')).status, 404)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    for (let attempt = 0; attempt < 150 && !text.includes('Real adapter target'); attempt++) {
      try { text = String(await chrome.evaluate('document.body.innerText')) } catch { text = '' }
      if (!text.includes('Real adapter target')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('Real adapter target'),
      'the leaf target must mount under the replayed provider chain: ' + chrome.events().join(' ; ').slice(0, 2000))
    // BrowserRouter → MemoryRouter 生效证据：useLocation 可读、Link 已渲染为锚点（无 Router 即抛错）。
    assert.ok(text.includes('about'), 'Link inside the target needs the replayed router context')
    const location = String(await chrome.evaluate(
      'document.querySelector("[data-testid=location]")'
      + ' && document.querySelector("[data-testid=location]").textContent'))
    assert.equal(location, '/', 'MemoryRouter initial entry defaults to /')
  } finally { await chrome.close() }
  assert.deepEqual(await files(f.appRoot), before)
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.equal(await readProcessStartTime(proc.pid), undefined)
  assert.deepEqual(await findListeningPids(Number(url.port)), [])
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('a declared route reaches the generated setup navigate binding through MemoryRouter initialEntries',
  { skip: reactIntegrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // 生成 setup 的 navigate：pending initialEntries → useLocation() 显示目标路由；
  // 机制是入口层重放的内存路由，不执行项目路由表（knownDifferences 如实声明）。
  if (!modules) throw new Error('Explicit React toolchain modules are required')
  const f = await createReactViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const outcome = await reactViteAdapter.plan(f.context, { projectId: 'react-app', targetId: 'actual',
    scope: 'component', selector: { kind: 'file', path: 'src/Target.jsx' } }, undefined,
    { requirements: [], route: { path: '/about', params: {}, query: {} } })
  if (outcome.kind !== 'plan') throw new Error('route plan failed: ' +
    (outcome.kind === 'missing'
      ? outcome.missing.map(value => value.code + ':' + value.message).join(' | ') : ''))
  f.input.plan = outcome.plan
  running = await reactViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let location = ''
    for (let attempt = 0; attempt < 150 && location !== '/about'; attempt++) {
      try {
        location = String(await chrome.evaluate(
          'document.querySelector("[data-testid=location]")'
          + ' && document.querySelector("[data-testid=location]").textContent'))
      } catch { location = '' }
      if (location !== '/about') await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(location, '/about',
      'navigate must push the declared route into the in-memory router context: '
      + chrome.events().join(' ; ').slice(0, 1500))
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('a real browser proves React Fast Refresh applies the new build in place (R5-7 refresh evidence)',
  { skip: reactIntegrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // refresh 升级 supported 的依据与 Vue 同一规则：真实 headless Chrome 中组件修改经
  // Fast Refresh 就地应用——页面变量存活、新标记出现、module-updated 版本推动 freshness 回 current。
  if (!modules) throw new Error('Explicit React toolchain modules are required')
  const f = await createReactViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  running = await reactViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    const bodyText = async () => {
      try { return String(await chrome.evaluate('document.body.innerText')) } catch { return '' }
    }
    let text = ''
    for (let attempt = 0; attempt < 150 && !text.includes('Real adapter target'); attempt++) {
      text = await bodyText()
      if (!text.includes('Real adapter target')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('Real adapter target'),
      'initial mount is required before the HMR probe: ' + chrome.events().join(' ; ').slice(0, 1500))
    await chrome.evaluate('window.__hmrProbe = "survives"')
    const html = await (await fetch(running.url)).text()
    const served = /__DSH_BUILD__="([^"]+)"/.exec(html)?.[1]
    await f.put('src/Target.jsx', `export default function Target() { return <h1>Real adapter target r5-hmr</h1> }`)
    for (let attempt = 0; attempt < 150 && !text.includes('r5-hmr'); attempt++) {
      text = await bodyText()
      if (!text.includes('r5-hmr')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('r5-hmr'),
      'the edited component must appear in the live document: ' + chrome.events().join(' ; ').slice(0, 1500))
    assert.equal(await chrome.evaluate('window.__hmrProbe'), 'survives',
      'the marker must arrive via in-place refresh, not a document reload')
    const servedAfter = /__DSH_BUILD__="([^"]+)"/.exec(await (await fetch(running.url)).text())?.[1]
    assert.ok(servedAfter && servedAfter !== served, 'the new build must carry a different stamp')
    let recovered = false
    for (let attempt = 0; attempt < 200 && !recovered; attempt++) {
      const states = f.events.filter(event => event.type === 'freshness').map(event => event.freshness)
      recovered = states.includes('current') && states.includes('unverified')
        && states.lastIndexOf('current') > states.indexOf('unverified')
      if (!recovered) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(recovered, 'freshness never returned to current after the browser-applied build: '
      + JSON.stringify(f.events.filter(event => event.type === 'freshness')))
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('generated setup from a TS entry resolves `.js` specifiers of `.tsx` providers (relative and aliased)',
  { skip: reactIntegrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // 2026-11-04：TS 入口写 `./x.js`/`@/x.js` 而磁盘为 x.tsx 时，Vite 只在导入方为 TS 模块时替换扩展名；
  // 生成 setup 须按入口语言参与解析，且已解析的绝对路径不得用跳过解析的 /@fs/ 形式。
  if (!modules) throw new Error('Explicit React toolchain modules are required')
  const f = await createReactViteFixture(modules, {
    entryFile: 'src/main.tsx',
    main: `import { createRoot } from 'react-dom/client'
import { Frame } from './shell/frame.js'
import { Brand } from '@/shell/brand.js'
import App from './App.jsx'
createRoot(document.getElementById('root')!).render(<Frame><Brand><App /></Brand></Frame>)`,
  })
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  await f.put('src/shell/frame.tsx', `import type { ReactNode } from 'react'
export function Frame(props: { children: ReactNode }) {
  return <section data-frame="ts-frame">{props.children}</section>
}`)
  await f.put('src/shell/brand.tsx', `import { createContext, type ReactNode } from 'react'
export const BrandContext = createContext('missing-brand')
export function Brand(props: { children: ReactNode }) {
  return <BrandContext.Provider value="ts-brand">{props.children}</BrandContext.Provider>
}`)
  await f.put('src/Target.jsx', `import { useContext } from 'react'
import { BrandContext } from './shell/brand.tsx'
export default function Target() { return <h1>{useContext(BrandContext)}</h1> }`)
  const outcome = await reactViteAdapter.plan(f.context, { projectId: 'react-app', targetId: 'actual',
    scope: 'component', selector: { kind: 'file', path: 'src/Target.jsx' } })
  if (outcome.kind !== 'plan') throw new Error('TS entry plan failed: ' +
    (outcome.kind === 'missing'
      ? outcome.missing.map(value => value.code + ':' + value.message).join(' | ') : ''))
  assert.ok(outcome.plan.generatedSetup, 'the TS entry must produce a generated setup')
  f.input.plan = outcome.plan
  running = await reactViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    for (let attempt = 0; attempt < 150 && !text.includes('ts-brand'); attempt++) {
      try { text = String(await chrome.evaluate('document.body.innerText')) } catch { text = '' }
      if (!text.includes('ts-brand')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('ts-brand'),
      'aliased `.js` provider import must reach brand.tsx: ' + chrome.events().join(' ; ').slice(0, 2000))
    assert.ok(await chrome.evaluate('!!document.querySelector("[data-frame=ts-frame]")'),
      'relative `.js` provider import must reach frame.tsx')
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('entry third-party providers (antd ConfigProvider + MUI ThemeProvider) replay and style the leaf target',
  { skip: reactIntegrationSkip || !chromeAvailable(), timeout: 90000 }, async t => {
  // R5-7g 组件库 profile 的真实链路证据：入口 JSX 的第三方 Provider 链原样重放——
  // antd Button 拿到 ConfigProvider 主题色、MUI Button 渲染 MuiButtonBase 类；
  // 两者任一缺失都会表现为无类/无主题色，断言即失败。
  if (!modules) throw new Error('Explicit React toolchain modules are required')
  const f = await createReactViteFixture(modules, {
    extraModules: ['antd', '@mui/material', '@emotion/react', '@emotion/styled'],
    main: `import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import App from './App.jsx'
const muiTheme = createTheme()
createRoot(document.getElementById('root')).render(
  <ConfigProvider theme={{ token: { colorPrimary: '#00b96b' } }}>
    <ThemeProvider theme={muiTheme}><App /></ThemeProvider>
  </ConfigProvider>)`,
  })
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  await f.put('src/Target.jsx', `import { Button as AntButton } from 'antd'
import MuiButton from '@mui/material/Button'
export default function Target() {
  return <article><AntButton type="primary">antd primary</AntButton>
    <MuiButton variant="contained">mui contained</MuiButton></article>
}`)
  // Target 改动后需重新走 plan（指纹按文件内容生成）。
  const outcome = await reactViteAdapter.plan(f.context, { projectId: 'react-app', targetId: 'actual',
    scope: 'component', selector: { kind: 'file', path: 'src/Target.jsx' } })
  if (outcome.kind !== 'plan') throw new Error('uikit plan failed: ' +
    (outcome.kind === 'missing'
      ? outcome.missing.map(value => value.code + ':' + value.message).join(' | ') : ''))
  f.input.plan = outcome.plan
  running = await reactViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    const ready = (value: string) => value.includes('antd primary') && value.toLowerCase().includes('mui contained')
    for (let attempt = 0; attempt < 200 && !ready(text); attempt++) {
      try { text = String(await chrome.evaluate('document.body.innerText')) } catch { text = '' }
      if (!ready(text)) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(ready(text),
      'both library components must mount: ' + chrome.events().join(' ; ').slice(0, 2000))
    // ConfigProvider 重放证据：antd primary 按钮应吃 #00b96b 主题色（antd5 CSS-in-JS 运行时变量）。
    const antdBg = String(await chrome.evaluate(
      'getComputedStyle(document.querySelector(".ant-btn-primary")).backgroundColor'))
    assert.equal(antdBg, 'rgb(0, 185, 107)',
      'antd primary must take the replayed ConfigProvider colorPrimary, got ' + antdBg)
    assert.ok(await chrome.evaluate('!!document.querySelector(".MuiButtonBase-root")'),
      'MUI Button must render its MuiButtonBase class under the replayed ThemeProvider')
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})
