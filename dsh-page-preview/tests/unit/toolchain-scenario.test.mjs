/** 真实工具链全链路（方案 §9.1、§9.2、R3-1~R3-5、R6-3）：Vite worker 上
 * 草稿→填表→refresh→merge+applyTo→切场景→影响分析→inputs-changed。 */
import { executeTool, installApproval } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import { ImpactService } from '../../src/host/impact-service.ts'
import { requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'

const options = { skip: integrationSkip, timeout: 60000 }
const openArgs = { projectId: 'vue-app', target: { kind: 'file', path: 'src/Target.vue' },
  scope: 'component', requirements: ['isolated-target'] }

async function setup(t) {
  if (!modules) throw new Error('Explicit existing DSH_PREVIEW_TEST_MODULES is required')
  const fixture = await createVueViteFixture(modules)
  const dataDir = join(fixture.root, 'plugin')
  const project = structuredClone(fixture.input.config.project)
  const save = async () => writeFile(join(fixture.root, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  await save()
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  await installApproval(ctx, {})
  const session = sessions.create(SessionId('toolchain-e2e'), { meta: { cwd: fixture.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const impact = new ImpactService({ dataDir })
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir, impact, triggerMode: 'smart',
    requestApproval: (caller, config, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated),
    requestConfigWrite: async () => 'approved' })
  registerTools(ctx, registry)
  let call = 0
  const invoke = async (name, args = {}) => {
    const result = await executeTool(tools, {
      callId: ToolCallId('toolchain-' + ++call), name: 'page_preview_' + name,
      arguments: args, signal: AbortSignal.timeout(20000), agent,
    })
    assert.equal(result.isError, false, 'Actual SDK must return a domain result')
    return result.value
  }
  t.after(async () => {
    impact.forget(session.id)
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await fixture.cleanup()
  })
  return { ...fixture, dataDir, project, save, ctx, client, registry, impact, session, invoke }
}

const api = (preview, path) => fetch(new URL(path, preview.url)).then(response => response)

const title = 'toolchain E2E: unmatched draft → filled fixture via refresh → merge+applyTo → scenario switch → impact → inputs-changed'
test(title, options, async t => {
  const f = await setup(t)
  f.project.scenarios = {
    own: { businessPaths: ['/api/**'], http: [] },
    alt: { businessPaths: ['/api/**'], http: [
      { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'alt-orders' } } },
    ] },
  }
  await f.save()
  f.ctx.on('approval/request', async () => 'allowed-once')
  const opened = await f.invoke('open', { ...openArgs, scenario: 'own' })
  assert.equal(opened.status, 'ok', JSON.stringify(opened))
  assert.equal(opened.preview.state, 'reachable')
  const id = opened.preview.previewId

  // R3-1：未命中请求记入 unmatched 与 fixture 草稿（占位 body），不把 404 当成数据。
  assert.equal((await api(opened.preview, '/api/orders?n=1')).status, 404)
  const detail = await f.invoke('status', { previewId: id, detail: true })
  assert.ok(detail.unmatched?.entries?.some(value => value.path === '/api/orders'),
    'status must surface the unmatched request')
  assert.ok(detail.fixtureDraft?.fixtures?.some(value => value.path === '/api/orders'),
    'status must surface a fillable fixture draft')

  // R3-2：把草稿对应的 fixture 填进配置后 refresh 即生效，不需要 reopen。
  f.project.scenarios.own.http = [
    { method: 'GET', path: '/api/orders', response: { status: 200, body: { value: 'filled-orders' } } },
  ]
  await f.save()
  await f.invoke('refresh', { previewId: id })
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'filled-orders' })
  assert.equal((await api(opened.preview, '/api/other')).status, 404, 'Other paths stay honestly unmatched')

  // R6-3：未命中 → write_scenario(mode:'merge', applyTo) 一轮补数据；就地生效、未命中列表清空。
  assert.equal((await api(opened.preview, '/api/extra')).status, 404)
  const merged = await f.invoke('write_scenario', { projectId: 'vue-app', scenario: 'own',
    mode: 'merge', applyTo: id, definition: {
      businessPaths: ['/api/**'],
      http: [{ method: 'GET', path: '/api/extra', response: { status: 200, body: { value: 'merged-extra' } } }],
    } })
  assert.equal(merged.status, 'ok', JSON.stringify(merged))
  assert.equal(merged.mode, 'merged')
  assert.equal(merged.applied?.previewId, id)
  assert.equal(merged.applied?.status, 'ok', JSON.stringify(merged.applied))
  assert.deepEqual(await api(opened.preview, '/api/extra').then(r => r.json()), { value: 'merged-extra' })
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'filled-orders' },
    'Merge must not overwrite the fixture already in the file')
  const stable = await f.invoke('status', { previewId: id, detail: true })
  assert.equal(stable.unmatched?.entries?.length ?? 0, 0, 'Applying the merged scenario clears the unmatched list')
  assert.equal(stable.preview?.scenario, 'own')

  // 切换场景：refresh 带 scenario，数据换绑后旧 fixture 不再服务。
  await f.invoke('refresh', { previewId: id, scenario: 'alt' })
  assert.deepEqual(await api(opened.preview, '/api/orders').then(r => r.json()), { value: 'alt-orders' })
  const afterSwitch = await f.invoke('status', { previewId: id })
  assert.equal(afterSwitch.preview.scenario, 'alt')
  assert.equal(afterSwitch.preview.freshness, 'unverified')
  assert.equal((await api(opened.preview, '/api/orders')).status, 200)

  // R3-4/R3-5：改应用内源文件 → 真实影响分析产生本预览候选 → smart 触发 → Runner inputs-changed 就地更新。
  const before = await f.invoke('status', { previewId: id })
  assert.equal(before.preview.state, 'reachable')
  await f.impact.beginTurn(f.session.id, f.root)
  const source = await readFile(join(f.appRoot, 'src/Target.vue'), 'utf8')
  await f.put('src/Target.vue', source.replace('adapter-revision-1', 'edited-marker'))
  const impact = await f.impact.analyzeNow(f.session.id)
  const candidate = impact.candidates.find(value =>
    value.selector.kind === 'file' && value.selector.path === 'src/Target.vue')
  assert.ok(candidate, 'Editing the previewed source must yield this preview as an impact candidate')
  await f.registry.onTurnAnalyzed(f.session.id, impact)
  // inputs-changed 经 IPC 到 Runner 是 fire-and-forget：轮询 freshness 迁移与更新后仍服务。
  let seen = before.preview
  for (let i = 0; i < 120; i++) {
    await delay(50)
    const current = (await f.invoke('status', { previewId: id })).preview
    if (current.freshness === 'stale' || current.state === 'updating' ||
        (await api(current, '/src/Target.vue').then(r => r.text())).includes('edited-marker')) { seen = current; break }
    seen = current
  }
  const served = await api(seen, '/src/Target.vue').then(r => r.text())
  assert.ok(served.includes('edited-marker'), 'Vite worker must serve the edited source after inputs-changed refresh')
  assert.ok(['reachable', 'ready', 'degraded'].includes(seen.state), 'Preview must return to a serving state')
})
