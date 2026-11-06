/**
 * R6-0 真实特征样本基线（`docs/r6-plan.md` §3 R6-0）：在没有任何 Mock/OpenAPI/响应类型的
 * 样本项目上跑通「无数据 → 报 unmatched」链路——登录与页面接口全部进入未命中清单，
 * 页面落到拦截器错误分支，不伪造任何成功响应。
 * 基线同时为 R6-1/R6-2/R6-3 的样本提供「先请求登录再初始化」的确定性顺序。
 * 需要 headless Chrome + vue3-self-contained 工具链；重量级测试登记在 scripts/test.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createRealTraitsFixture } from '../helpers/real-traits-fixture.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import type { RunningHandle } from '../../src/adapters/types.ts'

const skip = integrationSkip || !chromeAvailable()

const waitFor = async <T>(probe: () => Promise<T | undefined>, label: string): Promise<T> => {
  const start = Date.now()
  while (Date.now() - start < 45000) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(label + ' never appeared in the preview page')
}

test('real-traits baseline: login + page APIs hit unmatched and the page takes the error branch',
  { skip, timeout: 120000 }, async t => {
  const f = await createRealTraitsFixture(modules ?? '')
  let running: RunningHandle | undefined
  t.after(async () => { await running?.stop(); await f.cleanup() })
  running = await vueViteAdapter.start(f.input)
  const chrome = await launchChrome(t)
  await chrome.navigate(running.url)
  await waitFor(async () => {
    const text = await chrome.evaluate(
      'document.querySelector(".load-error") && document.querySelector(".load-error").textContent')
    return typeof text === 'string' && text.includes('load-failed') ? text : undefined
  }, 'the interceptor error branch')

  // 未命中清单包含登录信息接口与页面接口；三元组如实上报。
  const unmatched = f.events
    .filter(value => value.type === 'unmatched')
    .map(value => value.type === 'unmatched' ? value.request.method + ' ' + value.request.path : '')
  assert.ok(unmatched.includes('POST /api/login'), 'login request must be unmatched, got ' + JSON.stringify(unmatched))
  assert.ok(unmatched.includes('GET /api/user/info'), 'user info must be unmatched, got ' + JSON.stringify(unmatched))
  assert.ok(unmatched.includes('GET /api/menu/list'), 'menu list must be unmatched, got ' + JSON.stringify(unmatched))

  // 内联经典脚本保留在预览壳中并已执行。
  assert.equal(await chrome.evaluate('window.__APP_INLINE__ === true'), true,
    'the inline classic script must be kept and executed; console: ' + f.events.length + ' run events')
})

// R6-1e：场景声明 envelope 后 fixture 只写 data，Runner 物化展开为完整包装体，
// 页面越过 `code !== 0` 拦截器进入成功分支；同一批接口在 R6-0 基线上全部 unmatched。
test('real-traits envelope: data-only fixtures cross the interceptor into the success branch',
  { skip, timeout: 120000 }, async t => {
  const f = await createRealTraitsFixture(modules ?? '')
  let running: RunningHandle | undefined
  t.after(async () => { await running?.stop(); await f.cleanup() })
  const project = { ...f.input.config.project, scenarios: { data: {
    businessPaths: ['/api/**'],
    envelope: { template: { code: 0, msg: 'ok', data: '__DSH_PREVIEW_DATA__' } },
    http: [
      { method: 'POST', path: '/api/login', response: { status: 200, body: { token: 'preview' } } },
      { method: 'GET', path: '/api/user/info', response: { status: 200, body: { name: 'Ada', roles: ['admin'] } } },
      { method: 'GET', path: '/api/menu/list', response: { status: 200, body: [{ id: 1, title: '概览' }] } },
    ],
  } } }
  const context = { workspaceRoot: f.input.workspaceRoot, appRoot: f.input.appRoot,
    profile: f.input.profile, config: { ...f.input.config, project } }
  const target = { projectId: 'real-traits-app', targetId: 'page', scope: 'page',
    selector: { kind: 'file', path: 'src/views/HomeView.vue' } } as const
  const outcome = await vueViteAdapter.plan(context, target, 'data')
  if (outcome.kind !== 'plan') throw new Error('Envelope plan failed')
  running = await vueViteAdapter.start({ ...f.input, config: context.config, plan: outcome.plan })
  const chrome = await launchChrome(t)
  await chrome.navigate(running.url)
  const heading = await waitFor(async () => {
    const text = await chrome.evaluate('document.querySelector("h1") && document.querySelector("h1").textContent')
    return typeof text === 'string' && text.includes('real-traits Ada') ? text : undefined
  }, 'the success branch heading')
  assert.match(heading, /real-traits Ada/)
  const menu = await chrome.evaluate('document.querySelector("li") && document.querySelector("li").textContent')
  assert.equal(menu, '概览')
  for (const path of ['/api/login', '/api/user/info', '/api/menu/list']) {
    assert.ok(!f.events.some(value => value.type === 'unmatched' && value.request.path === path),
      'a fixture-answered request must not be unmatched: ' + path)
  }
})

// R6-F2 / R6-3c：一轮补数据的端到端证据，走公开工具链（SDK ToolRuntime + SessionRegistry +
// 合成审批答复），不是适配器直连。open → status detail（未命中清单、contexts 指向 API 模块、
// envelopeHint 给出 code:0 建议）→ write_scenario create → write_scenario {merge, applyTo}
// → headless Chrome 进入成功分支显示 fixture 数据，未命中列表清空。证据为 headless Chrome，
// 非 DSH 载体。
test('real-traits one-round fill: status draft → create → merge+applyTo → success branch in Chrome',
  { skip, timeout: 180000 }, async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { SessionId, SessionStore } = await import('@deepseek-ai/dsh-session')
  const { ApprovalService } = await import('@deepseek-ai/dsh-user-approval')
  const { RunnerClient } = await import('../../src/host/runner-client.ts')
  const { SessionRegistry } = await import('../../src/host/session-registry.ts')
  const { requestExecutionApproval } = await import('../../src/host/execution-approval.ts')
  const { registerTools } = await import('../../src/host/tools/index.ts')
  const { writeFile } = await import('node:fs/promises')
  type OpenResult = import('../../src/shared/contracts.ts').OpenResult
  type StatusResult = import('../../src/shared/contracts.ts').StatusResult
  type WriteScenarioResult = import('../../src/shared/contracts.ts').WriteScenarioResult
  type Agent = import('@deepseek-ai/dsh-agent').Agent

  const f = await createRealTraitsFixture(modules ?? '')
  const dataDir = join(f.root, 'plugin')
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  new ApprovalService(ctx, {})
  const session = sessions.create(SessionId('real-traits-e2e'), { meta: { cwd: f.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir,
    requestApproval: (caller, config, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated),
    requestConfigWrite: async () => 'approved' })
  registerTools(ctx, registry)
  let call = 0
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await tools.execute({
      callId: ToolCallId('real-traits-' + ++call), name: 'page_preview_' + name,
      arguments: args, signal: AbortSignal.timeout(30000), agent: agent as unknown as Agent,
    })
    assert.equal(result.isError, false, 'SDK must return a domain result')
    return result.value
  }
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await f.cleanup()
  })

  await writeFile(join(f.root, 'page-preview.config.json'),
    JSON.stringify({ schemaVersion: 1, projects: [f.input.config.project] }))
  ctx.on('approval/request', async () => 'allowed-once')
  const opened = await invoke('open', { projectId: 'real-traits-app',
    target: { kind: 'file', path: 'src/views/HomeView.vue' }, scope: 'page',
    requirements: ['isolated-target'] }) as unknown as OpenResult
  assert.equal(opened.status, 'ok', JSON.stringify(opened))
  const id = opened.preview!.previewId
  const url = opened.preview!.url!

  // 无场景：登录与页面接口全部未命中，页面走拦截器错误分支。
  const chrome = await launchChrome(t)
  await chrome.navigate(url)
  await waitFor(async () => {
    const text = await chrome.evaluate(
      'document.querySelector(".load-error") && document.querySelector(".load-error").textContent')
    return typeof text === 'string' && text.includes('load-failed') ? text : undefined
  }, 'the interceptor error branch')

  const detail = await invoke('status', { previewId: id, detail: true }) as unknown as StatusResult
  const paths = (detail.unmatched?.entries ?? []).map(e => e.method + ' ' + e.path)
  for (const api of ['POST /api/login', 'GET /api/user/info', 'GET /api/menu/list']) {
    assert.ok(paths.includes(api), 'unmatched must list ' + api + ': ' + JSON.stringify(paths))
  }
  // contexts 指到 API 模块；envelopeHint 给出 code:0 包装建议。
  const userCtx = (detail.fixtureDraft?.contexts ?? [])
    .find(c => c.method === 'GET' && c.path === '/api/user/info')
  assert.ok(userCtx?.requestSites.some(s => s.file === 'src/api/user.ts'),
    'contexts must point at the API module: ' + JSON.stringify(detail.fixtureDraft?.contexts))
  const hint = detail.fixtureDraft?.envelopeHint?.template as { code?: number | string } | undefined
  assert.equal(hint?.code, 0,
    'envelopeHint must suggest code:0: ' + JSON.stringify(detail.fixtureDraft?.envelopeHint))
  const envelope = detail.fixtureDraft!.envelopeHint!.template

  // 一轮写回：create（envelope + data-only fixtures）→ merge+applyTo 追加剩余接口。
  const created = await invoke('write_scenario', { projectId: 'real-traits-app', scenario: 'data',
    definition: {
      businessPaths: ['/api/**'], envelope: { template: envelope },
      http: [
        { method: 'POST', path: '/api/login', response: { status: 200, body: { token: 'preview' } } },
        { method: 'GET', path: '/api/user/info', response: { status: 200, body: { name: 'Ada', roles: ['admin'] } } },
      ],
    } }) as unknown as WriteScenarioResult
  assert.equal(created.status, 'ok', JSON.stringify(created))
  const merged = await invoke('write_scenario', { projectId: 'real-traits-app', scenario: 'data',
    mode: 'merge', applyTo: id, definition: {
      http: [{ method: 'GET', path: '/api/menu/list',
        response: { status: 200, body: [{ id: 1, title: '概览' }] } }],
    } }) as unknown as WriteScenarioResult
  assert.equal(merged.status, 'ok', JSON.stringify(merged))
  assert.equal(merged.mode, 'merged')
  assert.equal(merged.applied?.status, 'ok', JSON.stringify(merged.applied))

  // 页面重载后越过 code!==0 拦截器进入成功分支，显示 fixture 数据。
  await chrome.navigate(url)
  const heading = await waitFor(async () => {
    const text = await chrome.evaluate('document.querySelector("h1") && document.querySelector("h1").textContent')
    return typeof text === 'string' && text.includes('real-traits Ada') ? text : undefined
  }, 'the success branch heading after merge+applyTo')
  assert.match(heading, /real-traits Ada/)
  const menu = await chrome.evaluate('document.querySelector("li") && document.querySelector("li").textContent')
  assert.equal(menu, '概览')

  const after = await invoke('status', { previewId: id, detail: true }) as unknown as StatusResult
  assert.equal(after.unmatched?.entries?.length ?? 0, 0,
    'applying the merged scenario clears the unmatched list: ' + JSON.stringify(after.unmatched))
})

test('real-traits fixture file layout follows the trait toggles', { skip: integrationSkip }, async t => {
  const off = await createRealTraitsFixture(modules ?? '', {
    tsEntry: false, regexAlias: false, jsSuffixToTs: false,
    loginBeforeInit: false, inlineScript: false, envelopeInterceptor: false, untypedApi: false,
  })
  t.after(() => off.cleanup())
  await access(join(off.appRoot, 'src/main.js'))
  await access(join(off.appRoot, 'src/request.js'))
  await access(join(off.appRoot, 'src/api/user.js'))
})
