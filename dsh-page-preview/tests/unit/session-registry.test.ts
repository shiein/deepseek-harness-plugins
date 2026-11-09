/** 产品 status/stop 经锁定 DSH 工具管线查询真实 Runner（方案 §4.2、§9.2、§15.3）；仅可丢弃样本。 */
import { executeTool } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { PreviewPlan, StatusResult, StopResult, CaptureResult, OpenResult } from '../../src/shared/contracts.ts'
import type { RefreshResult, WriteScenarioResult } from '../../src/shared/contracts.ts'
import { fingerprintJson } from '../../src/shared/fingerprint.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import type { SessionRegistryOptions } from '../../src/host/session-registry.ts'
import { ImpactService } from '../../src/host/impact-service.ts'
import type { ImpactResult } from '../../src/core/impact/types.ts'
import type { SetupWriteOutcome } from '../../src/host/setup-write-approval.ts'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { resolvePreviewCaller } from '../../src/host/caller.ts'
import type { PreviewCaller } from '../../src/host/caller.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { MAX_DIAGNOSTICS, truncateDiagnostics, visiblePlan } from '../../src/host/output.ts'
import { createFileLedger, readProcessStartTime } from '../../src/shared/runner/ledger.ts'
import { runnerPaths } from '../../src/shared/runner/paths.ts'
import { findListeningPids } from '../../src/shared/runner/port-ownership.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'
const options = { timeout: 15000, skip: !['darwin', 'linux'].includes(process.platform) }
const unknown = { status: 'unknown', source: 'none', reason: 'No target render evidence in this test' } as const

async function userService(t: { after(callback: () => Promise<void>): void }, directory: string) {
  const ledger = createFileLedger(join(directory, 'external-service'))
  const process = await spawnManaged({ executable: globalThis.process.execPath, args: [fileURLToPath(new URL('../fixtures/non-vite-existing-server/server.mjs', import.meta.url))], cwd: directory, env: {} }, ledger, { previewId: 'user-service', ownerSessionId: 'external-user', workspaceRoot: directory })
  t.after(async () => { assert.deepEqual(await process.stop(), []) })
  let output = ''
  for await (const chunk of process.stdout) {
    output += chunk
    if (output.includes('\n')) break
  }
  const info: unknown = JSON.parse(output.split('\n')[0]!)
  assert.ok(info && typeof info === 'object' && 'origin' in info && typeof info.origin === 'string')
  return { process, origin: info.origin, ledger }
}

async function setup(
  t: { after(callback: () => Promise<void>): void }, openWaitMs?: number, extra: SessionRegistryOptions = {},
  noDataDir = false,
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-registry-')))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await cp(new URL('../fixtures/static-multipage/', import.meta.url), join(workspace, 'public'), { recursive: true })
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const dataDir = join(dir, 'plugin')
  const client = new RunnerClient({ dataDir })
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  let caller: PreviewCaller = { ownerSessionId: 'A', workspaceRoot: workspace }
  const registry = new SessionRegistry(client, async () => caller,
    { ...(noDataDir ? {} : { dataDir }), ...(openWaitMs === undefined ? {} : { openWaitMs }), ...extra })
  registerTools(ctx, registry)
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const plan: PreviewPlan = { projectId: 'site', targetId: 'index', selector: { kind: 'file', path: 'public/index.html' }, scope: 'page', strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: ['mock-only'], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 3000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: fingerprintJson(project) }, missing: [], knownDifferences: [] }
  async function invoke(name: string, args: object) {
    const result = await executeTool(tools, { callId: ToolCallId('test-' + name), name: 'page_preview_' + name, arguments: args, signal: AbortSignal.timeout(5000) })
    assert.equal(result.isError, false)
    if (result.isError) throw new Error('Expected a domain result from the actual DSH tool pipeline')
    // 通用 SDK JSON 在此进入测试领域 DTO；这里只恢复静态类型，实际字段继续由下面的断言验证。
    const value: unknown = result.value
    return value
  }
  // SDK 的通用 JSON 来自上面注册的产品工具；测试按对应的领域 DTO 读取。
  const status = async (args = {}) => await invoke('status', args) as StatusResult
  const stop = async (args = {}) => await invoke('stop', args) as StopResult
  const capture = async (args = {}) => await invoke('capture', args) as CaptureResult
  const refresh = async (args = {}) => await invoke('refresh', args) as RefreshResult
  const open = async (args = {}) => await invoke('open', args) as OpenResult
  const writeScenario = async (args = {}) => await invoke('write_scenario', args) as WriteScenarioResult
  async function ready(id = 'first', root = workspace) {
    for (let i = 0; i < 200; i++) {
      const value = (await client.status(root, 'A', id)).previews?.[0]
      if (value?.state === 'reachable' && value.url) return value
      assert.ok(!value || !['failed', 'cleanup_failed'].includes(value.state))
      await delay(10)
    }
    throw new Error('Preview did not become reachable')
  }
  async function start(id = 'first', root = workspace) {
    await client.start(id, plan, root, { ownerSessionId: 'A' })
    return ready(id, root)
  }
  return {
    dir, workspace, dataDir, client, registry, ctx, plan, status, stop, capture, refresh,
    open, writeScenario, ready, start, tools,
    setCaller: (value: PreviewCaller) => { caller = value },
    paths: runnerPaths(dataDir, workspace),
  }
}

test('public open uses real target/planner/Runner facts and identical opens reuse the owned preview', options, async t => {
  const f = await setup(t)
  const result = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' } })
  assert.equal(result.status, 'ok')
  assert.equal(result.preview?.state, 'reachable')
  assert.equal(result.preview.freshness, 'unverified')
  assert.equal(result.preview.readiness.targetMounted.status, 'unverified')
  assert.equal(result.preview.projectId, 'site')
  assert.equal(result.preview.targetId, 'index')
  assert.equal(result.plan, undefined)
  assert.equal((await f.status({ previewId: result.preview.previewId, detail: true })).plan?.adapter.id, 'static')
  assert.ok((await (await fetch(result.preview.url!)).text()).includes('<h1>真实静态样本</h1>'), 'Original page heading must be served; injected document is not printed')
  const repeat = await f.open({ target: { kind: 'file', path: 'public/index.html' } })
  assert.equal(repeat.preview?.previewId, result.preview.previewId)
  assert.equal((await f.status()).previews?.length, 1)
  const switched = await f.open({ projectId: 'site', target: { kind: 'file', path: 'public/second.html' } })
  assert.equal(switched.status, 'ok')
  assert.ok(switched.preview)
  assert.notEqual(switched.preview.previewId, result.preview.previewId)
  assert.equal(switched.diagnostics[0]?.code, 'preview_restarted')
  assert.equal((await f.status({ previewId: result.preview.previewId })).preview?.state, 'stopped')
  assert.deepEqual(await findListeningPids(Number(new URL(result.preview.url!).port)), [])
  f.setCaller({ ownerSessionId: 'B', workspaceRoot: f.workspace })
  // 2026-11-03 决策：另一会话的预览由新会话接管（先按账本完整清理），不再 busy。
  const taken = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' } })
  assert.equal(taken.status, 'ok')
  assert.ok(taken.diagnostics.some(value => value.code === 'preview_taken_over'))
  assert.ok((await f.stop({ all: true })).stopped.every(value => value.state === 'stopped'))
  f.setCaller({ ownerSessionId: 'A', workspaceRoot: f.workspace })
})

test('public static scenario change restarts the preview without manual stop and reports the restart honestly', options, async t => {
  const f = await setup(t)
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, scenarios: { own: { businessPaths: ['/api/**'], http: [{ method: 'GET', path: '/api/value', response: { status: 200, bodyFile: 'reply.json', headers: { 'Content-Type': 'application/json' } } }] }, other: {} } }
  await writeFile(join(f.workspace, 'reply.json'), '{"value":"public static fixture"}')
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const args = { projectId: 'site', target: { kind: 'file', path: 'public/index.html' }, scenario: 'own' }
  const result = await f.open(args)
  assert.equal(result.status, 'ok')
  assert.ok(result.preview?.url)
  assert.equal(result.preview.scenario, 'own')
  assert.equal(result.preview.state, 'reachable')
  const url = new URL('/api/value', result.preview.url)
  assert.deepEqual(await (await fetch(url)).json(), { value: 'public static fixture' })
  assert.equal((await f.open(args)).preview?.previewId, result.preview.previewId)
  const detail = await f.status({ previewId: result.preview.previewId, detail: true })
  assert.ok(detail.plan?.fingerprints.scenario)
  assert.equal(detail.plan.capabilities.scenarioApply.status, 'supported')
  assert.deepEqual(detail.plan.requirements, ['mock-only'])
  // P1-4：未验证的就地场景重置不再阻断切换——自动停旧启新，并如实报告重启语义。
  const switched = await f.open({ ...args, scenario: 'other' })
  assert.equal(switched.status, 'ok')
  assert.ok(switched.preview?.url)
  assert.equal(switched.preview.scenario, 'other')
  assert.notEqual(switched.preview.previewId, result.preview.previewId)
  const restarted = switched.diagnostics.find(value => value.code === 'preview_restarted')
  assert.ok(restarted, 'Scenario switch must surface a preview_restarted diagnostic')
  assert.match(restarted.hint ?? '', /not preserved.*not isolate|not isolate.*not preserved/i, 'Restart hint must state that state is not preserved and identity is not isolated')
  assert.equal((await f.status({ previewId: result.preview.previewId })).preview?.state, 'stopped')
  assert.deepEqual(await findListeningPids(Number(url.port)), [])
  const otherUrl = new URL('/api/value', switched.preview.url)
  assert.equal((await fetch(otherUrl)).status, 404, 'Scenario "other" has no mock for /api/value and must fail unmatched')
  assert.equal((await f.stop({ previewId: switched.preview.previewId })).stopped[0]?.state, 'stopped')
  assert.deepEqual(await findListeningPids(Number(new URL(switched.preview.url).port)), [])
})

