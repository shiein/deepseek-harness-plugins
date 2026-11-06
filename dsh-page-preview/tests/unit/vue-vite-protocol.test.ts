/** Vite 私有协议/入口生成（方案 §6.3、§6.5、§9.2）；只用临时文件，不执行项目模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vueCandidateCapabilities } from '../../src/adapters/vue/preflight.ts'
import { createViteSources, viteFsImport } from '../../src/adapters/vue/vite/sources.ts'
import { parseViteWorkerInput, parseViteWorkerOutput, parseViteHandlerReply, VITE_VIRTUAL_PREFIX } from '../../src/adapters/vue/vite/protocol.ts'
import type { ViteWorkerInput } from '../../src/adapters/vue/vite/protocol.ts'
import { parseScriptSource } from '../../src/shared/javascript.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vite-source space#-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/Target space__VUE_MAJOR__.vue'), '<template>Original</template>')
  await writeFile(join(root, 'setup.js'), 'export default {}')
  await writeFile(join(root, 'theme.css'), 'body { color: #123 }')
  const input: ViteWorkerInput = { type: 'start', previewId: 'test', workspaceRoot: root, appRoot: root, temporaryRoot: root,
    project: { id: 'vue', root: '.', runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [], setup: 'setup.js', styles: ['theme.css'] } },
    plan: { projectId: 'vue', targetId: 'actual', selector: { kind: 'file', path: 'src/Target space__VUE_MAJOR__.vue' }, scope: 'component', strategy: 'isolated', adapter: { id: 'vue-vite', version: '0.0.0' }, toolchain: { vue: '3.4.27', vite: '5.2.12' }, requirements: [], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 10000, targetDeadlineMs: 10000 }, capabilities: vueCandidateCapabilities(), fingerprints: { config: 'test-only' }, missing: [], knownDifferences: [] },
  }
  return input
}

test('source generation preserves raw Vite file IDs and keeps network/style/setup/target loading ordered', async t => {
  const input = await fixture(t)
  input.plan.route = {path:'/orders/:id#details',params:{id:'42'},query:{note:'from fixture'}}
  const sources = await createViteSources(input)
  const entry = sources.modules.get(VITE_VIRTUAL_PREFIX + 'entry')!
  assert.ok(entry.includes('/orders/42?note=from+fixture#details'))
  assert.match(entry, /window\.__DSH_PREVIEW__/)
  assert.ok(entry.includes(viteFsImport(join(input.appRoot, 'src/Target space__VUE_MAJOR__.vue'))))
  assert.match(entry, /Target space__VUE_MAJOR__\.vue/)
  assert.ok(entry.indexOf('await bridge.mockReady') < entry.indexOf(viteFsImport(join(input.appRoot, 'theme.css'))))
  assert.ok(entry.includes('loadSetup: function'))
  assert.ok(sources.exposedFiles.includes(join(input.appRoot, 'theme.css')))
  for (const [id, source] of sources.modules) assert.equal(parseScriptSource(id + '.js', source).invalid, false)
  input.plan.toolchain.vue = 'unknown'
  await assert.rejects(createViteSources(input), /unresolved/)
})

test('worker input/output rejects approval flags, foreign execution shapes and unproven readiness claims', async t => {
  const input = await fixture(t)
  assert.equal(parseViteWorkerInput(input).project.id, 'vue')
  assert.throws(() => parseViteWorkerInput({ ...input, approved: true }))
  assert.throws(() => parseViteWorkerInput({ ...input, project: { ...input.project, id: 'different' } }))
  assert.throws(() => parseViteWorkerInput({ ...input, plan: { ...input.plan, process: { kind: 'attach', origin: 'http://127.0.0.1:1234' } } }))
  assert.throws(() => parseViteWorkerOutput({ type: 'ready', pid: 10, origin: 'https://external.invalid', nonce: 'synthetic-not-a-session-secret-value' }))
  assert.throws(() => parseViteWorkerOutput({ type: 'booted', pid: 10, ready: true }))
  assert.throws(() => parseViteWorkerOutput({ type: 'report', report: { kind: 'target-mounted', detail: { fake: true } } }))
  assert.deepEqual(parseViteWorkerOutput({ type: 'compile-error' }), { type: 'compile-error' })
  // §13 第 8 条转发字段：编译错误详情、被拦截请求三元组、失败详情都过同一严格边界。
  const compile = { type: 'compile-error', message: 'Unexpected token', file: 'src/Target.vue', line: 3, column: 9, frame: '  3 | <div' }
  assert.deepEqual(parseViteWorkerOutput(compile), compile)
  for (const bad of [
    { ...compile, line: 0 }, { ...compile, line: '3' }, { ...compile, message: 1 }, { ...compile, unknown: 'field' },
  ]) assert.throws(() => parseViteWorkerOutput(bad), JSON.stringify(bad).slice(0, 60))
  const http = { type: 'http-diagnostic', code: 'unmatched_request', method: 'GET', origin: 'http://127.0.0.1:9000', path: '/api/items' }
  assert.deepEqual(parseViteWorkerOutput(http), http)
  for (const bad of [
    { ...http, code: 'other' }, { ...http, method: 1 }, { ...http, query: 'secret=1' },
  ]) assert.throws(() => parseViteWorkerOutput(bad), JSON.stringify(bad).slice(0, 60))
  const failed = { type: 'failed', code: 'runtime_error', message: 'worker blew up', stack: 'Error: x\n    at a (/a:1)' }
  assert.deepEqual(parseViteWorkerOutput(failed), failed)
  assert.throws(() => parseViteWorkerOutput({ ...failed, message: 9 }))
  assert.deepEqual(parseViteWorkerOutput({ type: 'verify-handlers', pid: 10 }), {type:'verify-handlers', pid:10})
  assert.deepEqual(parseViteHandlerReply({type:'handlers-verified'}), {type:'handlers-verified'})
  assert.throws(() => parseViteHandlerReply({type:'handlers-verified', approved:true}))
  assert.throws(() => parseViteHandlerReply({type:'handlers-verified', fingerprint:'agent-supplied'}))
})
