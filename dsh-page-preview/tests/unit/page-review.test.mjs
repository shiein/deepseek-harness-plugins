/** 原生命令经 DSH command runtime 调度预览；只使用临时源码、模拟轮次驱动与 SDK 审批。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { default as CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { registerPageReviewCommand, resolvePageReviewTarget } from '../../src/host/page-review.ts'
import { installApproval } from '../support/execute-tool.ts'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-command-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, content) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await put('page-preview.config.json', JSON.stringify({ schemaVersion: 1, projects: [
    { id: 'web', root: 'web', runtime: { entry: 'src/main.ts' }, targets: [
      { id: 'app-center', selector: { kind: 'file', path: 'src/Apps.vue' } },
    ] },
  ] }))
  await put('web/package.json', JSON.stringify({ dependencies: { vue: '3.4.27', 'vue-router': '4.5.0' } }))
  await put('web/src/main.ts', `import './router.ts'`)
  await put('web/src/router.ts', `import { createRouter } from 'vue-router'
    createRouter({ routes: [{ path: '/apps', meta: { title: '应用中心' }, component: () => import('/@/Apps.vue') }] })`)
  await put('web/tsconfig.json', JSON.stringify({ compilerOptions: {
    paths: { '/@/Apps.vue': true, '/@/*': ['src/*'] },
  } }))
  await put('web/src/Apps.vue', '<template><h1>应用中心</h1></template>')
  return { root, put }
}

test('review resolves Vue route titles and declared paths, IDs, and explicit file paths', async t => {
  const { root } = await setup(t)
  const target = { projectId: 'web', target: { kind: 'file', path: 'src/Apps.vue' } }
  assert.deepEqual(await resolvePageReviewTarget('预览应用中心界面', root), target)
  assert.deepEqual(await resolvePageReviewTarget('/apps', root), target)
  assert.deepEqual(await resolvePageReviewTarget('web:app-center', root), {
    projectId: 'web', target: { kind: 'registered', id: 'app-center' },
  })
  assert.deepEqual(await resolvePageReviewTarget('预览应用中心界面 --scenario ops', root), { ...target, scenario: 'ops' })
  for (const options of [
    '--scenario ops --verify',
    '--verify --scenario ops',
    '--scenario=ops --verify',
  ]) {
    assert.deepEqual(await resolvePageReviewTarget(`预览应用中心界面 ${options}`, root), {
      ...target, scenario: 'ops', waitFor: 'assertions',
    })
  }
  assert.deepEqual(await resolvePageReviewTarget('--verify --scenario=ops /apps', root), {
    ...target, scenario: 'ops', waitFor: 'assertions',
  })
  assert.match(await resolvePageReviewTarget('/apps --scenario', root), /缺少 --scenario/)
  assert.match(await resolvePageReviewTarget('--scenario= /apps', root), /缺少 --scenario/)
  assert.deepEqual(await resolvePageReviewTarget('web/src/Apps.vue', root), {
    target: { kind: 'file', path: 'web/src/Apps.vue' },
  })
  assert.match(await resolvePageReviewTarget('任意未知页面', root), /找不到可静态定位/)
})

test('review resolves React router routes and skips missing scenario value cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-react-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, content) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await put('package.json', JSON.stringify({ dependencies: { react: '18.2.0', 'react-router-dom': '6.22.0' } }))
  await put('src/main.tsx', `import './router'`)
  await put('src/router.tsx', `import { createBrowserRouter } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
export const router = createBrowserRouter([{ path: '/dashboard', element: <Dashboard /> }])`)
  await put('src/pages/Dashboard.tsx', 'export default function Dashboard() { return <main /> }')
  const resolved = await resolvePageReviewTarget('/dashboard --verify', root)
  assert.equal(resolved.waitFor, 'assertions')
  assert.deepEqual(resolved.target, { kind: 'file', path: 'src/pages/Dashboard.tsx' })
})

test('review matches a dynamic Vue page by its unique view header and preserves the scenario', async t => {
  const { root, put } = await setup(t)
  const rolePage = '<!--\r\n  * 角色 管理\r\n  *\r\n-->\r\n<template><RoleList /></template>'
  await put('web/src/views/system/role/index.vue', rolePage)
  await put('web/src/views/system/role/components/role-list/index.vue', rolePage)
  await put('web/src/views/other/Apps.vue', '<!-- 应用中心 --><template><main/></template>')
  assert.deepEqual(await resolvePageReviewTarget('预览角色管理界面 --scenario role', root), {
    projectId: 'web', scenario: 'role', target: { kind: 'file', path: 'src/views/system/role/index.vue' },
  })
  assert.deepEqual(await resolvePageReviewTarget('预览应用中心界面', root), {
    projectId: 'web', target: { kind: 'file', path: 'src/Apps.vue' },
  })
  await put('web/src/views/other/Role.vue', rolePage)
  assert.match(await resolvePageReviewTarget('预览角色管理界面', root), /匹配到多个页面/)
})

test('native review executes exactly one open inside an auditable turn and consumes its model input', async t => {
  const { root } = await setup(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const commands = new CommandRuntime(ctx)
  const sessions = new SessionStore(ctx)
  const session = sessions.create(SessionId('page-review-command-test'), { meta: { cwd: root } })
  await installApproval(ctx, {})
  ctx.on('approval/request', async () => 'allowed-once')
  let idle = Promise.resolve()
  const agent = { id: session.id, ctx, session, whenIdle: () => idle, followup(message) {
    idle = (async () => {
      session.append('turn/start', { turn: 1 })
      const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [message], turn: 1, step: 1,
        modelSelection: { provider: 'fixture', model: 'unused' }, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [message] }))
      assert.deepEqual(decision, { kind: 'enter', messages: [] })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })()
  } }
  const calls = []
  registerPageReviewCommand(ctx, { async open(args, exec) {
    calls.push(args)
    assert.equal(exec.agent, agent)
    assert.equal(await ctx.approval.request({
      agent, callId: exec.callId, toolName: exec.name, signal: exec.signal,
    }), 'allowed-once')
    return {
      status: 'ok', diagnostics: [{ code: 'preview_shown_in_sidebar' }], availableScenarios: ['ops'],
      preview: { strategy: 'isolated', readiness: { targetMounted: { mountSignal: 'observed' } },
        verification: 'pending', startupTiming: { serviceReadyMs: 10, mountFeedbackMs: 20 } },
      timing: { totalMs: 25, preflightMs: 4, runnerRequestMs: 5, readinessWaitMs: 16 },
    }
  } })
  assert.ok(commands.list(agent).some(command => command.name === 'page-review'))
  const outcome = await commands.execute(agent, '/page-review 预览应用中心界面', [], new AbortController().signal)
  assert.equal(outcome?.result.kind, 'success')
  assert.match(outcome.result.text, /页面已在侧边栏挂载/)
  assert.match(outcome.result.text, /Mock 场景 未选择[\s\S]*可用 --scenario[^\n]*ops/)
  assert.match(outcome.result.text, /页面断言验证中/)
  assert.match(outcome.result.text, /预检 4 ms[^\n]*等待反馈 16 ms/)
  assert.match(outcome.result.text, /服务可达 10 ms[^\n]*挂载反馈 20 ms/)
  await idle
  assert.deepEqual(calls, [{ projectId: 'web', target: { kind: 'file', path: 'src/Apps.vue' }, waitFor: 'mount' }])
})

test('native review surfaces diagnostic hint and setupDraft snippet on needs_configuration', async t => {
  const { root } = await setup(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const commands = new CommandRuntime(ctx)
  const sessions = new SessionStore(ctx)
  const session = sessions.create(SessionId('page-review-draft-test'), { meta: { cwd: root } })
  let idle = Promise.resolve()
  const agent = { id: session.id, ctx, session, whenIdle: () => idle, followup(message) {
    idle = (async () => {
      const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [message], turn: 1, step: 1,
        modelSelection: { provider: 'fixture', model: 'unused' }, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [message] }))
      assert.deepEqual(decision, { kind: 'enter', messages: [] })
    })()
  } }
  registerPageReviewCommand(ctx, { async open() {
    return {
      status: 'needs_configuration',
      diagnostics: [{ code: 'config_invalid', phase: 'plan', message: 'Missing setup', hint: 'Add runtime.setup' }],
      setupDraft: { path: '/tmp/preview-setup.ts', configSnippet: 'setup: "preview/setup.ts"',
        thirdParty: [], business: [], unresolved: [] },
    }
  } })
  const outcome = await commands.execute(agent, '/page-review /apps', [], new AbortController().signal)
  assert.equal(outcome?.result.kind, 'error')
  assert.match(outcome.result.text, /建议：Add runtime\.setup/)
  assert.match(outcome.result.text, /Setup 草稿：\/tmp\/preview-setup\.ts/)
  assert.match(outcome.result.text, /配置片段：\nsetup: "preview\/setup\.ts"/)
  await idle
})

test('native review aborts cleanly while waiting in queue without invoking open', async t => {
  const { root } = await setup(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const commands = new CommandRuntime(ctx)
  const sessions = new SessionStore(ctx)
  const session = sessions.create(SessionId('page-review-abort-test'), { meta: { cwd: root } })
  let queued
  const agent = { id: session.id, ctx, session, whenIdle: () => new Promise(() => {}),
    followup(message) { queued = message } }
  let openCalled = false
  registerPageReviewCommand(ctx, { async open() { openCalled = true; return { status: 'ok', diagnostics: [] } } })
  const ac = new AbortController()
  const pendingRun = commands.execute(agent, '/page-review /apps', [], ac.signal)
  assert.ok(queued)
  ac.abort()
  await assert.rejects(pendingRun, { name: 'AbortError' })
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [queued], turn: 1, step: 1,
    modelSelection: { provider: 'fixture', model: 'unused' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [queued] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(openCalled, false)
})
