/** 非精确版本组合的 P0-1 验收（方案 §0.3 第 1 条、§6.2、§6.5、§15.3）。
 * 仓库内固定的 Vue 3.5/Vite 6 工具链没有样本证据：预览照常打开，结果带
 * unverified_toolchain 诊断，能力保持 unknown；不宣称 supported。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import type { RunningHandle } from '../../src/adapters/types.ts'
import { strict } from '../helpers/test-gate.ts'

const unverifiedModules = fileURLToPath(new URL('../toolchains/vue3-unverified-vite6/node_modules', import.meta.url))
const installed = existsSync(unverifiedModules + '/vite/package.json') && existsSync(unverifiedModules + '/@vitejs/plugin-vue/package.json')
const skip = (!['darwin', 'linux'].includes(process.platform) || !installed) && !strict

test('unverified Vue 3.5/Vite 6/toolchain opens a real preview with unverified_toolchain diagnostics and unknown capabilities', { skip, timeout: 30000 }, async t => {
  if (!installed) throw new Error('The vue3-unverified-vite6 toolchain is not installed; run npm run pretest')
  const f = await createVueViteFixture(unverifiedModules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) await running.stop(); await f.cleanup() })
  assert.equal(f.input.plan.toolchain.vue, '3.5.42')
  assert.equal(f.input.plan.toolchain.vite, '6.4.3')
  assert.equal(f.input.plan.toolchain.vuePluginVersion, '6.0.9')
  assert.equal(f.input.plan.capabilities.scopes.component?.status, 'unknown')
  assert.equal(f.input.plan.capabilities.isolatedRender.status, 'unknown')
  assert.ok(f.input.plan.knownDifferences.some(value => value.includes('unverified_toolchain')))
  const handle = await vueViteAdapter.start(f.input)
  running = handle
  const diagnostic = f.events.find(value => value.type === 'diagnostic' && value.diagnostic.code === 'unverified_toolchain')
  assert.ok(diagnostic?.type === 'diagnostic')
  assert.match(diagnostic.diagnostic.message, /vite 6\.4\.3/i)
  const document = await fetch(handle.url)
  assert.equal(document.status, 200)
  assert.ok((await document.text()).includes('__dsh_preview_root'), 'Owned mount container must be present')
  const target = await fetch(new URL('/src/Target.vue', handle.url), { headers: { 'sec-fetch-dest': 'script' } })
  assert.equal(target.status, 200)
  assert.match(await target.text(), /Real adapter target|Adapter counter/)
  assert.equal((await fetch(new URL('/api/unknown', handle.url))).status, 404)
  assert.deepEqual(await handle.stop(), { residual: [] })
  assert.deepEqual(await f.ledger.listByPreview(f.input.previewId), [])
})
