/** 真 Vite 执行器（方案 §6.5、§6.8、§9.2、§15.3）；自有样本，使用显式已有依赖，不执行来源项目配置。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { createVueViteFixture, fixtureFiles as files } from '../helpers/vue-vite-fixture.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'
import { readProcessStartTime } from '../../src/runner/ledger.ts'
import { parseScriptSource } from '../../src/shared/javascript.ts'
import type { RunningHandle, RunEvent } from '../../src/adapters/types.ts'
import type { Diagnostic } from '../../src/shared/contracts.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'

test('real Vite worker preserves source/config paths, owns an authenticated listener and cleans its process/port/temp paths', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const before = await files(f.appRoot)
  const handle = await vueViteAdapter.start(f.input)
  running = handle
  assert.equal(f.verifications(), 3)
  const entries = await f.ledger.listByPreview(f.input.previewId)
  const proc = entries.find(value => value.resource.kind === 'process')?.resource
  assert.ok(proc?.kind === 'process')
  assert.notEqual(proc.pid, process.pid)
  assert.equal(Number(await readFile(f.configMarker, 'utf8')), proc.pid, 'Project configuration must execute in the owned worker')
  const url = new URL(handle.url)
  assert.deepEqual(await findListeningPids(Number(url.port)), [proc.pid])
  const document = await fetch(handle.url)
  assert.equal(document.status, 200)
  const html = await document.text()
  assert.ok(html.includes('__dsh_preview_root'), 'Owned mount container must be present')
  assert.ok(html.includes('dsh-page-preview:entry'), 'Owned module entry must be present')
  assert.match(document.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
  const entry = await fetch(url.origin + '/@id/__x00__dsh-page-preview:entry')
  assert.equal(entry.status, 200)
  assert.match(await entry.text(), /startVuePreview/)
  const target = await fetch(url.origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal(target.status, 200)
  const targetCode = await target.text()
  assert.match(targetCode, /defineComponent/)
  assert.ok(!targetCode.includes('THIS_VALUE_MUST_NOT_BE_EXPOSED'))
  const imports = parseScriptSource('compiled.js', targetCode).references.filter(value => value.kind === 'module' && value.value.startsWith('/'))
  for (const path of new Set(imports.map(value => value.value))) assert.equal((await fetch(url.origin + path, { headers: { 'sec-fetch-dest': 'script' } })).status, 200, 'Published dependency must be reachable: ' + path)
  assert.equal((await fetch(url.origin + '/api/unknown')).status, 404)
  assert.deepEqual(await fetch(url.origin + '/api/unknown').then(response => response.json()), { code: 'unmatched_request' })
  assert.equal((await fetch(url.origin + '/__dsh_preview/health')).status, 403)
  assert.ok(f.events.some(value => value.type === 'evidence' && value.layer === 'serviceReachable' && value.evidence.status === 'proven'))
  assert.ok(!JSON.stringify(f.events).includes('DO_NOT_EXPOSE_FIXTURE_OUTPUT'))
  assert.deepEqual(await files(f.appRoot), before)
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.equal(await readProcessStartTime(proc.pid), undefined)
  assert.deepEqual(await findListeningPids(Number(url.port)), [])
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('mock-only proceeds through owned channel controls while an absent execution verifier still allocates nothing', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  f.input.plan.requirements = ['mock-only']
  running = await vueViteAdapter.start(f.input)
  assert.equal((await fetch(running.url)).status, 200)
  assert.equal((await fetch(new URL('/api/unknown', running.url))).status, 404)
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
  f.input.plan.requirements = []
  delete f.input.verifyExecution
  await assert.rejects(vueViteAdapter.start(f.input), /execution verifier/)
  assert.equal(f.verifications(), 3)
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('default mock-only plans mount the target in a real browser (owned response layer is the mock)',
  { skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // 2026-11-03 实机：mock-only 默认值下入口要求从未被设置的 bridge.mockReady，页面空白；
  // 既有样本都写死 requirements: []，真实浏览器从未覆盖默认路径。
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  f.input.plan.requirements = ['mock-only']
  running = await vueViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    let text = ''
    for (let attempt = 0; attempt < 100 && !text.includes('Real adapter target'); attempt++) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (!text.includes('Real adapter target')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('Real adapter target'),
      'mock-only must still mount: ' + text.slice(0, 200) + ' | ' + chrome.events().join(' ; ').slice(0, 2000))
  } finally { await chrome.close() }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('a real browser proves refresh applies the new build in place (R5-3 refresh evidence)',
  { skip: integrationSkip || !chromeAvailable(), timeout: 60000 }, async t => {
  // refresh 升级 supported 的依据：真实 headless Chrome 中 SFC 修改经 HMR 就地应用——
  // 页面变量存活（非整页重载）、新标记出现、bootstrap 上报的 module-updated 版本推动
  // freshness 回到 current。载体 IAB 另行验收，不外推。
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  running = await vueViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    // 导航后执行上下文可能瞬时重建（Linux 容器内尤甚）；读不到时下一轮再读。
    const bodyText = async () => {
      try { return String(await chrome.evaluate('document.body.innerText')) } catch { return '' }
    }
    let text = ''
    for (let attempt = 0; attempt < 100 && !text.includes('Real adapter target'); attempt++) {
      text = await bodyText()
      if (!text.includes('Real adapter target')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('Real adapter target'),
      'initial mount is required before the HMR probe: ' + chrome.events().join(' ; ').slice(0, 1500))
    // 就地更新的判据：整页重载会清掉 window.__hmrProbe。
    await chrome.evaluate('window.__hmrProbe = "survives"')
    const html = await (await fetch(running.url)).text()
    const served = /__DSH_BUILD__="([^"]+)"/.exec(html)?.[1]
    await f.put('src/Target.vue', '<template><h1>Real adapter target r5-hmr</h1></template>')
    for (let attempt = 0; attempt < 150 && !text.includes('r5-hmr'); attempt++) {
      text = await bodyText()
      if (!text.includes('r5-hmr')) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(text.includes('r5-hmr'),
      'the edited SFC must appear in the live document: ' + chrome.events().join(' ; ').slice(0, 1500))
    assert.equal(await chrome.evaluate('window.__hmrProbe'), 'survives',
      'the marker must arrive via in-place HMR, not a document reload')
    const servedAfter = /__DSH_BUILD__="([^"]+)"/.exec(await (await fetch(running.url)).text())?.[1]
    assert.ok(servedAfter && servedAfter !== served, 'the new build must carry a different stamp')
    // 浏览器自证：bootstrap 回传 module-updated 后 freshness 由 unverified 回到 current。
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

test('dependency pre-bundles persist in the plugin build cache and are reused by the next preview',
  { skip: integrationSkip || !chromeAvailable(), timeout: 90000 }, async t => {
  // 2026-11-03：此前缓存在每预览临时目录、用完即删，大项目每次冷预构建；改为插件数据目录下的持久缓存。
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  f.input.buildCacheRoot = join(f.root, 'plugin-build-cache')
  const metadata = join(f.input.buildCacheRoot, 'vite', 'deps', '_metadata.json')
  const mountText = async (url: string) => {
    const chrome = await launchChrome(t)
    try {
      await chrome.navigate(url)
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = String(await chrome.evaluate('document.body.innerText'))
        if (text.includes('Real adapter target')) return text
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return 'not mounted: ' + chrome.events().join(' ; ').slice(0, 1500)
    } finally { await chrome.close() }
  }
  running = await vueViteAdapter.start(f.input)
  assert.match(await mountText(running.url), /Real adapter target/, 'deps served from the cache root are allowed')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
  await access(metadata)
  const before = await readFile(metadata, 'utf8')
  f.input.previewId = 'vue-vite-owned-fixture-second'
  running = await vueViteAdapter.start(f.input)
  assert.match(await mountText(running.url), /Real adapter target/)
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).hash, JSON.parse(before).hash,
    'the second preview reuses the same optimized dependency set')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('execution verification revoked after worker boot rolls back before project loading', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  t.after(f.cleanup)
  let count = 0
  f.input.verifyExecution = async () => { if (++count === 2) throw new Error('EXECUTION_CHANGED') }
  await assert.rejects(vueViteAdapter.start(f.input), /EXECUTION_CHANGED/)
  assert.equal(count, 2)
  await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
  assert.ok(!f.events.some(value => value.type === 'evidence' && value.layer === 'serviceReachable'))
})

test('source changes during worker boot invalidate the saved plan before loading project configuration', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  t.after(f.cleanup)
  let count = 0
  f.input.verifyExecution = async () => { if (++count === 2) await f.put('src/Target.vue', '<template>changed target</template>') }
  await assert.rejects(vueViteAdapter.start(f.input), /source\/config\/toolchain bindings changed/)
  await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('a source syntax error forwards compile message/file/line/frame, marks stale and never leaks env values', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  await f.put('.env', 'EXTRA_SECRET=env-file-secret-66\n')
  running = await vueViteAdapter.start(f.input)
  const url = new URL(running.url)
  assert.equal((await fetch(url.origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script' } })).status, 200)
  // 故意写入语法错误；请求路径的转换失败经 worker logger 转出 compile-error 详情。
  await f.put('src/Target.vue', '<template><div>{{ unclosed </template>\n<script setup>const s = "env-file-secret-66"</script>')
  // 文件失效是异步的：轮询请求直到模块图丢弃旧转换、新转换失败。
  let diagnostic: Diagnostic | undefined
  for (let i = 0; i < 200; i++) {
    const status = (await fetch(url.origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script' } })).status
    if (status === 500) {
      diagnostic = f.events.find((value): value is Extract<RunEvent, { type: 'diagnostic' }> =>
        value.type === 'diagnostic' && value.diagnostic.code === 'compile_error')?.diagnostic
      if (diagnostic) break
    }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.ok(diagnostic, 'compile_error diagnostic must be forwarded')
  assert.equal(diagnostic.location?.file, 'src/Target.vue')
  assert.ok(typeof diagnostic.location?.line === 'number' && diagnostic.location.line > 0)
  assert.ok(diagnostic.message.includes('src/Target.vue'))
  assert.ok(diagnostic.message.length > 20, 'forwarded compile message must carry the actual error text')
  assert.ok(diagnostic.message.includes('unclosed'), 'forwarded message must carry the bounded code frame')
  assert.ok(!JSON.stringify(diagnostic).includes('env-file-secret-66'))
  assert.ok(f.events.some(value => value.type === 'freshness' && value.freshness === 'stale'))
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('freshness reaches current only when the browser proves the latest build is applied', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  running = await vueViteAdapter.start(f.input)
  const url = new URL(running.url)
  const current = () => f.events.filter(event => event.type === 'freshness' && event.freshness === 'current').length
  const stamp = async () => {
    const html = await (await fetch(running!.url)).text()
    return { build: /__DSH_BUILD__="([^"]+)"/.exec(html)?.[1], nonce: /"nonce":"([a-f0-9]+)"/.exec(html)?.[1] }
  }
  const post = (report: unknown, nonce: string) => fetch(url.origin + '/__dsh_preview/report', { method: 'POST', body: JSON.stringify({ nonce, previewId: f.input.previewId, report }) })
  const wait = async (freshness: 'current' | 'stale' | 'unverified', count = 1) => {
    for (let i = 0; i < 200; i++) {
      if (f.events.filter(event => event.type === 'freshness' && event.freshness === freshness).length >= count) return
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Freshness not observed: ' + freshness)
  }
  // 初始文档印章 '0'：带匹配印章的 document-loaded 证明已加载 → current。
  const first = await stamp()
  assert.equal(first.build, '0')
  assert.ok(first.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: '0' }, first.nonce)).status, 204)
  await wait('current')
  assert.equal(current(), 1)
  // SFC 修改 → 新编译 → unverified；伪造版本不能推进，真实应用版本（module-updated）才能 → current。
  await f.put('src/Target.vue', '<template><h1>vite-freshness-v2</h1></template>')
  await wait('unverified')
  const second = await stamp()
  assert.ok(second.build && second.build !== '0', 'recompiled document must carry the new build stamp')
  assert.ok(second.nonce)
  assert.equal((await post({ kind: 'module-updated', version: 'forged-version' }, second.nonce)).status, 204)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(current(), 1, 'a forged version must not advance freshness')
  assert.equal((await post({ kind: 'module-updated', version: second.build }, second.nonce)).status, 204)
  await wait('current', 2)
  assert.equal(current(), 2)
  // 编译错误 → stale；旧印章/伪造应用都不能恢复 current。
  await f.put('src/Target.vue', '<template><div>{{ broken </template>')
  for (let i = 0; i < 200; i++) {
    if ((await fetch(url.origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script' } })).status === 500) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  await wait('stale')
  const stale = await stamp()
  assert.ok(stale.nonce)
  // 旧印章证明用已知成功构建 second.build（时间戳唯一，expectBuild 永不会重新 arm 到它）；
  // 不用文档当前印章——失败窗口内 Vite 可重试 handleHotUpdate 并把 servedBuild 推到新的失败时间戳。
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: second.build }, stale.nonce)).status,
    204)
  assert.equal((await post({ kind: 'module-updated', version: second.build! }, stale.nonce)).status, 204)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(current(), 2, 'no applied claim may fire while the last compile failed')
  // 修复 → 新编译 → document-loaded 新印章 → current 恢复（等第 3 次 unverified，确保新编译已发生）。
  await f.put('src/Target.vue', '<template><h1>vite-freshness-v3</h1></template>')
  await wait('unverified', 3)
  const fixed = await stamp()
  assert.ok(fixed.build && fixed.build !== stale.build, 'a fixed compile must carry a newer stamp')
  assert.ok(fixed.nonce)
  assert.equal((await post({ kind: 'document-loaded', url: running.url, build: fixed.build }, fixed.nonce)).status, 204)
  await wait('current', 3)
  assert.equal(current(), 3)
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('project config failure forwards the error with env values redacted and reclaims allocated resources', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  t.after(f.cleanup)
  // §13 第 8 条：错误 message/stack 必须转发；其中的 env 文件值必须去除。
  await f.put('.env', 'CONFIG_SECRET=env-file-secret-55\n')
  await f.put('vite.config.mjs', `export default { plugins: [(function () { throw new Error('config broke at env-file-secret-55') })()] }`)
  const outcome = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector })
  assert.equal(outcome.kind, 'plan')
  if (outcome.kind !== 'plan') throw new Error('Expected candidate')
  f.input.plan = outcome.plan
  let failure: unknown
  try { await vueViteAdapter.start(f.input) } catch (error) { failure = error }
  assert.ok(failure instanceof Error && failure.message.includes('config broke at [redacted]'), 'forwarded message is expected; got: ' + (failure instanceof Error ? failure.message : String(failure)))
  assert.ok(!failure.message.includes('env-file-secret-55'))
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
  assert.ok(!JSON.stringify(f.events).includes('env-file-secret-55'))
})

test('no-config projects use the matching installed Vue compiler plugin without changing source files', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const { rm } = await import('node:fs/promises')
  await rm(join(f.appRoot, 'vite.config.mjs'))
  await f.put('src/Target.vue', '<template><h1>Actual no-config SFC</h1></template>')
  const outcome = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector })
  assert.equal(outcome.kind, 'plan')
  if (outcome.kind !== 'plan') throw new Error('Expected candidate')
  f.input.plan = outcome.plan
  const before = await files(f.appRoot)
  const handle = await vueViteAdapter.start(f.input)
  running = handle
  const response = await fetch(new URL('/src/Target.vue', handle.url), { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Actual no-config SFC/)
  assert.deepEqual(await files(f.appRoot), before)
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})

test('cancellation after worker allocation reclaims the pending project startup', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  t.after(f.cleanup)
  const abort = new AbortController()
  f.input.signal = abort.signal
  let count = 0
  f.input.verifyExecution = async () => { if (++count === 2) abort.abort(new Error('OWN_START_CANCELLED')) }
  await assert.rejects(vueViteAdapter.start(f.input), /OWN_START_CANCELLED/)
  assert.equal(count, 2)
  await assert.rejects(access(f.configMarker), { code: 'ENOENT' })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
  assert.ok(!f.events.some(value => value.type === 'evidence' && value.layer === 'serviceReachable'))
})

test('cancellation at the Root handler verification boundary prevents import and reclaims the waiting worker', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  t.after(f.cleanup)
  const marker = join(f.root, 'handler-import')
  await f.put('handlers.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'SHOULD_NOT_IMPORT'); export default []`)
  f.input.config.project.scenarios = { own: { businessPaths: ['/api/**'], handlers: 'handlers.mjs' } }
  const planned = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector }, 'own')
  assert.ok(planned.kind === 'plan')
  f.input.plan = planned.plan
  const abort = new AbortController()
  f.input.signal = abort.signal
  let count = 0
  f.input.verifyExecution = async () => { if (++count === 3) abort.abort(new Error('HANDLER_CHECK_CANCELLED')) }
  await assert.rejects(vueViteAdapter.start(f.input), /HANDLER_CHECK_CANCELLED/)
  assert.equal(count, 3)
  await access(f.configMarker)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
  assert.ok(!f.events.some(value => value.type === 'evidence' && value.layer === 'serviceReachable'))
})

test('owned environment/cache policy survives project config hooks and modules do not enable cross-origin reads', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const { readFile } = await import('node:fs/promises')
  const config = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  await f.put('vite.config.mjs', config.replace('return vue()', `return [vue(), { name: 'fixture-config-hook', config() { return { cacheDir: '.project-cache', envDir: '.', server: { cors: true, headers: { 'Content-Security-Policy': 'default-src *', 'Access-Control-Allow-Origin': '*', 'X-Fixture': 'preserved' } } } }, resolveId(id) { if (id.startsWith('/api/')) throw new Error('Business path must not reach compiler resolution') } }]`))
  const outcome = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector })
  assert.equal(outcome.kind, 'plan')
  if (outcome.kind !== 'plan') throw new Error('Expected candidate')
  f.input.plan = outcome.plan
  const before = await files(f.appRoot)
  const handle = await vueViteAdapter.start(f.input)
  running = handle
  const origin = new URL(handle.url).origin
  const target = await fetch(origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script', Origin: 'http://unrelated.invalid' } })
  assert.equal(target.status, 200)
  assert.equal(target.headers.get('access-control-allow-origin'), null)
  assert.match(target.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
  assert.equal(target.headers.get('x-fixture'), 'preserved')
  const source = await target.text()
  assert.ok(!source.includes('THIS_VALUE_MUST_NOT_BE_EXPOSED'))
  assert.equal((await fetch(origin + '/api/unknown')).status, 404)
  assert.deepEqual(await files(f.appRoot), before)
  assert.deepEqual(await handle.stop(), { residual: [] })
})

test('explicit styles in declared dependency roots outside the workspace remain available through Vite', { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  const shared = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owned-theme-')))
  let running: RunningHandle | undefined
  t.after(async () => { if (running) assert.deepEqual(await running.stop(), { residual: [] }); await f.cleanup(); await rm(shared, { recursive: true, force: true }) })
  const theme = join(shared, 'theme@1 space.css')
  await writeFile(theme, '.declared-shared-theme { color: #246 }')
  f.input.config.project.runtime.dependencyRoots = [shared]
  f.input.config.project.runtime.styles = [relative(f.appRoot, theme)]
  const planned = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector })
  assert.equal(planned.kind, 'plan')
  if (planned.kind !== 'plan') throw new Error('Expected declared style plan')
  f.input.plan = planned.plan
  running = await vueViteAdapter.start(f.input)
  const entryCode = await fetch(new URL('/@id/__x00__dsh-page-preview:entry', running.url)).then(response => response.text())
  const importedStyle = parseScriptSource('entry.js', entryCode).references.find(value => value.kind === 'module' && value.value.includes('theme'))?.value
  assert.ok(importedStyle)
  assert.ok(importedStyle.startsWith('/@fs/'), 'Follow the URL published by Vite, as the browser does; do not test the original input URL only')
  const response = await fetch(new URL(importedStyle, running.url), { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type') ?? '', /javascript/)
  assert.match(await response.text(), /declared-shared-theme/)
  assert.equal(await readFile(theme, 'utf8'), '.declared-shared-theme { color: #246 }')
})

test('a scenario update is rejected honestly when the installed Vite lacks module graph invalidation',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  // 项目插件在 configureServer 摘掉 invalidateAll：worker 如实回绝更新、不换绑（R5-0c）。
  const config = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  await f.put('vite.config.mjs', config.replace('plugins: [',
    `plugins: [{ name: 'dsh-strip-invalidate', `
      + `configureServer(server) { server.moduleGraph.invalidateAll = undefined } },`))
  const planned = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId,
    targetId: f.input.plan.targetId, scope: 'component', selector: f.input.plan.selector })
  assert.equal(planned.kind, 'plan')
  if (planned.kind !== 'plan') throw new Error('Expected candidate')
  f.input.plan = planned.plan
  running = await vueViteAdapter.start(f.input)
  await assert.rejects(
    running.switchScenario!({ name: 'alt', scenario: {}, fingerprint: 'no-invalidate' }),
    /module graph invalidation/)
  assert.equal((await fetch(new URL(running.url).origin + '/api/orders')).status, 404,
    'a rejected update must not bind any scenario data')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('a scenario update over a failed compile still binds but answers honestly stale',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  running = await vueViteAdapter.start(f.input)
  const origin = new URL(running.url).origin
  const target = () => fetch(origin + '/src/Target.vue', { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal((await target()).status, 200)
  assert.equal((await fetch(origin + '/api/orders')).status, 404)
  // 弄坏 SFC：转换失败经 logger 如实上报 compile_error，expectBuild 清空。
  await f.put('src/Target.vue', '<template><div>{{ broken </template>')
  let diagnostic: Diagnostic | undefined
  for (let i = 0; i < 200; i++) {
    if ((await target()).status === 500) {
      diagnostic = f.events.find((value): value is Extract<RunEvent, { type: 'diagnostic' }> =>
        value.type === 'diagnostic' && value.diagnostic.code === 'compile_error')?.diagnostic
      if (diagnostic) break
    }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.ok(diagnostic, 'the broken SFC must surface a compile_error diagnostic')
  // 虚拟入口立即生效：换绑照常执行，ack stale 如实回报上次编译失败（R5-0c）。
  const outcome = await running.switchScenario!({ name: 'alt',
    scenario: { businessPaths: ['/api/**'], props: { marker: 'alt' }, http: [
      { method: 'GET', path: '/api/orders',
        response: { status: 200, body: { value: 'alt-orders' } } }] },
    fingerprint: 'stale-alt' })
  assert.deepEqual(outcome, { kind: 'updated', freshness: 'stale' },
    'the update must bind while honestly reporting the last compile failed')
  assert.deepEqual(await fetch(origin + '/api/orders').then(value => value.json()),
    { value: 'alt-orders' }, 'the new scenario Mock must serve after the update')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('the build long-poll only fires on scenario updates, not on in-place HMR',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  running = await vueViteAdapter.start(f.input)
  const origin = new URL(running.url).origin
  const stamp = async () => {
    const html = await (await fetch(running!.url)).text()
    return { build: /__DSH_BUILD__="([^"]+)"/.exec(html)?.[1],
      nonce: /"nonce":"([a-f0-9]+)"/.exec(html)?.[1] }
  }
  const first = await stamp()
  assert.ok(first.build && first.nonce)
  const build = () => fetch(origin + '/__dsh_preview/build?nonce=' + first.nonce
    + '&since=never-matches&seq=-1').then(async value => JSON.parse(await value.text()))
  assert.deepEqual(await build(), { build: first.build, seq: 0 },
    'the build long-poll reports the last served document stamp')
  // SFC 修改 → handleHotUpdate 推新 servedBuild；文档未重供 → docBuild 与 seq 都不变（R5-0c）。
  await f.put('src/Target.vue',
    '<script setup>const x = 1</script>\n<template><h1>hmr-marker</h1></template>')
  const deadline = Date.now() + 15000
  while (!f.events.some(value => value.type === 'freshness' && value.freshness === 'unverified')
    && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(f.events.some(value => value.type === 'freshness' && value.freshness === 'unverified'),
    'the in-place HMR compile must be reported')
  assert.deepEqual(await build(), { build: first.build, seq: 0 },
    'an in-place HMR update must not bump the document build stamp or the reload seq')
  // 场景更新只 bump 轮询 seq：浏览器据此整页重载，文档印章随新文档更新。
  const outcome = await running.switchScenario!({ name: 'alt',
    scenario: { props: { marker: 'alt' } }, fingerprint: 'hmr-alt' })
  assert.equal(outcome.kind, 'updated')
  assert.deepEqual(await build(), { build: first.build, seq: 1 },
    'a scenario update bumps the reload seq, not the document stamp')
  const second = await stamp()
  assert.ok(second.build && second.build !== first.build,
    'the reloaded document must carry the newer compile stamp')
  assert.deepEqual(await build(), { build: second.build, seq: 1 },
    'the document build stamp follows the served document, not the latest compile')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('the entry login chain runs its real flow: a scenario fixture answers, without one it stays unmatched',
  { skip: integrationSkip || !chromeAvailable(), timeout: 90000 }, async t => {
  // R5-1d（overview/web 形态）：入口顶层先调登录接口、再 initVue()。生成 setup 搬运整条调用链：
  // 场景提供登录 fixture → 原业务流程完成挂载；没有 fixture → 登录请求如实 unmatched、目标不挂载。
  // 证据为真实 Vite worker + 无头 Chrome（非 DSH 载体）。
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  await f.put('src/main.js', `import { createApp } from 'vue'
import App from './Target.vue'
async function getLoginInfo() {
  const response = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'reader' }) })
  if (!response.ok) throw new Error('login failed: ' + response.status)
  await initVue()
}
async function initVue() { const app = createApp(App); app.mount('#app') }
const token = 'present'
if (!token) initVue(); else getLoginInfo()`)
  const project = { ...f.input.config.project, scenarios: { login: {
    businessPaths: ['/api/**'],
    http: [{ method: 'POST', path: '/api/login', response: { status: 200, body: { ok: true, user: 'reader' } } }],
  } } }
  const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
    profile: f.input.profile, config: { ...f.input.config, project } }
  const target = { projectId: 'vue-app', targetId: 'actual', scope: 'component',
    selector: { kind: 'file', path: 'src/Target.vue' } } as const
  const planFor = async (scenario?: string) => {
    const outcome = await vueViteAdapter.plan(context, target, scenario)
    if (outcome.kind !== 'plan') throw new Error('Login-chain plan failed')
    return { ...f.input, config: context.config, plan: outcome.plan }
  }
  const mountText = async (url: string) => {
    const chrome = await launchChrome(t)
    try {
      await chrome.navigate(url)
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = String(await chrome.evaluate('document.body.innerText'))
        if (text.includes('Real adapter target')) return text
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return 'not mounted: ' + chrome.events().join(' ; ').slice(0, 1500)
    } finally { await chrome.close() }
  }
  // 登录 fixture 命中：fetch → 200 → initVue → 预览挂载目标（真实浏览器 DOM 证据）。
  running = await vueViteAdapter.start(await planFor('login'))
  assert.match(await mountText(running.url), /Real adapter target/,
    'the fixture-answered login chain must complete the original init flow')
  assert.ok(!f.events.some(value => value.type === 'unmatched' && value.request.path === '/api/login'),
    'the fixture-matched login request must not be unmatched')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
  // 无场景 fixture：同一入口的登录请求如实 unmatched；getLoginInfo 失败、目标不挂载。
  f.events.length = 0
  running = await vueViteAdapter.start(await planFor())
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    const deadline = Date.now() + 20000
    while (Date.now() < deadline
      && !f.events.some(value => value.type === 'unmatched' && value.request.path === '/api/login')) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(!String(await chrome.evaluate('document.body.innerText')).includes('Real adapter target'),
      'an unmatched login request must not mount the target: ' + chrome.events().join(' ; ').slice(0, 1500))
  } finally { await chrome.close() }
  assert.ok(f.events.some(value => value.type === 'unmatched'
      && value.request.method === 'POST' && value.request.path === '/api/login'),
    'the login request must be reported unmatched')
  assert.ok(!f.events.some(value => value.type === 'evidence' && value.layer === 'targetMounted'
      && value.evidence.status === 'proven'),
    'an unmatched login request must not produce a mounted target')
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('project vite-plugin-mock executes only outside declared businessPaths; declared paths stay unmatched (R5-1e)',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  await f.put('mock/api.ts', `export default [
  { url: '/api/mock-user', method: 'get', response: () => ({ name: 'project-mock-user' }) },
  { url: '/api/declared/x', method: 'get', response: () => ({ name: 'must-be-shadowed' }) },
]`)
  const fs = await import('node:fs/promises')
  for (const name of ['vite-plugin-mock', 'mockjs'])
    await fs.symlink(await realpath(join(modules!, name)), join(f.appRoot, 'node_modules', name))
  await f.put('package.json', JSON.stringify({ private: true, type: 'module',
    dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4',
      'vite-plugin-mock': '3.0.2', mockjs: '1.1.0' } }))
  const vuePluginUrl = (await import('node:url'))
    .pathToFileURL(join(await realpath(join(modules!, '@vitejs/plugin-vue')), 'dist/index.mjs')).href
  await f.put('vite.config.mjs', `import vue from ${JSON.stringify(vuePluginUrl)}
import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [vue(), viteMockServe({ mockPath: 'mock', localEnabled: true })] }`)
  const project = { ...f.input.config.project, scenarios: { s: {
    businessPaths: ['/api/declared/**'],
    http: [],
  } } }
  const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
    profile: f.input.profile, config: { ...f.input.config, project } }
  const target = { projectId: 'vue-app', targetId: 'actual', scope: 'component',
    selector: { kind: 'file', path: 'src/Target.vue' } } as const
  const outcome = await vueViteAdapter.plan(context, target, 's')
  if (outcome.kind !== 'plan') throw new Error('mockPlugin plan failed')
  const coverage = outcome.plan.capabilities.network
  assert.ok(coverage.some(entry => entry.channel === 'browser-http' && entry.location === 'project'
      && entry.control === 'mock'), 'plan must report project-mock coverage honestly')
  running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
  const origin = new URL(running.url).origin
  // vite-plugin-mock 的 configResolved 不等待 mockData 装载；请求级匹配懒读，轮询至就绪。
  let mockedStatus = 0
  let mockedBody: unknown
  for (let attempt = 0; attempt < 60 && mockedStatus !== 200; attempt++) {
    const response = await fetch(origin + '/api/mock-user')
    mockedStatus = response.status
    mockedBody = await response.json().catch(() => undefined)
    if (mockedStatus !== 200) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(mockedStatus, 200)
  assert.deepEqual(mockedBody, { name: 'project-mock-user' })
  // 声明的 businessPaths 由场景层独占：项目 mock 同路径应答被遮蔽，如实 unmatched。
  const shadowed = await fetch(origin + '/api/declared/x')
  assert.equal(shadowed.status, 404)
  assert.deepEqual(await shadowed.json(), { code: 'unmatched_request' })
  const plain = await fetch(origin + '/api/nothing')
  assert.equal(plain.status, 404)
  assert.deepEqual(await plain.json(), { code: 'unmatched_request' })
  assert.ok(f.events.some(value => value.type === 'unmatched' && value.request.path === '/api/declared/x'))
  // 未检出 MSW 的项目：bootstrap 屏蔽 serviceWorker API，service-worker: block 声明成立。
  if (chromeAvailable()) {
    const chrome = await launchChrome(t)
    try {
      await chrome.navigate(running.url)
      assert.equal(await chrome.evaluate('typeof navigator.serviceWorker'), 'undefined')
    } finally { await chrome.close() }
  }
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('an out-of-root or absent mockPath reports project_mock_unavailable, not silence (R5-1e)',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const fs = await import('node:fs/promises')
  for (const name of ['vite-plugin-mock', 'mockjs'])
    await fs.symlink(await realpath(join(modules!, name)), join(f.appRoot, 'node_modules', name))
  await f.put('package.json', JSON.stringify({ private: true, type: 'module',
    dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4',
      'vite-plugin-mock': '3.0.2', mockjs: '1.1.0' } }))
  // 插件已装但 mockPath 指向不存在目录：加载如实失败，请求落未命中。
  const vuePluginUrl = (await import('node:url'))
    .pathToFileURL(join(await realpath(join(modules!, '@vitejs/plugin-vue')), 'dist/index.mjs')).href
  await f.put('vite.config.mjs', `import vue from ${JSON.stringify(vuePluginUrl)}
import { viteMockServe } from 'vite-plugin-mock'
export default { plugins: [vue(), viteMockServe({ mockPath: 'mock/missing-dir' })] }`)
  const target = { projectId: 'vue-app', targetId: 'actual', scope: 'component',
    selector: { kind: 'file', path: 'src/Target.vue' } } as const
  const outcome = await vueViteAdapter.plan(f.input, target)
  if (outcome.kind !== 'plan') throw new Error('missing-plugin plan failed')
  running = await vueViteAdapter.start({ ...f.input, plan: outcome.plan })
  const origin = new URL(running.url).origin
  for (let attempt = 0; attempt < 60
    && !f.events.some(value => value.type === 'diagnostic'
      && value.diagnostic.code === 'project_mock_unavailable'); attempt++)
    await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(f.events.some(value => value.type === 'diagnostic'
      && value.diagnostic.code === 'project_mock_unavailable'),
    'the missing plugin must be diagnosed, got: ' + JSON.stringify(f.events.slice(-8)).slice(0, 1200))
  const response = await fetch(origin + '/api/mock-user')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { code: 'unmatched_request' })
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('project MSW worker serves intercepted requests inside the document; the rest stays unmatched (R5-1e)',
  { skip: integrationSkip, timeout: 40000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const fs = await import('node:fs/promises')
  await fs.symlink(await realpath(join(modules!, 'msw')), join(f.appRoot, 'node_modules/msw'))
  await fs.mkdir(join(f.appRoot, 'public'), { recursive: true })
  await fs.copyFile(join(await realpath(join(modules!, 'msw')), 'lib/mockServiceWorker.js'),
    join(f.appRoot, 'public/mockServiceWorker.js'))
  await f.put('package.json', JSON.stringify({ private: true, type: 'module',
    dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4', msw: '2.15.0' } }))
  await f.put('src/mocks/browser.js', `import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
export const worker = setupWorker(http.get('/api/orders', () => HttpResponse.json({ items: ['MSW-ORDER'] })))`)
  await f.put('src/main.js', `import { createApp } from 'vue'
import App from './Target.vue'
import { worker } from './mocks/browser.js'
async function initVue() { await worker.start(); createApp(App).mount('#app') }
initVue()`)
  await f.put('src/Target.vue', `<script setup lang="ts">
import { ref, onMounted } from 'vue'
const orders = ref<string[]>([])
const miss = ref(0)
onMounted(async () => {
  orders.value = (await (await fetch('/api/orders')).json()).items
  miss.value = (await fetch('/api/miss')).status
})
</script>
<template><article><h1>Target</h1><p>{{ orders.join(',') }}</p><small>miss:{{ miss }}</small></article></template>`)
  const project = { ...f.input.config.project, scenarios: { s: { businessPaths: ['/api/**'], http: [] } } }
  const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
    profile: f.input.profile, config: { ...f.input.config, project } }
  const target = { projectId: 'vue-app', targetId: 'actual', scope: 'component',
    selector: { kind: 'file', path: 'src/Target.vue' } } as const
  const outcome = await vueViteAdapter.plan(context, target, 's')
  if (outcome.kind !== 'plan') throw new Error('msw plan failed')
  const sw = outcome.plan.capabilities.network.find(entry => entry.channel === 'service-worker')
  assert.equal(sw?.control, 'mock')
  assert.equal(sw?.location, 'project')
  running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(running.url)
    const deadline = Date.now() + 30000
    let text = ''
    while (Date.now() < deadline) {
      text = String(await chrome.evaluate('document.body.innerText'))
      if (text.includes('miss:')) { const value = text.match(/miss:(\d+)/); if (value && value[1] !== '0') break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.match(text, /MSW-ORDER/, 'the project MSW handler must answer /api/orders inside the document: '
      + chrome.events().join(' ; ').slice(0, 1500))
    assert.match(text, /miss:404/, 'requests outside the MSW handlers must reach the plugin layer as unmatched')
  } finally { await chrome.close() }
  // /api/orders 在文档内被 SW 拦截，插件层看不到；/api/miss 穿透到插件层如实 unmatched。
  assert.ok(!f.events.some(value => value.type === 'unmatched' && value.request.path === '/api/orders'))
  assert.ok(f.events.some(value => value.type === 'unmatched' && value.request.path === '/api/miss'))
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('declared ws/sse channels play their fixed sequences while undeclared upgrades stay blocked (R5-1g)',
  { skip: integrationSkip, timeout: 30000 }, async t => {
  if (!modules) throw new Error('Explicit DSH_PREVIEW_TEST_MODULES is required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  const project = { ...f.input.config.project, scenarios: { s: {
    ws: [{ path: '/api/push', send: [{ data: 'seq-1' }, { data: 'seq-2', delay: 10 }],
      close: { code: 1000, reason: 'done' } }],
    sse: [{ path: '/api/stream', events: [{ data: 'evt-1' }, { data: 'evt-2' }] }],
  } } }
  const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
    profile: f.input.profile, config: { ...f.input.config, project } }
  const target = { projectId: 'vue-app', targetId: 'actual', scope: 'component',
    selector: { kind: 'file', path: 'src/Target.vue' } } as const
  const outcome = await vueViteAdapter.plan(context, target, 's')
  if (outcome.kind !== 'plan') throw new Error('ws/sse plan failed')
  // 覆盖如实：声明通道为 mock，其余浏览器通道仍按自有层 block/mock。
  const coverage = Object.fromEntries(outcome.plan.capabilities.network
    .map(value => [value.channel, value.control + '/' + value.location]))
  assert.equal(coverage['browser-ws'], 'mock/response-layer')
  assert.equal(coverage['browser-sse'], 'mock/response-layer')
  running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
  const wsUrl = new URL(running.url).origin.replace(/^http/, 'ws')
  const httpOrigin = new URL(running.url).origin
  // 声明路径：固定序列 + 配置的关闭。
  const declared = await new Promise<{ messages: string[]; code: number }>((resolve, reject) => {
    const messages: string[] = []
    const ws = new WebSocket(wsUrl + '/api/push')
    ws.onmessage = event => messages.push(String(event.data))
    ws.onclose = event => resolve({ messages, code: event.code })
    ws.onerror = () => reject(new Error('declared ws failed'))
    setTimeout(() => reject(new Error('declared ws timed out')), 8000)
  })
  assert.deepEqual(declared.messages, ['seq-1', 'seq-2'])
  assert.equal(declared.code, 1000)
  // 未声明路径：socket 在握手前被销毁 + blocked_request 诊断。
  const blocked = await new Promise<string>(resolve => {
    const ws = new WebSocket(wsUrl + '/api/other')
    ws.onopen = () => resolve('opened')
    ws.onerror = () => resolve('error')
    setTimeout(() => resolve('timeout'), 8000)
  })
  assert.notEqual(blocked, 'opened')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'blocked_request')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(f.events.some(value => value.type === 'diagnostic'
      && value.diagnostic.code === 'blocked_request'), 'undeclared upgrade must report blocked_request')
  // 声明 SSE 通道经同一准入供出固定事件流。
  const sse = await fetch(httpOrigin + '/api/stream')
  assert.equal(sse.status, 200)
  assert.match(await sse.text(), /data: evt-1\n\ndata: evt-2\n/)
  assert.deepEqual(await running.stop(), { residual: [] })
  running = undefined
})

test('a Service Worker registers and intercepts inside a same-origin iframe under the preview CSP (R5-1e experiment)',
  { skip: integrationSkip || !chromeAvailable(), timeout: 30000 }, async t => {
  // 方案 §7.2 的 iframe SW 实测：owned 响应层 CSP 形状下，同源 iframe 内注册/拦截成立（headless Chrome，载体另行验收）。
  const { createServer } = await import('node:http')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sw-iframe-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const inner = `<script>
navigator.serviceWorker.register('/sw.js')
  .then(() => new Promise(done => {
    if (navigator.serviceWorker.controller) return done()
    navigator.serviceWorker.addEventListener('controllerchange', () => done())
    setTimeout(done, 8000)
  }))
  .then(() => fetch('/api/probe'))
  .then(response => response.text()).then(text => { document.body.innerText = text })
  .catch(error => { document.body.innerText = 'FAILED ' + error })
<\/script>`
  const sw = `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  if (event.request.url.endsWith('/api/probe')) event.respondWith(new Response('sw-iframe-answer'))
})`
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/outer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<iframe src="/inner.html"></iframe>'); return
    }
    if (path === '/inner.html') {
      res.writeHead(200, { 'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; worker-src 'self';"
          + " script-src 'unsafe-inline'" })
      res.end(inner); return
    }
    if (path === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(sw); return }
    if (path === '/api/probe') { res.writeHead(200); res.end('server-answer'); return }
    res.writeHead(404); res.end()
  })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0)
  const chrome = await launchChrome(t)
  try {
    await chrome.navigate(origin + '/outer.html')
    const deadline = Date.now() + 15000
    let text = ''
    while (Date.now() < deadline) {
      text = String(await chrome.evaluate('frames[0] && frames[0].document && frames[0].document.body'
        + ' && frames[0].document.body.innerText'))
      if (text && text !== 'undefined' && text !== '') break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(text, 'sw-iframe-answer',
      'iframe Service Worker registration/interception failed: ' + chrome.events().join(' ; ').slice(0, 1200))
  } finally { await chrome.close() }
})
