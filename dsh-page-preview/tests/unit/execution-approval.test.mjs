/** 官方 ApprovalService/Session 审计接缝回归（方案 §8）；Agent 身份为最小合成对象，不能代替真实 Agent loop/原生用户 UI 验收。 */
import { installApproval } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ApprovalService, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ExecutionApprovalError, requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { collectExecutionItems, fingerprintExecutionItems } from '../../src/shared/config/fingerprint.ts'

async function setup(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-approval-')))
  const workspace = join(directory, 'workspace')
  const dataDir = join(directory, 'plugin')
  await mkdir(workspace)
  await writeFile(join(workspace, 'setup.js'), 'throw Error("SYNTHETIC_SOURCE_DO_NOT_LOG")')
  const project = { id: 'app', root: '.', runtime: { adapter: 'project-command', strategy: 'project', requirements: [], command: { executable: 'node', args: ['SYNTHETIC_ARGUMENT_DO_NOT_LOG'], cwd: '.' }, env: { PREVIEW: 'SYNTHETIC_ENV_DO_NOT_LOG' }, setup: 'setup.js', readiness: { probePath: '/health', serviceDeadlineMs: 1000 } } }
  const file = join(workspace, 'page-preview.config.json')
  const save = async value => writeFile(file, JSON.stringify({ schemaVersion: 1, projects: [value] }))
  await save(project)
  const config = { source: { kind: 'repo', file }, project, diagnostics: [] }
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const service = await installApproval(ctx, {})
  const session = sessions.create(SessionId('synthetic-approval-user'), { meta: { cwd: workspace } })
  session.append('turn/start', { turn: 1 })
  const controller = new AbortController()
  // 该测试不创建/驱动模型；被测官方 service 仅借用 id/session 进行身份路由与审计。
  const exec = { name: 'page_preview_open', callId: ToolCallId('synthetic-approval-call'), agent: { id: session.id, session }, signal: controller.signal }
  const caller = { workspaceRoot: workspace, ownerSessionId: session.id }
  const ask = (overrides = {}, previous) =>
    requestExecutionApproval(service, dataDir, caller, config, { ...exec, ...overrides }, previous)
  const audits = () => Array.from({ length: session.seq }, (_, index) => session.eventAt(SessionSeq(index))).filter(event => event.type.startsWith('approval/'))
  t.after(async () => { ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { workspace, dataDir, config, project, ctx, service, session, exec, caller, ask, audits, controller, save }
}

test('official allowed-once returns the displayed fingerprint; every later request asks again',
  async t => {
  const f = await setup(t)
  let calls = 0
  f.ctx.on('approval/request', async req => {
    calls++
    assert.ok(req.displayReason.en.includes('SYNTHETIC_ARGUMENT_DO_NOT_LOG'), 'Native UI must show the exact command')
    assert.ok(!req.displayReason.en.includes('SYNTHETIC_ENV_DO_NOT_LOG'), 'Even native prompt omits environment values')
    // 官方 UI 的按钮文案是「允许一次 / Allow once」（dsh-client-ui-approval 0.2.1-rc.5）：
    // 展示文案必须如实说明有效范围：本会话内、执行项不变时有效，变化/换会话/重启再次询问（2026-11-03 决策）。
    assert.ok(req.displayReason.en.includes(
      'stays valid in this DSH session while these execution items are unchanged'))
    assert.ok(req.displayReason.en.includes('another session or a DSH restart asks again'))
    return 'allowed-once'
  })
  const first = await f.ask()
  assert.equal(first.outcome, 'approved')
  const fingerprint = fingerprintExecutionItems(await collectExecutionItems(f.workspace, f.project))
  assert.equal(first.fingerprint, fingerprint, 'the returned fingerprint covers exactly the displayed items')
  assert.ok(Object.keys(first.hashes).includes('command'), 'component hashes travel with the grant for diff display')
  // R2-1：批准不落盘——插件数据目录不出现任何批准记录文件。
  await assert.rejects((await import('node:fs/promises')).stat(join(f.dataDir, 'approvals')), { code: 'ENOENT' })
  // 接缝本身每次调用都询问；是否复用会话级授权由 SessionRegistry 决定。
  assert.equal((await f.ask()).outcome, 'approved')
  assert.equal(calls, 2)
  assert.deepEqual(f.audits().map(event => event.type), ['approval/asked', 'approval/decided', 'approval/asked', 'approval/decided'])
  assert.equal(f.audits()[1].data.outcome, 'allowed-once')
  assert.ok(!JSON.stringify(f.audits()).includes('SYNTHETIC_'), 'Command/env/source values must not enter persistent SDK audits')
})

test('the prompt shows a human-readable change list against the live grant hashes', async t => {
  const f = await setup(t)
  const prompts = []
  const promptsZh = []
  f.ctx.on('approval/request', async req => {
    prompts.push(req.displayReason.en)
    // 官方回退链只查 "zh"/"en" 键：zh 文案必须挂在 zh 键下，而非 zh-CN。
    promptsZh.push(req.displayReason.zh)
    return 'allowed-once'
  })
  // 首次批准：无存活授权可对照，明示全部为新增执行项。
  const first = await f.ask()
  assert.equal(first.outcome, 'approved')
  assert.match(prompts[0], /First approval for this project: every execution item above is new/)
  assert.match(promptsZh[0], /批准在本 DSH 会话内、且这些执行项不变时持续有效/)
  // 只改 setup 文件内容（配置不变）再询问：弹窗用人话说明哪个文件变了。
  await writeFile(join(f.workspace, 'setup.js'), 'throw Error("changed")')
  assert.equal((await f.ask({}, first.hashes)).outcome, 'approved')
  const prompt = prompts[1]
  assert.match(prompt, /- setup file setup\.js changed/, 'The user must see which file changed')
  // 哈希降入详情段：仍有可核对的组件级摘要，但不再是主要信息。
  assert.match(prompt, /Details \(component hashes\):\n- setup: [a-f0-9]{12} -> [a-f0-9]{12}/)
  assert.match(prompt, /Fingerprint: [a-f0-9]{64}/)
  assert.ok(!prompt.includes('SYNTHETIC_ENV_DO_NOT_LOG'), 'Prompt omits env values')
  assert.ok(!prompt.includes('throw Error("changed")'), 'Prompt shows the file path, never file contents')
  assert.ok(!/Changed bindings/.test(prompt))
  // 环境变量绑定变化：名级描述，值永不显示；配置重写后要用一致的内存 config 复核。
  const envProject = { ...f.project, runtime: { ...f.project.runtime, env: { PREVIEW: 'SYNTHETIC_ENV_DO_NOT_LOG', EXTRA: 'other' } } }
  await f.save(envProject)
  const envConfig = { ...f.config, project: envProject }
  const second = await requestExecutionApproval(f.service, f.dataDir, f.caller, envConfig, f.exec, first.hashes)
  assert.equal(second.outcome, 'approved')
  assert.match(prompts[2], /- environment variable set changed/)
  assert.match(prompts[2], /- environment variable EXTRA added \(value is never shown\)/)
  // 记录与上次完全相同时，如实说明无差异而不是罗列哈希。
  await requestExecutionApproval(f.service, f.dataDir, f.caller, envConfig, f.exec, second.hashes)
  assert.match(prompts[3], /- none \(the execution items are identical/)
})

test('official rejection, missing answerer and thrown answerer never generate a grant', async t => {
  const f = await setup(t)
  assert.equal((await f.ask()).outcome, 'unavailable')
  const dispose = f.ctx.on('approval/request', async () => 'rejected')
  assert.equal((await f.ask()).outcome, 'rejected')
  dispose()
  f.ctx.on('approval/request', async () => { throw new Error('SYNTHETIC_PRIVATE_ERROR') })
  assert.equal((await f.ask()).outcome, 'unavailable')
})

test('cancellation discards a late allowed-once answer', async t => {
  const f = await setup(t)
  let reply
  let observed
  const asked = new Promise(resolve => { observed = resolve })
  f.ctx.on('approval/request', async () => { observed(); return await new Promise(resolve => { reply = resolve }) })
  const pending = f.ask()
  await asked
  f.controller.abort()
  assert.equal((await pending).outcome, 'cancelled')
  reply('allowed-once')
})

test('editing execution files or configuration while the user is deciding invalidates the proposal', async t => {
  const f = await setup(t)
  const dispose = f.ctx.on('approval/request', async () => {
    await writeFile(join(f.workspace, 'setup.js'), 'throw Error("changed during confirmation")')
    return 'allowed-once'
  })
  assert.equal((await f.ask()).outcome, 'changed')
  dispose()
  f.ctx.on('approval/request', async () => {
    await f.save({ ...f.project, runtime: { ...f.project.runtime, env: { PREVIEW: 'changed' } } })
    return 'allowed-once'
  })
  assert.equal((await f.ask()).outcome, 'changed')
})

test('missing service/Agent or mismatched identity cannot become user confirmation', async t => {
  const f = await setup(t)
  const noService = await requestExecutionApproval(undefined, f.dataDir, f.caller, f.config, f.exec)
  assert.equal(noService.outcome, 'unavailable')
  assert.equal((await f.ask({ agent: undefined })).outcome, 'unavailable')
  const foreign = await requestExecutionApproval(
    f.service, f.dataDir, { ...f.caller, ownerSessionId: 'different' }, f.config, f.exec)
  assert.equal(foreign.outcome, 'unavailable')
  assert.deepEqual(f.audits(), [])
})

test('SDK requires a live open turn; an idle request cannot persist an unaudited grant', async t => {
  const f = await setup(t)
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.ctx.on('approval/request', async () => 'allowed-once')
  await assert.rejects(f.ask(), error => error instanceof ExecutionApprovalError && error.cause.message.includes('outside an open turn'))
})

test('a failed SDK audit commit after allowed-once cannot become an execution grant', async t => {
  const f = await setup(t)
  f.ctx.on('approval/request', async () => 'allowed-once')
  const append = f.session.append.bind(f.session)
  t.mock.method(f.session, 'append', (type, data) => {
    if (type === 'approval/decided') throw new Error('SYNTHETIC_AUDIT_COMMIT_FAILURE')
    return append(type, data)
  })
  await assert.rejects(f.ask(), ExecutionApprovalError)
})

test('a never-policy session rejection is identified as policy, a user rejection is not', async t => {
  // 2026-11-03 实机：用户切到 Full access（approval: never），每次请求 0.1 秒内被拒，Agent 不知原因读源码五分钟。
  const f = await setup(t)
  const dispose = f.ctx.on('approval/request', async () => 'rejected')
  assert.deepEqual(await f.ask(), { outcome: 'rejected' }, 'an ask-policy rejection is the user decision')
  dispose()
  setApprovalPolicy(f.session, 'never')
  f.ctx.on('approval/request', async () => 'allowed-once')
  assert.deepEqual(await f.ask(), { outcome: 'rejected', policy: 'never' },
    'never rejects before any answerer and is reported as policy, never as a grant')
})