test('public attach observes a separate non-Vite process; detach/dispose leave its PID, port and state intact', options, async t => {
  const f = await setup(t)
  const external = await userService(t, f.dir)
  const project = { id: 'existing', root: '.', runtime: { strategy: 'attach', adapter: 'existing-server', requirements: [], origin: external.origin, readiness: { probePath: '/health' } }, targets: [{ id: 'orders', selector: { kind: 'route', path: '/orders/:id#details', params: { id: 'DEMO-101' }, query: { tab: 'active' } } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const before: unknown = await (await fetch(external.origin + '/health')).json()
  const result = await f.open({ projectId: 'existing', target: { kind: 'registered', id: 'orders' } })
  assert.equal(result.status, 'ok')
  assert.ok(result.preview)
  assert.equal(result.preview.state, 'reachable')
  assert.equal(result.preview.strategy, 'attach')
  assert.equal(result.preview.url, external.origin + '/orders/DEMO-101?tab=active#details')
  assert.equal(result.preview.readiness.documentLoaded.status, 'unverified')
  assert.equal(result.preview.readiness.targetMounted.status, 'unverified')
  assert.deepEqual(await (await fetch(external.origin + '/health')).json(), before)
  const html = await (await fetch(result.preview.url)).text()
  assert.ok(!html.includes('data-dsh-preview-bootstrap'), 'The original service response must not be injected')
  const beforeDetach: unknown = await (await fetch(external.origin + '/health')).json()
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
  assert.equal((await f.stop({ previewId: result.preview.previewId })).stopped[0]?.state, 'stopped')
  assert.deepEqual(await (await fetch(external.origin + '/health')).json(), beforeDetach)
  assert.equal(await readProcessStartTime(external.process.pid), external.process.startTime)
  assert.deepEqual(await findListeningPids(Number(new URL(external.origin).port)), [external.process.pid])
  assert.equal((await external.ledger.listByPreview('user-service')).length, 1)
  assert.deepEqual(await f.client.dispose(), { residual: [] })
  assert.equal((await fetch(external.origin + '/health')).status, 200)
})

test('attach monitors service loss without killing or taking ownership of the user process', options, async t => {
  const f = await setup(t)
  const external = await userService(t, f.dir)
  const project = { id: 'existing', root: '.', runtime: { adapter: 'existing-server', requirements: [], origin: external.origin, readiness: { probePath: '/health' } } }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open({ projectId: 'existing', target: { kind: 'url', url: external.origin + '/orders/' } })
  assert.equal(result.status, 'ok')
  assert.ok(result.preview)
  assert.deepEqual(await external.process.stop(), [])
  let actual: StatusResult = { status: 'ok', diagnostics: [] }
  for (let i = 0; i < 200; i++) {
    actual = await f.status({ previewId: result.preview.previewId })
    if (actual.preview?.state === 'failed') break
    await delay(20)
  }
  assert.equal(actual.preview?.state, 'failed')
  assert.equal(actual.preview.url, undefined)
  assert.equal(actual.preview.readiness.serviceReachable.status, 'failed')
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
})

test('attach rejects an unhealthy probe and does not follow even a same-origin redirect', options, async t => {
  const f = await setup(t)
  const external = await userService(t, f.dir)
  const project = { id: 'existing', root: '.', runtime: { adapter: 'existing-server', requirements: [], origin: external.origin, readiness: { probePath: '/' } } }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const before: unknown = await (await fetch(external.origin + '/health')).json()
  const result = await f.open({ projectId: 'existing', target: { kind: 'url', url: external.origin + '/orders/' } })
  assert.equal(result.status, 'error')
  assert.equal(result.preview?.state, 'failed')
  assert.deepEqual(await (await fetch(external.origin + '/health')).json(), before)
  assert.equal(await readProcessStartTime(external.process.pid), external.process.startTime)
  assert.deepEqual(await external.process.stop(), [])
  const unavailable = await f.open({ projectId: 'existing', target: { kind: 'url', url: external.origin + '/orders/' } })
  assert.equal(unavailable.status, 'error')
  assert.equal(unavailable.preview?.state, 'failed')
})

test('no-config public file preview uses the same detected application ID inside the real Runner', options, async t => {
  const f = await setup(t)
  await rm(join(f.workspace, 'page-preview.config.json'))
  const result = await f.open({ target: { kind: 'file', path: 'public/index.html' } })
  assert.equal(result.status, 'ok')
  assert.ok(result.preview)
  assert.ok(result.preview.projectId.startsWith('app-'))
  const detail = await f.status({ previewId: result.preview.previewId, detail: true })
  assert.equal(detail.plan?.selector.kind, 'file')
  assert.equal(detail.plan.selector.path, 'index.html')
  assert.equal(result.preview.state, 'reachable')
  assert.ok((await (await fetch(result.preview.url!)).text()).includes('<h1>真实静态样本</h1>'), 'Original page heading must be served; injected document is not printed')
  assert.equal((await f.stop({ previewId: result.preview.previewId })).stopped[0]?.state, 'stopped')
})

test('missing target, ambiguous application, invalid selector and unknown IDs allocate no Runner', options, async t => {
  const f = await setup(t)
  const selection = await f.open()
  assert.equal(selection.status, 'needs_selection')
  assert.deepEqual(selection.candidates?.[0]?.selector, { kind: 'registered', id: 'index' })
  assert.equal(selection.preview, undefined)
  assert.equal((await f.open({ projectId: 'unknown', target: { kind: 'file', path: 'index.html' } })).status, 'not_found')
  const invalid = await executeTool(f.tools, { callId: ToolCallId('invalid-selector'), name: 'page_preview_open', arguments: { target: { kind: 'file', path: 'public/index.html', id: 'conflicting' } }, signal: AbortSignal.timeout(1000) })
  assert.equal(invalid.isError, true)
  assert.equal((await f.open({ target: { kind: 'file', path: 'public/missing.html' } })).status, 'not_found')
  const projects = ['one', 'two'].map(id => ({ id, root: '.', runtime: { adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'same', selector: { kind: 'file', path: 'public/index.html' } }] }))
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects }))
  const ambiguous = await f.open({ target: { kind: 'registered', id: 'same' } })
  assert.equal(ambiguous.status, 'needs_selection')
  assert.deepEqual(ambiguous.candidates?.map(value => value.projectId), ['one', 'two'])
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('public open preserves constraints, rejects unsupported bindings and does not execute commands', options, async t => {
  const f = await setup(t)
  const args = { projectId: 'site', target: { kind: 'registered', id: 'index' } }
  const relaxed = await f.open({ ...args, requirements: [] })
  assert.equal(relaxed.status, 'needs_configuration')
  assert.equal(relaxed.diagnostics[0]?.code, 'requirement_unsatisfied')
  const isolated = await f.open({ ...args, requirements: ['mock-only', 'isolated-target'] })
  assert.ok(['needs_configuration', 'unsupported'].includes(isolated.status))
  const viewport = await f.open({ ...args, viewport: { width: 800, height: 600 } })
  assert.equal(viewport.status, 'unsupported')
  assert.equal(viewport.diagnostics[0]?.code, 'unsupported_capability')
  assert.equal((await f.open({ ...args, scope: 'component' })).diagnostics[0]?.code, 'unsupported_capability')
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public', env: { SYNTHETIC: 'must-not-echo' }, command: { executable: process.execPath, args: ['-e', 'process.exit(7)'], cwd: '.' } }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const pendingApproval = await f.open(args)
  assert.equal(pendingApproval.status, 'needs_configuration')
  assert.equal(pendingApproval.diagnostics[0]?.code, 'config_changed_needs_approval')
  assert.doesNotMatch(JSON.stringify(pendingApproval), /must-not-echo/)
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('public open refuses broken sources and metadata without a detection fallback', options, async t => {
  const f = await setup(t)
  await writeFile(join(f.workspace, 'page-preview.config.json'), '{invalid')
  assert.equal((await f.open({ target: { kind: 'file', path: 'public/index.html' } })).status, 'needs_configuration')
  await rm(join(f.workspace, 'page-preview.config.json'))
  await writeFile(join(f.workspace, 'package.json'), '{invalid')
  assert.equal((await f.open({ target: { kind: 'file', path: 'public/index.html' } })).status, 'needs_configuration')
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('a Vue entry with registrations asks approval for the generated setup and writes no draft', options, async t => {
  // 2026-11-03（§0.3 第 10 条）：缺 runtime.setup 时自动使用从入口生成的 setup，按执行指纹审批，不写草稿。
  const asked: Array<{ entry: string, hash: string } | undefined> = []
  const f = await setup(t, undefined, { requestApproval: async (_caller, _config, _exec, _previous, generated) => {
    asked.push(generated)
    return { outcome: 'rejected' }
  } })
  const put = async (path: string, content: unknown) => {
    await mkdir(join(f.workspace, path.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(f.workspace, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  await put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5', 'test-ui': '^1' } })
  for (const [name, version] of [['vue', '3.4.27'], ['vite', '5.2.12'], ['@vitejs/plugin-vue', '5.1.4']] as const) {
    await put('node_modules/' + name + '/package.json', { name, version })
  }
  await put('index.html', '<script type="module" src="/src/main.js"></script>')
  await put('src/router.js', 'export default { install() {} }')
  await put('src/main.js', `import { createApp } from 'vue'; import App from './Target.vue'; `
    + `import Kit from 'test-ui'; `
    + `import 'test-ui/index.css'; import router from './router.js'; createApp(App).use(Kit).use(router).mount('#app')`)
  await put('src/Target.vue', '<template><h1>registered</h1></template>')
  const project = { id: 'vue-app', root: '.', runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [] },
    targets: [{ id: 'page', selector: { kind: 'file', path: 'src/Target.vue' } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open({ projectId: 'vue-app', target: { kind: 'file', path: 'src/Target.vue' } })
  assert.equal(result.status, 'needs_configuration')
  assert.equal(asked.length, 1)
  assert.equal(asked[0]?.entry, 'src/main.js', 'the approval names the entry the setup is generated from')
  assert.match(asked[0]?.hash ?? '', /^[0-9a-f]{64}$/)
  assert.equal(result.setupDraft, undefined, 'no draft is returned or written when the generated setup is usable')
  await assert.rejects(stat(join(f.dataDir, 'setup-drafts')), { code: 'ENOENT' })
  assert.doesNotMatch(JSON.stringify(result), /await import/, 'generated source never enters tool output')
  const runners = await createFileLedger(f.paths.control).listByPreview('__runner__')
  assert.deepEqual(runners, [], 'nothing runs before approval')
})

test('writeSetupTo installs the draft into the project; invalid targets get a diagnostic', options, async t => {
  // 写入项目必须经官方确认：测试以合成答复代替用户，并记录每次询问的路径。
  const asked: string[] = []
  let answer: SetupWriteOutcome = 'approved'
  const f = await setup(t, undefined, { requestSetupWrite: async (_caller, _project, file) => {
    asked.push(file)
    return answer
  } })
  // §6.9：writeSetupTo 是调用方显式同意的项目内写入；结果给出 installedTo 与可粘贴的 configSnippet。
  const put = async (path: string, content: unknown) => {
    await mkdir(join(f.workspace, path.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(f.workspace, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  await put('package.json', { dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5', 'test-ui': '^1' } })
  for (const [name, version] of [['vue', '3.4.27'], ['vite', '5.2.12'], ['@vitejs/plugin-vue', '5.1.4']] as const) {
    await put('node_modules/' + name + '/package.json', { name, version })
  }
  await put('index.html', '<script type="module" src="/src/main.js"></script>')
  await put('src/main.js',
    `import { createApp } from 'vue'; import App from './Target.vue'; ` +
    `createApp(App).mount('#app'); import('./lazy.js')`)
  await put('src/Target.vue', '<template><h1>registered</h1></template>')
  const project = {
    id: 'vue-app', root: '.',
    runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [] },
    targets: [{ id: 'page', selector: { kind: 'file', path: 'src/Target.vue' } }],
  }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const target = { kind: 'file', path: 'src/Target.vue' }
  const installed = await f.open({ projectId: 'vue-app', target, writeSetupTo: 'preview/setup.js' })
  assert.equal(installed.status, 'needs_configuration')
  assert.equal(installed.setupDraft?.installedTo, 'preview/setup.js')
  assert.equal(installed.setupDraft?.configSnippet, '"setup": "preview/setup.js"')
  // 项目内文件与数据目录草稿内容一致，且仍然是未执行的草稿。
  const projectFile = join(f.workspace, 'preview', 'setup.js')
  assert.equal(await readFile(projectFile, 'utf8'), await readFile(installed.setupDraft!.path!, 'utf8'))
  // 未给 writeSetupTo 的调用仍只回数据目录路径，同时给出建议的粘贴片段。
  const plain = await f.open({ projectId: 'vue-app', target })
  assert.equal(plain.setupDraft?.installedTo, undefined)
  assert.equal(plain.setupDraft?.configSnippet, '"setup": "preview/setup.js"')
  // 越界目标拒绝写入项目：诊断如实说明，数据目录草稿仍可用。
  for (const bad of ['../escape.js', '/abs/setup.js', 'preview/../../escape.js']) {
    const rejected = await f.open({ projectId: 'vue-app', target, writeSetupTo: bad })
    assert.equal(rejected.status, 'needs_configuration')
    assert.equal(rejected.setupDraft?.installedTo, undefined, bad + ' must not be written into the project')
    assert.ok(rejected.setupDraft?.path, 'the data-dir draft is still available for ' + bad)
    assert.ok(rejected.diagnostics.some(value => value.code === 'config_invalid' && value.message.includes(bad)),
      'writeSetupTo ' + bad + ' must produce a config_invalid diagnostic')
  }
  await assert.rejects(stat(join(dirname(f.workspace), 'escape.js')), { code: 'ENOENT' })
  assert.deepEqual(asked, ['preview/setup.js'], 'only in-root new files reach the approval dialog')
  // 已存在的文件（用户手改过的 setup 或业务源码）绝不覆盖，也不再询问。
  await writeFile(projectFile, '// hand edited\n')
  for (const existing of ['preview/setup.js', 'src/main.js']) {
    const kept = await f.open({ projectId: 'vue-app', target, writeSetupTo: existing })
    assert.equal(kept.setupDraft?.installedTo, undefined, existing + ' must not be overwritten')
    assert.ok(kept.diagnostics.some(value => /already exists/.test(value.message)), existing)
  }
  assert.equal(await readFile(projectFile, 'utf8'), '// hand edited\n')
  assert.match(await readFile(join(f.workspace, 'src/main.js'), 'utf8'), /createApp/)
  assert.equal(asked.length, 1)
  // 用户拒绝/无官方服务时不写入，诊断如实说明。
  answer = 'rejected'
  const rejected = await f.open({ projectId: 'vue-app', target, writeSetupTo: 'preview/other.js' })
  assert.equal(rejected.setupDraft?.installedTo, undefined)
  assert.ok(rejected.diagnostics.some(value => /was rejected; no project file was created/.test(value.message)))
  await assert.rejects(stat(join(f.workspace, 'preview/other.js')), { code: 'ENOENT' })
})

test('writeSetupTo without an official approval service never writes into the project', options, async t => {
  const f = await setup(t)
  await mkdir(join(f.workspace, 'src'), { recursive: true })
  await writeFile(join(f.workspace, 'package.json'),
    JSON.stringify({ dependencies: { vue: '^3', vite: '^5', '@vitejs/plugin-vue': '^5', 'test-ui': '^1' } }))
  for (const [name, version] of [['vue', '3.4.27'], ['vite', '5.2.12'], ['@vitejs/plugin-vue', '5.1.4']] as const) {
    await mkdir(join(f.workspace, 'node_modules', name), { recursive: true })
    await writeFile(join(f.workspace, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  }
  await writeFile(join(f.workspace, 'index.html'), '<script type="module" src="/src/main.js"></script>')
  await writeFile(join(f.workspace, 'src/main.js'),
    `import { createApp } from 'vue'; import App from './Target.vue'; ` +
    `createApp(App).mount('#app'); import('./lazy.js')`)
  await writeFile(join(f.workspace, 'src/Target.vue'), '<template><h1>registered</h1></template>')
  const project = { id: 'vue-app', root: '.', runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [] } }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open({ projectId: 'vue-app', target: { kind: 'file', path: 'src/Target.vue' },
    writeSetupTo: 'preview/setup.js' })
  assert.equal(result.setupDraft?.installedTo, undefined)
  assert.ok(result.diagnostics.some(value => /was unavailable; no project file was created/.test(value.message)))
  await assert.rejects(stat(join(f.workspace, 'preview/setup.js')), { code: 'ENOENT' })
})

test('write_scenario merges a filled scenario after approval; refusal paths never write', options, async t => {
  // 写回必须经官方确认：测试以合成答复代替用户，并记录每次询问的场景名。
  const asked: string[] = []
  let answer: SetupWriteOutcome = 'approved'
  const f = await setup(t, undefined, { requestConfigWrite: async (_caller, _project, scenario) => {
    asked.push(scenario)
    return answer
  } })
  const file = join(f.workspace, 'page-preview.config.json')
  const definition = { businessPaths: ['/api/**'],
    http: [{ method: 'GET', path: '/api/orders', response: { status: 200, body: { ok: true } } }] }

  // 占位标记未替换：不询问、不写。
  const placeholder = await f.writeScenario({ projectId: 'site', scenario: 's', definition: {
    http: [{ method: 'GET', path: '/a', response: { status: 200, body: '__DSH_PREVIEW_FILL_RESPONSE__' } }],
  } })
  assert.equal(placeholder.status, 'error')
  assert.match(placeholder.diagnostics[0]!.message, /placeholder/)
  assert.equal(asked.length, 0)

  // 审批通过：并入既有项目条目，已存在文件先备份可回滚。
  const before = await readFile(file, 'utf8')
  const ok = await f.writeScenario({ projectId: 'site', scenario: 'filled', definition })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.mode, 'merged')
  assert.ok(ok.backup)
  assert.ok(ok.backup!.startsWith(join(f.dataDir, 'config-backups')),
    'the backup lives under the plugin dataDir, not the project: ' + ok.backup)
  assert.equal(await readFile(ok.backup!, 'utf8'), before)
  const merged = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(merged.projects[0].scenarios.filled.http[0].path, '/api/orders')
  assert.deepEqual(asked, ['filled'])

  // 同名场景不覆盖、不再询问；未知项目与非法定义同样拒绝。
  for (const [args, pattern] of [
    [{ projectId: 'site', scenario: 'filled', definition }, /already exists/],
    [{ projectId: 'nope', scenario: 's', definition }, /not found/],
    [{ projectId: 'site', scenario: 's2', definition: { http: [{ response: 200 }] } }, /schema/],
  ] as const) {
    const refused = await f.writeScenario(args)
    assert.equal(refused.status, 'error')
    assert.match(refused.diagnostics[0]!.message, pattern)
  }
  assert.equal(asked.length, 1)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].scenarios.filled !== undefined, true)

  // 审批拒绝/不可用：什么都不写。
  for (const outcome of ['rejected', 'unavailable'] as const) {
    answer = outcome
    const refused = await f.writeScenario({ projectId: 'site', scenario: 'other-' + outcome, definition })
    assert.equal(refused.status, 'error')
    assert.match(refused.diagnostics[0]!.message, new RegExp('was ' + outcome))
  }
  assert.deepEqual(asked, ['filled', 'other-rejected', 'other-unavailable'])
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].scenarios['other-rejected'], undefined)
})

test('write_scenario refuses without a plugin dataDir rather than backing up into the project', options, async t => {
  const f = await setup(t, undefined, { requestConfigWrite: async () => 'approved' }, true)
  const file = join(f.workspace, 'page-preview.config.json')
  const before = await readFile(file, 'utf8')
  const refused = await f.writeScenario({ projectId: 'site', scenario: 'filled', definition: {
    businessPaths: ['/api/**'],
  } })
  assert.equal(refused.status, 'error')
  assert.match(refused.diagnostics[0]!.message, /dataDir/)
  assert.equal(await readFile(file, 'utf8'), before, 'a refused write leaves the file byte-identical')
})

test('write_scenario appends detected projects and never writes without an approval service', options, async t => {
  const f = await setup(t)
  // detected 应用：子目录带 package.json，位于已配置根内也保留 detected 边界。
  await mkdir(join(f.workspace, 'app2'), { recursive: true })
  await writeFile(join(f.workspace, 'app2/package.json'), JSON.stringify({ dependencies: {} }))
  const detectedId = 'app-' + fingerprintJson('app2').slice(0, 24)
  const definition = { businessPaths: ['/api/**'] }
  // 无 requestConfigWrite 选项：unavailable，文件不新增项目条目。
  const refused = await f.writeScenario({ projectId: detectedId, scenario: 's', definition })
  assert.equal(refused.status, 'error')
  assert.match(refused.diagnostics[0]!.message, /unavailable/)
  assert.equal(JSON.parse(await readFile(join(f.workspace, 'page-preview.config.json'), 'utf8')).projects.length, 1)
})

test('public candidate summaries disclose their total and do not open a first match', options, async t => {
  const f = await setup(t)
  const project = { id: 'site', root: '.', runtime: { adapter: 'static', publicRoot: 'public' }, targets: Array.from({ length: 10 }, (_, index) => ({ id: 'page-' + index, selector: { kind: 'file', path: 'public/index.html' } })) }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open()
  assert.equal(result.status, 'needs_selection')
  assert.equal(result.candidates?.length, 3)
  assert.ok(result.diagnostics[0]?.message.includes('3 of 10'))
  const ambiguous = await f.open({ target: { kind: 'file', path: 'public/index.html' } })
  assert.equal(ambiguous.candidates?.length, 3)
  assert.equal(ambiguous.preview, undefined)
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('bounded public open returns the observed pending state and leaves the accepted preview queryable', options, async t => {
  const f = await setup(t, 20)
  const inspect = f.client.inspect.bind(f.client)
  // 只模拟状态投影延迟；受理、资源与后续状态查询仍来自真实 Runner。
  const pending = t.mock.method(f.client, 'inspect', async (...args: Parameters<typeof inspect>) => {
    const actual = await inspect(...args)
    for (const preview of actual.previews) { preview.snapshot.state = 'starting'; delete preview.snapshot.url }
    return actual
  })
  const started = Date.now()
  const result = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' } })
  assert.equal(result.status, 'ok')
  assert.equal(result.preview?.state, 'starting')
  assert.equal(result.preview.url, undefined)
  assert.ok(Date.now() - started < 3000, 'Pending state must not wait for target readiness')
  pending.mock.restore()
  const actual = await f.ready(result.preview.previewId)
  assert.equal(actual.state, 'reachable')
  assert.equal((await f.status({ previewId: result.preview.previewId })).preview?.state, 'reachable')
})

test('cancelling a public open wait keeps accepted ownership available for status and explicit stop', options, async t => {
  const f = await setup(t)
  const controller = new AbortController()
  const inspect = f.client.inspect.bind(f.client)
  let accepted: string | undefined
  const pending = t.mock.method(f.client, 'inspect', async (...args: Parameters<typeof inspect>) => {
    const actual = await inspect(...args)
    for (const preview of actual.previews) {
      accepted = preview.snapshot.previewId
      preview.snapshot.state = 'starting'
      delete preview.snapshot.url
    }
    if (actual.previews.length) setTimeout(() => controller.abort(), 10)
    return actual
  })
  const listener = t.mock.method(f.client, 'onMessage', () => () => {})
  const result = await executeTool(f.tools, { callId: ToolCallId('cancel-open'), name: 'page_preview_open', arguments: { projectId: 'site', target: { kind: 'registered', id: 'index' } }, signal: controller.signal })
  assert.equal(result.isError, true)
  assert.ok(accepted)
  pending.mock.restore()
  listener.mock.restore()
  assert.equal((await f.ready(accepted)).state, 'reachable')
  assert.equal((await f.stop({ previewId: accepted })).stopped[0]?.state, 'stopped')
})

test('public open waits for proven readiness when the plan carries target assertions', options, async t => {
  const f = await setup(t, 5000)
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' }, assertions: [{ kind: 'selector-visible', selector: 'h1' }] }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const started = Date.now()
  const opened = f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' } })
  // 证据只来自目标文档的浏览器报告；在 open 等待期间驱动三层证明。
  let preview: { previewId: string; url: string } | undefined
  for (let i = 0; i < 400 && !preview; i++) {
    const value = (await f.client.inspect(f.workspace, 'A')).previews[0]
    if (value?.snapshot.state === 'reachable' && value.snapshot.url) preview = { previewId: value.snapshot.previewId, url: value.snapshot.url }
    else await delay(10)
  }
  assert.ok(preview, 'Preview must become reachable while open is still waiting')
  const html = await (await fetch(preview.url)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  const report = async (body: unknown) => fetch(new URL('/__dsh_preview/report', preview!.url), { method: 'POST', body: JSON.stringify({ nonce, previewId: preview!.previewId, report: body }) })
  assert.equal((await report({ kind: 'document-loaded', url: preview.url })).status, 204)
  assert.equal((await report({ kind: 'assertions', url: preview.url, results: [true] })).status, 204)
  const result = await opened
  assert.equal(result.status, 'ok')
  assert.equal(result.preview?.state, 'ready')
  assert.ok(Date.now() - started < 5000, 'Proven readiness ends the wait before the window expires')
})

test('public open bounded wait still returns the observed state when readiness stays unproven', options, async t => {
  const f = await setup(t, 300)
  // 断言已配置但没有任何浏览器报告：等待窗口耗尽后如实返回 reachable，不冒充 ready。
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' }, assertions: [{ kind: 'selector-visible', selector: 'h1' }] }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const started = Date.now()
  const result = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' } })
  assert.equal(result.status, 'ok')
  assert.equal(result.preview?.state, 'reachable')
  assert.equal(result.preview.readiness.targetMounted.status, 'unverified')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250 && elapsed < 3000, `Wait must end at the bounded window, got ${elapsed}ms`)
})

test('tool results render a compact summary and diagnostics carry their previewId', options, async t => {
  const f = await setup(t)
  const call = (name: string, args: object) => executeTool(f.tools, { callId: ToolCallId('render-' + name), name: 'page_preview_' + name, arguments: args, signal: AbortSignal.timeout(5000) })
  const opened = await call('open', { projectId: 'site', target: { kind: 'registered', id: 'index' } })
  assert.equal(opened.isError, false)
  const raw: unknown = opened.value
  const value = raw as OpenResult
  const previewId = value.preview!.previewId
  const text = opened.content.map(block => 'text' in block ? block.text : '').join('\n')
  assert.match(text, new RegExp('^status: ok\\npreview ' + previewId + ': state=reachable freshness=unverified url=http://'))
  assert.match(text, / {2}projectId=site targetId=index scope=page strategy=static/)
  assert.match(text, / {2}readiness: service=proven document=unverified target=unverified/)
  assert.ok(!text.includes('"capabilityGaps"'), 'render must not echo raw JSON field names')
  // 目标文档的 runtime-error 报告成为该预览的诊断；status 投影与渲染均带 previewId。
  const html = await (await fetch(value.preview!.url!)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  assert.equal((await fetch(new URL('/__dsh_preview/report', value.preview!.url!), { method: 'POST', body: JSON.stringify({ nonce, previewId, report: { kind: 'runtime-error', message: 'synthetic boom', source: '/app.js' } }) })).status, 204)
  const status = await f.status({ previewId })
  assert.equal(status.diagnostics[0]?.previewId, previewId)
  const rendered = await call('status', { previewId })
  const statusText = rendered.content.map(block => 'text' in block ? block.text : '').join('\n')
  assert.match(statusText, new RegExp('\\[runtime_error/ready\\] ' + previewId + ' Static preview reported a runtime error: synthetic boom \\(/app\\.js\\)'))
  assert.ok(statusText.includes(previewId))
})

test('empty status, unknown IDs and invalid stop requests never allocate a Runner', options, async t => {
  const f = await setup(t)
  assert.deepEqual(await f.status(), { status: 'ok', previews: [], diagnostics: [] })
  assert.equal((await f.status({ previewId: 'unknown' })).status, 'not_found')
  assert.equal((await f.capture({ previewId: 'unknown' })).status, 'not_found')
  assert.deepEqual(await f.stop({ all: true }), { status: 'ok', stopped: [], diagnostics: [] })
  for (const args of [{}, { all: false }, { previewId: '' }, { previewId: 'unknown', all: true }]) {
    const result = await f.stop(args)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.stopped, [])
  }
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('status returns actual readiness, immutable summaries and explicit detail; capture reports unsupported', options, async t => {
  const f = await setup(t)
  const original = await f.start()
  const result = await f.status({ previewId: 'first' })
  assert.equal(result.preview?.url, original.url)
  assert.equal(result.preview?.state, 'reachable')
  assert.equal(result.preview.freshness, 'unverified')
  assert.equal(result.preview.readiness.targetMounted.status, 'unverified')
  assert.equal(result.plan, undefined)
  const detail = await f.status({ previewId: 'first', detail: true })
  assert.deepEqual(detail.plan, f.plan)
  assert.throws(() => { detail.preview!.readiness.targetMounted.status = 'proven' }, TypeError)
  const copy = (await f.client.inspect(f.workspace, 'A', 'first')).previews[0]!
  copy.snapshot.readiness.targetMounted.status = 'proven'
  copy.plan.capabilities.captureCurrentView.status = 'supported'
  assert.equal((await f.status({ previewId: 'first', detail: true })).plan?.capabilities.captureCurrentView.status, 'unknown')
  assert.equal((await f.status()).previews?.[0]?.readiness.targetMounted.status, 'unverified')
  assert.equal((await f.capture({ previewId: 'first' })).status, 'unsupported')
  const mutable = structuredClone(f.plan)
  const reuse = f.client.start('reused', mutable, f.workspace, { ownerSessionId: 'A' })
  mutable.capabilities.captureCurrentView.status = 'supported'
  assert.equal((await reuse).previewId, 'first')
  assert.equal((await f.status({ previewId: 'first', detail: true })).plan?.capabilities.captureCurrentView.status, 'unknown')
  assert.equal((await f.stop({ previewId: 'first' })).stopped[0]?.state, 'stopped')
  assert.equal((await f.stop({ previewId: 'first' })).status, 'ok')
  assert.equal((await f.status({ previewId: 'first' })).preview?.url, undefined)
  assert.deepEqual(await findListeningPids(Number(new URL(original.url!).port)), [])
})

test('status and stop all isolate the owner and workspace; a foreign ID reveals no plan or diagnostics', options, async t => {
  const f = await setup(t)
  const a = await f.start()
  f.setCaller({ ownerSessionId: 'B', workspaceRoot: f.workspace })
  assert.deepEqual((await f.status()).previews, [])
  for (const method of [f.status, f.stop, f.capture]) {
    const result = await method({ previewId: 'first', detail: true })
    assert.equal(result.status, 'not_found')
    assert.deepEqual(result.diagnostics, [])
  }
  assert.deepEqual((await f.stop({ all: true })).stopped, [])
  const other = join(f.dir, 'other')
  await cp(f.workspace, other, { recursive: true })
  const b = await f.start('second', other)
  f.setCaller({ ownerSessionId: 'A', workspaceRoot: other })
  assert.equal((await f.status({ previewId: 'first' })).status, 'not_found')
  assert.deepEqual((await f.stop({ all: true })).stopped.map(value => value.previewId), ['second'])
  assert.deepEqual(await findListeningPids(Number(new URL(b.url!).port)), [])
  assert.ok((await findListeningPids(Number(new URL(a.url!).port))).length > 0)
  f.setCaller({ ownerSessionId: 'A', workspaceRoot: f.workspace })
  assert.equal((await f.stop({ all: true })).stopped[0]?.previewId, 'first')
})

test('page_preview_refresh scopes to the caller preview and reports unsupported honestly', options, async t => {
  const f = await setup(t)
  await f.start()
  // 非法 ID → error；他人预览 → not_found（不泄露存在性）。
  assert.equal((await f.refresh({ previewId: '  ' })).status, 'error')
  f.setCaller({ ownerSessionId: 'B', workspaceRoot: f.workspace })
  assert.equal((await f.refresh({ previewId: 'first' })).status, 'not_found')
  f.setCaller({ ownerSessionId: 'A', workspaceRoot: f.workspace })
  // static 适配器没有 refresh 句柄：如实 unsupported，不静默重启或伪造重载。
  const result = await f.refresh({ previewId: 'first' })
  assert.equal(result.status, 'unsupported')
  assert.ok(result.diagnostics.some(value => value.code === 'unsupported_capability'))
})

test('diagnostics are recent and bounded, with accurate truncation across storage and default output', options, async t => {
  const f = await setup(t)
  const preview = await f.start()
  for (let i = 0; i < 45; i++) assert.equal((await fetch(new URL('/missing-' + i, preview.url))).status, 404)
  let detail: StatusResult = { status: 'ok', diagnostics: [] }
  for (let i = 0; i < 100; i++) {
    detail = await f.status({ previewId: 'first', detail: true })
    if (detail.diagnostics.length + (detail.diagnosticsTruncated ?? 0) === 45) break
    await delay(10)
  }
  assert.equal(detail.diagnostics.length, 32)
  assert.equal(detail.diagnosticsTruncated, 13)
  const summary = await f.status({ previewId: 'first' })
  assert.equal(summary.diagnostics.length, MAX_DIAGNOSTICS)
  assert.equal(summary.diagnosticsTruncated, 45 - MAX_DIAGNOSTICS)
  // §13 第 8 条：被拦截请求转发 method、origin 与 path（query 已去除）。
  assert.equal(summary.diagnostics[0]?.location?.request, 'GET ' + new URL(preview.url!).origin + '/missing-44')
  assert.equal(summary.diagnostics.every(value => value.code === 'unmatched_request'), true)
})

test('status exposes the redacted page-text observation after a browser report', options, async t => {
  const f = await setup(t)
  const preview = await f.start()
  const html = await (await fetch(preview.url!)).text()
  const nonce = /"nonce":"([a-f0-9]+)"/.exec(html)?.[1]
  assert.ok(nonce)
  const origin = new URL(preview.url!).origin
  const report = await fetch(origin + '/__dsh_preview/report', { method: 'POST', body: JSON.stringify({ nonce, previewId: 'first', report: { kind: 'page-text', url: preview.url, text: '订单列表 synthetic-value ' + nonce, truncated: false } }) })
  assert.equal(report.status, 204)
  let status: StatusResult = { status: 'ok', diagnostics: [] }
  for (let i = 0; i < 100; i++) {
    status = await f.status({ previewId: 'first' })
    if (status.pageText) break
    await delay(10)
  }
  assert.equal(status.pageText?.text, '订单列表 synthetic-value [redacted]')
  assert.equal(status.pageText?.truncated, false)
  assert.equal(status.pageText?.url, preview.url)
  // pageText 只是观察：不改变 readiness 与 freshness 语义。
  assert.equal(status.preview?.state, 'reachable')
  assert.equal(status.preview?.readiness.targetMounted.status, 'unverified')
})

test('default status lists the last three owned previews; older IDs remain readable and stop all covers the history', options, async t => {
  const f = await setup(t)
  for (let i = 0; i < 4; i++) {
    const plan = { ...f.plan, selector: { kind: 'route', path: '/index.html', query: { sample: String(i) } } } as const
    await f.client.start('history-' + i, plan, f.workspace, { ownerSessionId: 'A' })
    await f.ready('history-' + i)
  }
  assert.deepEqual((await f.status()).previews?.map(value => value.previewId), ['history-1', 'history-2', 'history-3'])
  assert.equal((await f.status({ previewId: 'history-0' })).preview?.state, 'stopped')
  assert.equal((await f.stop({ all: true })).stopped.length, 4)
})

test('Runner death with persisted resources stays cleanup_failed until an explicit stop verifies removal', options, async t => {
  const f = await setup(t)
  const preview = await f.start()
  const sentinel = join(f.dir, 'owned-sentinel')
  await writeFile(sentinel, 'test-owned')
  const ledger = createFileLedger(f.paths.services)
  await ledger.record({ previewId: 'first', ownerSessionId: 'A', workspaceRoot: f.workspace, resource: { kind: 'path', path: sentinel } })
  const root = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0]
  if (root?.resource.kind !== 'process') throw new Error('Missing Runner ownership record')
  const liveFailure = await f.stop({ previewId: 'first' })
  assert.equal(liveFailure.status, 'error')
  assert.equal(liveFailure.stopped[0]?.state, 'cleanup_failed')
  assert.ok(liveFailure.stopped[0]?.residual?.length)
  const failed = new Promise<void>(resolve => f.client.onMessage(message => { if (message.type === 'state' && message.state === 'cleanup_failed') resolve() }))
  assert.equal(await readProcessStartTime(root.resource.pid), root.resource.startTime)
  process.kill(root.resource.pid, 'SIGKILL')
  await failed
  const observed = await f.status({ previewId: 'first' })
  assert.equal(observed.preview?.state, 'cleanup_failed')
  assert.equal(observed.preview.url, undefined)
  assert.deepEqual(await findListeningPids(Number(new URL(preview.url!).port)), [])
  const incomplete = await f.stop({ previewId: 'first' })
  assert.equal(incomplete.status, 'error')
  assert.equal(incomplete.stopped[0]?.state, 'cleanup_failed')
  assert.ok(incomplete.stopped[0]?.residual?.length)
  assert.equal((await stat(sentinel)).isFile(), true)
  await rm(sentinel)
  assert.equal((await f.stop({ previewId: 'first' })).stopped[0]?.state, 'stopped')
  assert.deepEqual(await ledger.listByPreview('first'), [])
})

test('stop still works after the project directory is removed; transport failure never fabricates stopped', options, async t => {
  const f = await setup(t)
  const preview = await f.start()
  const error = new Error('synthetic-error-do-not-echo')
  const mock = t.mock.method(f.client, 'stop', async () => { throw error })
  const failed = await f.stop({ previewId: 'first' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.stopped[0]?.state, 'reachable')
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-error-do-not-echo/)
  // R4-1：lastError 已移除；意外失败写结构化调试日志（dataDir/logs/host.jsonl），测试改读日志文件。
  const logLine = (await readFile(join(f.dataDir, 'logs', 'host.jsonl'), 'utf8')).trim().split('\n').pop()!
  const logged: { event?: string; error?: { name?: string; message?: string } } = JSON.parse(logLine)
  assert.equal(logged.event, 'tool.failed')
  assert.equal(logged.error?.name, 'Error')
  assert.equal(logged.error?.message, 'synthetic-error-do-not-echo')
  mock.mock.restore()
  await rm(f.workspace, { recursive: true })
  assert.equal((await f.status({ previewId: 'first' })).preview?.state, 'reachable')
  assert.equal((await f.stop({ previewId: 'first' })).stopped[0]?.state, 'stopped')
  assert.deepEqual(await findListeningPids(Number(new URL(preview.url!).port)), [])
})

test('unscoped SDK tool calls require an explicit session workspace and never use the host cwd', options, async t => {
  const f = await setup(t)
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerTools(ctx, new SessionRegistry(f.client))
  t.after(() => { ctx.fiber.dispose() })
  const result = await executeTool(tools, { callId: ToolCallId('no-agent'), name: 'page_preview_status', arguments: {}, signal: AbortSignal.timeout(1000) })
  assert.equal(result.isError, false)
  if (result.isError) throw new Error('Expected a domain error')
  assert.ok(typeof result.value === 'object' && result.value !== null && !Array.isArray(result.value))
  assert.equal(result.value.status, 'needs_configuration')
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('caller resolution uses real SDK session identity and immutable creation cwd, including aliases and missing directories', async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-caller-')))
  const dir = join(temporary, 'workspace')
  await mkdir(dir)
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  t.after(() => { ctx.fiber.dispose() })
  const session = sessions.create(SessionId('actual-owner'), { meta: { cwd: dir } })
  assert.deepEqual(await resolvePreviewCaller(session), { ownerSessionId: 'actual-owner', workspaceRoot: dir })
  const alias = join(temporary, 'alias')
  await symlink(dir, alias)
  assert.equal((await resolvePreviewCaller(sessions.create(SessionId('alias-owner'), { meta: { cwd: alias } }))).workspaceRoot, dir)
  await assert.rejects(resolvePreviewCaller(undefined))
  await assert.rejects(resolvePreviewCaller(sessions.create(SessionId('no-workspace'))))
  await rm(dir, { recursive: true })
  assert.deepEqual(await resolvePreviewCaller(session), { ownerSessionId: 'actual-owner', workspaceRoot: dir })
})

test('visible plans omit execution environment values, preserve internal facts and retain prior truncation counts', options, async t => {
  const f = await setup(t)
  const plan = structuredClone(f.plan)
  plan.process = { kind: 'managed', executable: process.execPath, args: ['do-not-echo-argument'], cwd: f.workspace, env: { SYNTHETIC: 'do-not-echo-value' } }
  const output = visiblePlan(plan)
  assert.doesNotMatch(JSON.stringify(output), /do-not-echo-value|do-not-echo-argument/)
  assert.ok(output.process.kind === 'managed' && output.process.executionDetailsOmitted.includes('args'))
  assert.ok(output.knownDifferences.some(value => value.includes('omitted')))
  assert.ok(plan.process.kind === 'managed' && plan.process.env?.SYNTHETIC === 'do-not-echo-value')
  assert.equal(output.fingerprints.config, plan.fingerprints.config)
  const diagnostics = Array.from({ length: 10 }, () => ({ code: 'runtime_error', phase: 'ready' as const, message: 'Synthetic diagnostic' }))
  assert.equal(truncateDiagnostics({ status: 'ok', diagnostics, diagnosticsTruncated: 7 }).diagnosticsTruncated, 9)
})

test('unexpected Host errors forward their redacted cause instead of a generic message', options, async t => {
  // 2026-11-03 实机：静态预检的 RangeError 曾被吞成 "could not be confirmed"，Agent 无从修复。
  const f = await setup(t)
  const second = new Context()
  new SystemPrompt(second, {})
  const tools = new ToolRuntime(second)
  registerTools(second, new SessionRegistry(f.client, async () => {
    throw new RangeError('Maximum call stack size exceeded in /ws/web/js/vendor.js; Authorization: Bearer abc123')
  }, {}))
  const raw = await executeTool(tools, { callId: ToolCallId('unexpected'), name: 'page_preview_open',
    arguments: { target: { kind: 'file', path: 'public/index.html' } }, signal: AbortSignal.timeout(5000) })
  assert.equal(raw.isError, false)
  if (raw.isError) return
  const value: unknown = raw.value
  const result = value as OpenResult
  assert.equal(result.status, 'error')
  const message = result.diagnostics[0]?.message ?? ''
  assert.match(message, /RangeError: Maximum call stack size exceeded in \/ws\/web\/js\/vendor\.js/)
  assert.doesNotMatch(message, /abc123/, 'auth header values stay redacted')
  assert.match(result.diagnostics[0]?.hint ?? '', /page_preview_status/)
})

test('a missing plugin dataDir is reported as plugin configuration with the exact profile entry', options, async t => {
  // 2026-11-03 实机：profile patch 被改写丢了 dataDir，open 只说「需要批准」却不弹窗，Agent 读源码十分钟。
  const f = await setup(t)
  const project = { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public',
    env: { SYNTHETIC: 'must-not-echo' } },
    targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const second = new Context()
  new SystemPrompt(second, {})
  const tools = new ToolRuntime(second)
  const caller = async () => ({ ownerSessionId: 'A', workspaceRoot: f.workspace })
  registerTools(second, new SessionRegistry(f.client, caller, {
    requestApproval: async () => { throw new Error('must not be asked without a dataDir') },
  }))
  const raw = await executeTool(tools, { callId: ToolCallId('no-datadir'), name: 'page_preview_open',
    arguments: { target: { kind: 'file', path: 'public/index.html' } }, signal: AbortSignal.timeout(5000) })
  assert.equal(raw.isError, false)
  if (raw.isError) return
  const value: unknown = raw.value
  const result = value as OpenResult
  assert.equal(result.status, 'needs_configuration')
  assert.match(result.diagnostics[0]?.message ?? '', /dataDir is not configured/)
  assert.match(result.diagnostics[0]?.hint ?? '', /cordis\.patch\.yml.*id: page-preview.*dataDir/)
  assert.doesNotMatch(JSON.stringify(result), /must-not-echo/)
})

test('a never-policy rejection tells the agent to change the permission preset instead of searching', options,
  async t => {
  const f = await setup(t, undefined, { requestApproval: async () => ({ outcome: 'rejected', policy: 'never' }) })
  const project = { id: 'command', root: '.', runtime: { adapter: 'project-command', strategy: 'project',
    requirements: [], command: { executable: process.execPath, args: ['-e', '0'], cwd: '.' },
    readiness: { probePath: '/health', serviceDeadlineMs: 3000 } },
    targets: [{ id: 'home', selector: { kind: 'route', path: '/' } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open({ projectId: 'command', target: { kind: 'registered', id: 'home' } })
  assert.equal(result.status, 'needs_configuration')
  assert.match(result.diagnostics[0]?.message ?? '', /approval policy of this session is "never"/)
  assert.match(result.diagnostics[0]?.hint ?? '', /\/permission workspace-write/)
})

test('full-access sessions run execution items without a dialog and say so in the result', options, async t => {
  let asked = 0
  const f = await setup(t, undefined, {
    fullAccess: () => true,
    requestApproval: async () => { asked++; return { outcome: 'rejected' } },
  })
  const project = { id: 'command', root: '.', runtime: { adapter: 'project-command', strategy: 'project',
    requirements: [], command: { executable: process.execPath, args: ['-e', '0'], cwd: '.' },
    readiness: { probePath: '/health', serviceDeadlineMs: 1000 } },
    targets: [{ id: 'home', selector: { kind: 'route', path: '/' } }] }
  await writeFile(join(f.workspace, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const result = await f.open({ projectId: 'command', target: { kind: 'registered', id: 'home' } })
  assert.equal(asked, 0, 'no approval dialog under full access')
  assert.equal(result.diagnostics[0]?.code, 'approved_by_permission_preset')
  assert.ok(!result.diagnostics.some(value => value.code === 'config_changed_needs_approval'),
    'the Runner accepted the fingerprint carried by start')
  if (result.preview?.previewId) await f.stop({ previewId: result.preview.previewId })
})

// R3-1（r3-1 测试债 的集成部分）：真实静态预览的未命中汇总——
// detail 给出 unmatched+fixtureDraft（占位标记体），非 detail 只给计数。
test('unmatched requests surface as a draft only with detail, and as a count otherwise', options, async t => {
  const f = await setup(t)
  const configured = {
    schemaVersion: 1,
    projects: [{
      id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' },
      targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }],
      scenarios: { guest: { businessPaths: ['/api/**'], http: [] } },
    }],
  }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify(configured))
  const opened = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' }, scenario: 'guest' })
  assert.equal(opened.status, 'ok')
  const previewId = opened.preview!.previewId
  const missed = await fetch(new URL('/api/orders?page=2&token=secret-value', opened.preview!.url!))
  assert.equal(missed.status, 404)
  // 未命中事件经 RunnerSession 汇总进快照；轮询等待投影可见。
  let detailed: Awaited<ReturnType<typeof f.status>> | undefined
  for (let i = 0; i < 100; i++) {
    detailed = await f.status({ previewId, detail: true })
    if (detailed.unmatched?.entries.length) break
    await delay(20)
  }
  const entry = detailed!.unmatched!.entries[0]!
  assert.equal(entry.method, 'GET')
  assert.equal(entry.path, '/api/orders')
  // query 只留键名；token 值与请求体不进入汇总。
  assert.deepEqual(entry.queryKeys, ['page', 'token'])
  assert.ok(!JSON.stringify(detailed!.unmatched).includes('secret-value'))
  // R6-4：汇总附稳定信号——距最近一次新增未命中键的毫秒数与可执行 hint。
  assert.ok(Number.isFinite(Date.parse(detailed!.unmatched!.lastNewEntryAt!)))
  assert.equal(typeof detailed!.unmatched!.sinceLastNewEntryMs, 'number')
  assert.ok(detailed!.unmatched!.sinceLastNewEntryMs! >= 0)
  assert.match(detailed!.unmatched!.hint ?? '', /page_preview_status/)
  const draft = detailed!.fixtureDraft!
  assert.equal(draft.scenario, 'guest')
  assert.equal(draft.fixtures[0]?.path, '/api/orders')
  assert.equal(draft.fixtures[0]?.response.body, '__DSH_PREVIEW_FILL_RESPONSE__')
  assert.ok(JSON.parse(draft.configSnippet))
  // 非 detail 输出只有计数；没有明细与草稿（默认输出最多一行提示）。
  const plain = await f.status({ previewId })
  assert.equal(plain.preview?.unmatchedCount, 1)
  assert.equal(plain.unmatched, undefined)
  assert.equal(plain.fixtureDraft, undefined)
  assert.equal(plain.plan, undefined)
  assert.equal((await f.stop({ previewId })).status, 'ok')
})

// R6-3：merge 只追加新键、冲突整体拒绝；applyTo 写后走 refresh+scenario。
// static 预览无场景换绑能力：写入照常 ok，applied 如实报 unsupported（就地应用在
// toolchain-scenario.test.mjs 的 Vite worker 链路上验证）。
test('write_scenario merge appends new keys; applyTo reports honest outcomes', options, async t => {
  const f = await setup(t, undefined, { requestConfigWrite: async () => 'approved' })
  const configured = {
    schemaVersion: 1,
    projects: [{
      id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' },
      targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }],
      scenarios: { guest: { businessPaths: ['/api/**'],
        http: [{ method: 'GET', path: '/api/a', response: { status: 200, body: { a: 1 } } }] } },
    }],
  }
  const file = join(f.workspace, 'page-preview.config.json')
  await writeFile(file, JSON.stringify(configured))
  const opened = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' }, scenario: 'guest' })
  assert.equal(opened.status, 'ok')
  const previewId = opened.preview!.previewId
  const base = opened.preview!.url!
  assert.equal((await fetch(new URL('/api/a', base))).status, 200)

  // merge 追加新 fixture 并尝试应用；static 不就地生效但如实报 unsupported。
  const merged = await f.writeScenario({ projectId: 'site', scenario: 'guest', mode: 'merge',
    applyTo: previewId, definition: {
      businessPaths: ['/api/**'],
      http: [{ method: 'GET', path: '/api/b', response: { status: 200, body: { b: 2 } } }],
    } })
  assert.equal(merged.status, 'ok')
  assert.equal(merged.mode, 'merged')
  assert.equal(merged.applied?.previewId, previewId)
  assert.equal(merged.applied?.status, 'unsupported')
  const scenario = JSON.parse(await readFile(file, 'utf8')).projects[0].scenarios.guest
  assert.equal(scenario.http.length, 2)
  assert.deepEqual(scenario.http[0].response.body, { a: 1 })

  // 冲突整体拒绝：重写 /api/a 的键不得悄悄覆盖既有 fixture。
  const conflict = await f.writeScenario({ projectId: 'site', scenario: 'guest', mode: 'merge',
    definition: { http: [{ method: 'GET', path: '/api/a', response: { status: 200, body: { evil: true } } }] } })
  assert.equal(conflict.status, 'error')
  assert.match(conflict.diagnostics[0]!.message, /conflicts on GET  \/api\/a/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].scenarios.guest.http.length, 2)

  // applyTo 指向不属于调用者的预览：写入照常 ok，应用部分如实报错。
  const unowned = await f.writeScenario({ projectId: 'site', scenario: 'guest', mode: 'merge',
    applyTo: 'preview-nonexistent', definition: {
      http: [{ method: 'GET', path: '/api/c', response: { status: 200, body: { c: 3 } } }],
    } })
  assert.equal(unowned.status, 'ok')
  assert.equal(unowned.applied?.status, 'not_found')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].scenarios.guest.http.length, 3)
  await f.stop({ previewId })
})

// R6-F3：hint 按稳定阈值分支——低于 UNMATCHED_SETTLE_MS 建议稍后复查，达到阈值
// 改为可执行的填表+写回步骤（带 mode:'merge' 与 applyTo）。用注入时间源，不真等。
test('unmatched hint switches from re-check to fill-and-write at the settle threshold', options, async t => {
  let now = Date.now()
  const f = await setup(t, undefined, { now: () => now })
  const configured = {
    schemaVersion: 1,
    projects: [{
      id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' },
      targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }],
      scenarios: { guest: { businessPaths: ['/api/**'], http: [] } },
    }],
  }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify(configured))
  const opened = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' }, scenario: 'guest' })
  assert.equal(opened.status, 'ok')
  const previewId = opened.preview!.previewId
  assert.equal((await fetch(new URL('/api/x', opened.preview!.url!))).status, 404)
  let first
  for (let i = 0; i < 100; i++) {
    first = await f.status({ previewId, detail: true })
    if (first.unmatched?.entries.length) break
    await delay(20)
  }
  const lastNew = Date.parse(first!.unmatched!.lastNewEntryAt!)

  now = lastNew + 500
  const soon = await f.status({ previewId, detail: true })
  assert.equal(soon.unmatched!.sinceLastNewEntryMs, 500)
  assert.match(soon.unmatched!.hint!, /page_preview_status again shortly/)

  now = lastNew + 2500
  const settled = await f.status({ previewId, detail: true })
  assert.equal(settled.unmatched!.sinceLastNewEntryMs, 2500)
  assert.match(settled.unmatched!.hint!, /page_preview_write_scenario/)
  assert.match(settled.unmatched!.hint!, /mode 'merge'/)
  assert.ok(settled.unmatched!.hint!.includes("applyTo '" + previewId + "'"))
  await f.stop({ previewId })
})

// R6-1d：status detail 的 fixtureDraft 携带只读识别出的包装线索建议；场景已声明 envelope 时不给。
test('status detail surfaces an envelope hint from interceptor evidence only', options, async t => {
  const f = await setup(t)
  await mkdir(join(f.workspace, 'src'), { recursive: true })
  await writeFile(join(f.workspace, 'src/http.ts'), `export async function send(url) {
  const response = await fetch(url)
  const body = await response.json()
  if (body.code !== 0) throw new Error('business failure: ' + body.msg)
  return body.data
}
`)
  const configured = {
    schemaVersion: 1,
    projects: [{
      id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' },
      targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }],
      scenarios: { guest: { businessPaths: ['/api/**'], http: [] } },
    }],
  }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify(configured))
  const opened = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' }, scenario: 'guest' })
  assert.equal(opened.status, 'ok')
  const previewId = opened.preview!.previewId
  await fetch(new URL('/api/orders', opened.preview!.url!))
  let detailed: Awaited<ReturnType<typeof f.status>> | undefined
  for (let i = 0; i < 100; i++) {
    detailed = await f.status({ previewId, detail: true })
    if (detailed.fixtureDraft) break
    await delay(20)
  }
  const hint = detailed!.fixtureDraft!.envelopeHint
  assert.ok(hint, 'interceptor evidence must produce an envelopeHint')
  assert.deepEqual(hint.template, { code: 0, msg: 'ok', data: '__DSH_PREVIEW_DATA__' })
  assert.ok(hint.evidence.some(value => value.file === 'src/http.ts' && value.snippet.includes('body.code !== 0')))
  assert.ok(!JSON.parse(detailed!.fixtureDraft!.configSnippet).guest.envelope,
    'the hint is only a suggestion and is not written into the snippet')
  await f.stop({ previewId })
})

// R6-2：status detail 的 fixtureDraft 携带按未命中条目收集的调用点上下文；
// 收集只读、有界，失败或触顶产生可见诊断而不阻断 status。
test('status detail surfaces call-site contexts for unmatched entries', options, async t => {
  const f = await setup(t)
  await mkdir(join(f.workspace, 'src'), { recursive: true })
  await writeFile(join(f.workspace, 'src/api.ts'), `export const getOrders = () => getRequest('/api/orders')
`)
  await writeFile(join(f.workspace, 'src/page.ts'), `import { getOrders } from './api'
export const load = async () => {
  const res = await getOrders()
  return res.data.list
}
`)
  const configured = {
    schemaVersion: 1,
    projects: [{
      id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' },
      targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }],
      scenarios: { guest: { businessPaths: ['/api/**'], http: [] } },
    }],
  }
  await writeFile(join(f.workspace, 'page-preview.config.json'), JSON.stringify(configured))
  const opened = await f.open({ projectId: 'site', target: { kind: 'registered', id: 'index' }, scenario: 'guest' })
  assert.equal(opened.status, 'ok')
  const previewId = opened.preview!.previewId
  await fetch(new URL('/api/orders', opened.preview!.url!))
  let detailed: Awaited<ReturnType<typeof f.status>> | undefined
  for (let i = 0; i < 100; i++) {
    detailed = await f.status({ previewId, detail: true })
    if (detailed.fixtureDraft) break
    await delay(20)
  }
  const context = detailed!.fixtureDraft!.contexts?.find(value => value.path === '/api/orders')
  assert.ok(context, 'the unmatched entry must carry a call-site context')
  assert.equal(context.method, 'GET')
  assert.equal(context.requestSites[0]?.file, 'src/api.ts')
  assert.equal(context.requestSites[0]?.match, 'exact')
  assert.match(context.requestSites[0]?.snippet ?? '', /getRequest/)
  const consumer = context.consumers.find(value => value.file === 'src/page.ts')
  assert.deepEqual(consumer?.fields, ['data.list'])
  // typeHint 缺失（无显式注解），但 contexts 字段本身不进响应体。
  assert.equal(context.typeHint, undefined)
  assert.ok(!JSON.stringify(detailed!.fixtureDraft!.fixtures).includes('data.list'),
    'consumer field chains must not leak into fixture bodies')
  await f.stop({ previewId })
})

// R3-5（§9.1）：轮次结束后的触发分发——真实 ImpactService 归属 + 真实 Runner 通知。
// decideTrigger 的纯决策表在 trigger.test.ts；这里验证动作的真实执行与 Host 诊断生命周期。
function impactResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return { candidates: [], omitted: 0, gaps: [], unrelated: [], changes: [], apps: [], degraded: [], ...overrides }
}

test('turn-end analysis notifies the affected owned preview through the real Runner', options, async t => {
  const impact = new ImpactService()
  const f = await setup(t, undefined, { impact, triggerMode: 'smart' })
  const preview = await f.start('first')
  assert.equal(preview.freshness, 'unverified')
  await impact.beginTurn('A', f.workspace)
  await f.registry.onTurnAnalyzed('A', impactResult({
    apps: [{ projectId: 'site', root: '' }],
    changes: [{ path: 'public/index.html', kind: 'modified', origin: 'workspace-observed' }],
  }))
  // inputs-changed 是单向通知：static 句柄无裁量通道，Runner 侧如实记 stale。
  for (let i = 0; i < 200; i++) {
    const value = (await f.client.status(f.workspace, 'A', 'first')).previews?.[0]
    if (value?.freshness === 'stale') return
    await delay(10)
  }
  throw new Error('inputs-changed did not reach the Runner session')
})

test('recommend wakes the panel and auto-open reports an honest unsupported diagnostic', options, async t => {
  const candidate = { projectId: 'site', selector: { kind: 'route', path: '/orders' } as const,
    relation: ['src/orders.ts', 'route /orders'], evidence: 'strong' as const }
  const smartImpact = new ImpactService()
  const smart = await setup(t, undefined, { impact: smartImpact, triggerMode: 'smart' })
  await smartImpact.beginTurn('A', smart.workspace)
  const version = smart.registry.panelChanges(0, AbortSignal.timeout(3000))
  await smart.registry.onTurnAnalyzed('A', impactResult({ candidates: [candidate] }))
  assert.equal(await version, 1, 'recommend must wake the panel')
  const listed = await smart.status()
  assert.ok(!listed.diagnostics.some(item => item.code === 'unsupported_capability'),
    'smart mode must not claim an auto-open attempt')
  // always 模式 + 恰一 strong 候选：决策产出 auto-open，执行层如实 unsupported。
  const alwaysImpact = new ImpactService()
  const always = await setup(t, undefined, { impact: alwaysImpact, triggerMode: 'always' })
  await alwaysImpact.beginTurn('A', always.workspace)
  await always.registry.onTurnAnalyzed('A', impactResult({ candidates: [candidate] }))
  const after = await always.status()
  const diagnostic = after.diagnostics.find(item => item.code === 'unsupported_capability')
  assert.ok(diagnostic !== undefined, 'auto-open intent must surface an unsupported diagnostic')
  assert.ok(diagnostic.hint?.includes('page_preview_open'), diagnostic.hint)
})

test('degraded analysis lands in host diagnostics and is replaced by the next turn', options, async t => {
  const impact = new ImpactService()
  const f = await setup(t, undefined, { impact })
  await impact.beginTurn('A', f.workspace)
  await f.registry.onTurnAnalyzed('A', impactResult({ degraded: ['Baseline creation failed'] }))
  const first = await f.status()
  assert.ok(first.diagnostics.some(item => item.code === 'impact_incomplete'), JSON.stringify(first.diagnostics))
  await f.registry.onTurnAnalyzed('A', impactResult())
  const second = await f.status()
  assert.ok(!second.diagnostics.some(item => item.code === 'impact_incomplete'),
    'the next turn replaces host diagnostics instead of accumulating them')
})

test('a workspace whose runner cannot be inspected stays silent instead of aborting the turn', options, async t => {
  const impact = new ImpactService()
  const f = await setup(t, undefined, { impact })
  const ghost = await realpath(await mkdtemp(join(f.dir, 'ghost-')))
  await impact.beginTurn('B', ghost)
  await rm(ghost, { recursive: true, force: true })
  await f.registry.onTurnAnalyzed('B', impactResult({
    candidates: [{ projectId: 'site', selector: { kind: 'route', path: '/x' },
      relation: ['a.ts'], evidence: 'medium' }],
  }))
  // inspect 失败按"无 owned 预览"处理：recommend 仍唤醒面板，不抛错。
  assert.equal(await f.registry.panelChanges(0, AbortSignal.timeout(3000)), 1)
})

test('trigger: off suppresses every action including inputs-changed', options, async t => {
  const impact = new ImpactService()
  const f = await setup(t, undefined, { impact, triggerMode: 'off' })
  await f.start('first')
  await impact.beginTurn('A', f.workspace)
  // 预览启动本身已推进 panelVersion：先读当前版本再等待下一次变化。
  const current = await f.registry.panelChanges(0, AbortSignal.timeout(500))
  const waiting = f.registry.panelChanges(current ?? 0, AbortSignal.timeout(200))
  await f.registry.onTurnAnalyzed('A', impactResult({
    apps: [{ projectId: 'site', root: '' }],
    changes: [{ path: 'public/index.html', kind: 'modified', origin: 'workspace-observed' }],
    candidates: [{ projectId: 'site', selector: { kind: 'route', path: '/x' }, relation: ['a'], evidence: 'strong' }],
  }))
  assert.equal(await waiting, undefined, 'off mode must not wake the panel')
  await delay(200)
  const value = (await f.client.status(f.workspace, 'A', 'first')).previews?.[0]
  assert.equal(value?.freshness, 'unverified', 'off mode must not deliver inputs-changed')
})
