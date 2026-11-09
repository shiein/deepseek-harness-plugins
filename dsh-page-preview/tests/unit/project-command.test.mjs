/** 公共命令→官方确认接缝→真实 Runner/进程验收（方案 §6.5、§8、§9.2）；合成 Agent 身份/答复，非模型 loop 或原生 UI。 */
import { executeTool, installApproval } from '../support/execute-tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import { requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { collectExecutionItems, fingerprintExecutionItems } from '../../src/shared/config/fingerprint.ts'
import { createFileLedger, readProcessStartTime } from '../../src/shared/runner/ledger.ts'
import { runnerPaths } from '../../src/shared/runner/paths.ts'
import { findFreeLoopbackPort, findListeningPids } from '../../src/shared/runner/port-ownership.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'

// 生命周期实测覆盖 macOS 与 Linux（procfs 归属实现）；其他平台无归属核对实现仍跳过。
const options = { timeout: 20000, skip: !['darwin', 'linux'].includes(process.platform) }
const script = `
import { startDemo } from './server.mjs'
import { writeFile } from 'node:fs/promises'
const { server } = await startDemo()
await writeFile(process.argv[1], JSON.stringify({ pid: process.pid, explicit: process.env.EXPLICIT ?? null, inherited: process.env.DSH_TEST_HOST_ONLY ?? null, args: process.argv.slice(2) }))
console.log('SYNTHETIC_COMMAND_OUTPUT_NOT_FOR_MODEL')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

async function setup(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-command-')))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await cp(new URL('../fixtures/non-vite-existing-server/', import.meta.url), workspace, { recursive: true })
  const trace = join(directory, 'trace.json')
  const dataDir = join(directory, 'plugin')
  const project = { id: 'command', root: '.', runtime: { adapter: 'project-command', strategy: 'project', requirements: [], command: { executable: process.execPath, args: ['--input-type=module', '-e', script, trace, '$(literal-argument)'], cwd: '.' }, env: { EXPLICIT: 'provided' }, readiness: { probePath: '/health', serviceDeadlineMs: 3000 } }, targets: [{ id: 'orders', selector: { kind: 'route', path: '/orders/:id#detail', params: { id: 'DEMO-101' }, query: { tab: 'active' } } }] }
  const save = async value => writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [value] }))
  await save(project)
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  await installApproval(ctx, {})
  const session = sessions.create(SessionId('command-user'), { meta: { cwd: workspace } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir,
    requestApproval: (caller, config, exec, previous) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous),
  })
  registerTools(ctx, registry)
  let call = 0
  const execute = (name, args = {}, signal = AbortSignal.timeout(10000), ownerSessionId = undefined) => {
    const selected = ownerSessionId === undefined ? agent : (() => {
      const other = sessions.create(SessionId(ownerSessionId), { meta: { cwd: workspace } })
      other.append('turn/start', { turn: 1 })
      return { id: other.id, session: other, ctx, options: {} }
    })()
    return executeTool(tools, { callId: ToolCallId('command-call-' + ++call), name: 'page_preview_' + name, arguments: args, signal, agent: selected })
  }
  const invoke = async (name, args = {}, signal = AbortSignal.timeout(10000), ownerSessionId = undefined) => {
    const result = await execute(name, args, signal, ownerSessionId)
    assert.equal(result.isError, false, 'Expected a domain result from the actual SDK pipeline')
    return result.value
  }
  t.after(async () => {
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, workspace, dataDir, trace, project, save, ctx, session, sessions,
    client, registry, invoke, execute, paths: runnerPaths(dataDir, workspace) }
}
const openArgs = { projectId: 'command', target: { kind: 'registered', id: 'orders' } }

test('public command approval precedes actual process allocation, binds explicit env, reuses the grant and owns stop', options, async t => {
  const f = await setup(t)
  let questions = 0
  f.ctx.on('approval/request', async () => {
    questions++
    if (questions === 1) {
      // 分配前不变量只在首次批准时有意义：链终止后再问时，上一条链的 trace 可能仍存在于磁盘清理前。
      await assert.rejects(stat(f.trace), { code: 'ENOENT' })
      assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
    }
    return 'allowed-once'
  })
  const previous = process.env.DSH_TEST_HOST_ONLY
  process.env.DSH_TEST_HOST_ONLY = 'SYNTHETIC_MUST_NOT_INHERIT'
  t.after(() => { if (previous === undefined) delete process.env.DSH_TEST_HOST_ONLY; else process.env.DSH_TEST_HOST_ONLY = previous })
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  assert.equal(opened.preview.strategy, 'project')
  assert.equal(opened.preview.readiness.targetMounted.status, 'unverified')
  assert.equal(opened.preview.freshness, 'unverified')
  assert.ok(opened.preview.url.endsWith('/orders/DEMO-101?tab=active#detail'))
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  assert.equal(trace.explicit, 'provided')
  assert.equal(trace.inherited, null)
  assert.deepEqual(trace.args, ['$(literal-argument)'])
  const resources = await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId)
  const owned = resources.find(value => value.resource.kind === 'process').resource
  assert.equal(owned.pid, trace.pid)
  assert.equal(await readProcessStartTime(trace.pid), owned.startTime)
  const root = (await createFileLedger(f.paths.control).listByPreview('__runner__'))[0].resource
  assert.notEqual(root.pid, trace.pid)
  const port = Number(new URL(opened.preview.url).port)
  assert.deepEqual(await findListeningPids(port), [trace.pid])
  const detail = await f.invoke('status', { previewId: opened.preview.previewId, detail: true })
  assert.ok(detail.plan.capabilities.network.every(value => value.control === 'none'))
  assert.ok(!JSON.stringify(detail).includes('SYNTHETIC_COMMAND_OUTPUT_NOT_FOR_MODEL'))
  assert.equal(detail.plan.process.env, undefined)
  // 授权链仍存活：相同执行项的再次 open 走链内复用，不重复询问（官方 UI 只有「允许一次」，链内不算新授权）。
  assert.equal((await f.invoke('open', openArgs)).preview.previewId, opened.preview.previewId)
  assert.equal(questions, 1)
  assert.equal((await f.invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
  assert.equal(await readProcessStartTime(trace.pid), undefined)
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(opened.preview.previewId), [])
  // 会话级授权（2026-11-03 决策）：预览停止后同会话、同执行项再次 open 不重复询问。
  const reopened = await f.invoke('open', openArgs)
  assert.equal(reopened.status, 'ok')
  assert.equal(questions, 1)
  assert.notEqual(reopened.preview.previewId, opened.preview.previewId)
  assert.equal((await f.invoke('stop', { previewId: reopened.preview.previewId })).stopped[0].state, 'stopped')
})

test('a same-project target switch never loses the live grant to a dying chain event', options, async t => {
  const f = await setup(t)
  // R2-2 竞态回归：旧预览的 stopped 事件与新 start 并发；一次性授权随 start 消息传递后，
  // 旧链的消费动作不可能使在飞的新启动失效。
  const history = { id: 'history', selector: { kind: 'route', path: '/history' } }
  await f.save({ ...f.project, targets: [...f.project.targets, history] })
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; return 'allowed-once' })
  const first = await f.invoke('open', openArgs)
  assert.equal(first.status, 'ok')
  const second = await f.invoke('open', { ...openArgs, target: { kind: 'registered', id: 'history' } })
  assert.equal(second.status, 'ok')
  assert.notEqual(second.preview.previewId, first.preview.previewId)
  assert.ok(second.diagnostics.some(value => value.code === 'preview_restarted'))
  assert.equal(questions, 1, 'unchanged execution items on a live chain must not re-ask')
  // 会话级授权：全部停止后同会话再次 open 仍复用批准，不重复询问。
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
  const third = await f.invoke('open', openArgs)
  assert.equal(third.status, 'ok')
  assert.equal(questions, 1)
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
})

test('a same-fingerprint switch preserves the approval baseline for the next diff', options, async t => {
  const f = await setup(t)
  // 切换消费掉的授权链在登记处以同指纹重建：差异基线必须仍是首次批准的组件哈希——
  // 移除执行项后提示应出现 removed；空基线只会把全部当前项显示成 added。
  const history = { id: 'history', selector: { kind: 'route', path: '/history' } }
  await f.save({ ...f.project, targets: [...f.project.targets, history] })
  const prompts = []
  let questions = 0
  f.ctx.on('approval/request', async req => {
    questions++
    prompts.push(req.displayReason?.en ?? '')
    return 'allowed-once'
  })
  const first = await f.invoke('open', openArgs)
  assert.equal(first.status, 'ok')
  const second = await f.invoke('open', { ...openArgs, target: { kind: 'registered', id: 'history' } })
  assert.equal(second.status, 'ok')
  assert.equal(questions, 1)
  await f.save({ ...f.project, runtime: { ...f.project.runtime, env: {} }, targets: [...f.project.targets, history] })
  const third = await f.invoke('open', openArgs)
  assert.equal(third.status, 'ok')
  assert.equal(questions, 2)
  assert.match(prompts[1], /environment variable EXPLICIT removed/,
    'the diff after a switch must compare against the released grant baseline')
})

test('no answerer and an explicit rejection never start a command or create a grant', options, async t => {
  const f = await setup(t)
  for (const expected of ['unavailable', 'rejected']) {
    if (expected === 'rejected') f.ctx.on('approval/request', async () => 'rejected')
    const result = await f.invoke('open', openArgs)
    assert.equal(result.status, 'needs_configuration')
    assert.ok(result.diagnostics[0].message.includes(expected))
    assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
    await assert.rejects(stat(f.trace), { code: 'ENOENT' })
  }
})

test('an idle caller exposes an approval-stage error without allocating a Runner or a grant', options, async t => {
  const f = await setup(t)
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.ctx.on('approval/request', async () => 'allowed-once')
  const result = await f.invoke('open', openArgs)
  assert.equal(result.status, 'error')
  assert.equal(result.diagnostics[0].code, 'config_changed_needs_approval')
  assert.equal(result.diagnostics[0].phase, 'config')
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
})

test('changes while the question is open invalidate the displayed approval and allocate no Runner', options, async t => {
  const f = await setup(t)
  f.ctx.on('approval/request', async () => {
    await f.save({ ...f.project, runtime: { ...f.project.runtime, env: { EXPLICIT: 'changed' } } })
    return 'allowed-once'
  })
  const result = await f.invoke('open', openArgs)
  assert.equal(result.status, 'needs_configuration')
  assert.ok(result.diagnostics[0].message.includes('changed'))
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
  await assert.rejects(stat(f.trace), { code: 'ENOENT' })
})

test('a changed command fingerprint asks again and replaces the old owned service in order', options, async t => {
  const f = await setup(t)
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; return 'allowed-once' })
  const first = await f.invoke('open', openArgs)
  assert.equal(first.status, 'ok')
  const original = JSON.parse(await readFile(f.trace, 'utf8'))
  const changed = { ...f.project, runtime: { ...f.project.runtime, env: { EXPLICIT: 'new-value' } } }
  await f.save(changed)
  const second = await f.invoke('open', openArgs)
  assert.equal(second.status, 'ok')
  assert.notEqual(second.preview.previewId, first.preview.previewId)
  assert.equal(second.diagnostics[0].code, 'preview_restarted')
  assert.equal(questions, 2)
  assert.equal(await readProcessStartTime(original.pid), undefined)
  assert.equal(JSON.parse(await readFile(f.trace, 'utf8')).explicit, 'new-value')
  assert.equal((await f.invoke('status', { previewId: first.preview.previewId })).preview.state, 'stopped')
  // 新授权的链存活：同指纹再次 open 复用预览且不再询问。
  const again = await f.invoke('open', openArgs)
  assert.equal(again.preview.previewId, second.preview.previewId)
  assert.equal(questions, 2)
})

test('a configured port owned by an unrelated service is never probed or taken over by a project command', options, async t => {
  const f = await setup(t)
  const external = await spawnManaged({ executable: process.execPath, args: [fileURLToPath(new URL('../fixtures/non-vite-existing-server/server.mjs', import.meta.url))], cwd: f.directory, env: {} }, createFileLedger(join(f.directory, 'external')), { previewId: 'external', ownerSessionId: 'external-user', workspaceRoot: f.directory })
  t.after(async () => { assert.deepEqual(await external.stop(), []) })
  let output = ''
  for await (const chunk of external.stdout) { output += chunk; if (output.includes('\n')) break }
  const { origin } = JSON.parse(output.split('\n')[0])
  await f.save({ ...f.project, runtime: { ...f.project.runtime, origin } })
  f.ctx.on('approval/request', async () => 'allowed-once')
  const result = await f.invoke('open', openArgs)
  assert.equal(result.status, 'error')
  assert.equal(result.preview.state, 'failed')
  assert.ok(result.diagnostics.some(value => value.code === 'port_conflict'))
  assert.equal(await readProcessStartTime(external.pid), external.startTime)
  assert.deepEqual(await findListeningPids(Number(new URL(origin).port)), [external.pid])
  assert.equal((await fetch(origin + '/health')).status, 200)
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
})

test('startup deadline and early command failure clean owned processes and never forward raw output', options, async t => {
  const f = await setup(t)
  f.ctx.on('approval/request', async () => 'allowed-once')
  for (const source of ['console.error("SYNTHETIC_PRIVATE_STDERR");process.exit(7)', 'setInterval(()=>{},1000)']) {
    const project = { ...f.project, runtime: { ...f.project.runtime, command: { executable: process.execPath, args: ['-e', source], cwd: '.' }, readiness: { probePath: '/health', serviceDeadlineMs: 250 } } }
    await f.save(project)
    const result = await f.invoke('open', openArgs)
    assert.equal(result.status, 'error')
    assert.equal(result.preview.state, 'failed')
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_STDERR'))
    assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
  }
})

test('a foreign session takes over the workspace preview after cleaning it up', options, async t => {
  // 2026-11-03 Aesc 决策：另一 DSH 会话（如被中止的旧会话）的预览不再锁住工作区；先按账本清理再接管。
  const f = await setup(t)
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; return 'allowed-once' })
  const opened = await f.invoke('open', openArgs)
  assert.equal(opened.status, 'ok')
  const port = Number(new URL(opened.preview.url).port)
  const taken = await f.invoke('open', openArgs, undefined, 'other-user')
  assert.equal(taken.status, 'ok')
  assert.notEqual(taken.preview.previewId, opened.preview.previewId)
  assert.ok(taken.diagnostics.some(value => value.code === 'preview_taken_over'
    && value.message.includes(opened.preview.previewId)))
  assert.equal(questions, 2, 'the other session still needs its own approval')
  const status = await f.invoke('status', { previewId: opened.preview.previewId })
  assert.equal(status.preview.state, 'stopped', 'the previous owner sees its preview as stopped')
  assert.deepEqual(await findListeningPids(port), [], 'the previous owner process and port were released')
  assert.equal((await f.client.stop(taken.preview.previewId, 'other-user')).status, 'ok')
})

test('an already approved plan is still refused in Runner after configuration changes', options, async t => {
  const f = await setup(t)
  f.ctx.on('approval/request', async () => 'allowed-once')
  const first = await f.invoke('open', openArgs)
  const accepted = (await f.client.inspect(f.workspace, 'command-user', first.preview.previewId)).previews[0].plan
  await f.invoke('stop', { all: true })
  const plan = structuredClone(accepted)
  await f.save({ ...f.project, runtime: { ...f.project.runtime, env: { EXPLICIT: 'not-approved' } } })
  await assert.rejects(
    f.client.start('stale-plan', plan, f.workspace, { ownerSessionId: 'command-user' }),
    error => error.diagnostics?.some(value => value.code === 'config_changed_needs_approval'))
  const renamed = { ...f.project, targets: [...f.project.targets, { id: 'another', selector: { kind: 'route', path: '/orders/' } }] }
  await f.save(renamed)
  // 一次性批准不落盘（R2-1）：为到达更深的 config 指纹核对，start 消息直接携带当前执行项的合成指纹。
  const approvalFingerprint = fingerprintExecutionItems(
    await collectExecutionItems(f.workspace, renamed))
  await assert.rejects(
    f.client.start('stale-mapping', plan, f.workspace, { ownerSessionId: 'command-user', approvalFingerprint }),
    error => error.diagnostics?.some(value => value.code === 'config_invalid'))
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview('stale-plan'), [])
})

test('default mock-only cannot be cleared by the caller, and an approved argument cannot mint a grant', options, async t => {
  const f = await setup(t)
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; return 'allowed-once' })
  const { requirements: _requirements, ...runtime } = f.project.runtime
  await f.save({ ...f.project, runtime })
  assert.equal((await f.invoke('open', { ...openArgs, requirements: [] })).status, 'needs_configuration')
  assert.equal((await f.invoke('open', { ...openArgs, approved: true })).status, 'error')
  assert.equal(questions, 0)
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
})

test('cancelling the approval question discards a late grant and never allocates a command', options, async t => {
  const f = await setup(t)
  const controller = new AbortController()
  let reply
  let observed
  const asked = new Promise(resolve => { observed = resolve })
  f.ctx.on('approval/request', async () => { observed(); return await new Promise(resolve => { reply = resolve }) })
  const pending = f.execute('open', openArgs, controller.signal)
  await asked
  controller.abort()
  assert.equal((await pending).isError, true)
  reply('allowed-once')
  assert.deepEqual(await createFileLedger(f.paths.control).listByPreview('__runner__'), [])
  await assert.rejects(stat(f.trace), { code: 'ENOENT' })
})

test('cancelling after command acceptance leaves an owned pending preview findable and explicitly stoppable', options, async t => {
  const f = await setup(t)
  f.ctx.on('approval/request', async () => 'allowed-once')
  const source = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)'
  await f.save({ ...f.project, runtime: { ...f.project.runtime, command: { executable: process.execPath, args: ['-e', source, f.trace], cwd: '.' } } })
  const controller = new AbortController()
  const pending = f.execute('open', openArgs, controller.signal)
  let trace
  for (let i = 0; i < 200; i++) {
    try { trace = JSON.parse(await readFile(f.trace, 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(10)
  }
  assert.ok(trace)
  controller.abort()
  assert.equal((await pending).isError, true)
  const previews = (await f.invoke('status')).previews
  assert.equal(previews.length, 1)
  assert.ok(['preparing', 'starting'].includes(previews[0].state))
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
  assert.equal(await readProcessStartTime(trace.pid), undefined)
})

test('several owned ports require an explicit origin and roll back the entire owned service', options, async t => {
  const f = await setup(t)
  const source = `const http=require('node:http'),fs=require('node:fs');let ready=false;const servers=[1,2].map(()=>http.createServer((q,s)=>{s.writeHead(ready?200:503);s.end()}));Promise.all(servers.map(s=>new Promise(r=>s.listen(0,'127.0.0.1',r)))).then(()=>{ready=true;fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,ports:servers.map(s=>s.address().port)}))});process.on('SIGTERM',()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r)))).then(()=>process.exit(0)))`
  await f.save({ ...f.project, runtime: { ...f.project.runtime, command: { executable: process.execPath, args: ['-e', source, f.trace], cwd: '.' } } })
  f.ctx.on('approval/request', async () => 'allowed-once')
  const result = await f.invoke('open', openArgs)
  assert.equal(result.status, 'error')
  assert.equal(result.preview.state, 'failed')
  assert.ok(result.diagnostics.some(value => value.code === 'ambiguous_target'))
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  assert.equal(await readProcessStartTime(trace.pid), undefined)
  for (const port of trace.ports) assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await createFileLedger(f.paths.services).listByPreview(result.preview.previewId), [])
})

test('an explicit owned origin selects the correct preview when the command also exposes a metrics listener', options, async t => {
  const f = await setup(t)
  const port = await findFreeLoopbackPort()
  const origin = 'http://127.0.0.1:' + port
  const source = `import{startDemo}from'./server.mjs';import{createServer}from'node:http';import{writeFile}from'node:fs/promises';const{server}=await startDemo(Number(process.argv[1]));const metrics=createServer((q,s)=>s.end('metrics'));await new Promise(r=>metrics.listen(0,'127.0.0.1',r));await writeFile(process.argv[2],JSON.stringify({pid:process.pid,ports:[server.address().port,metrics.address().port]}));process.on('SIGTERM',()=>Promise.all([server,metrics].map(s=>new Promise(r=>s.close(r)))).then(()=>process.exit(0)))`
  await f.save({ ...f.project, runtime: { ...f.project.runtime, origin, command: { executable: process.execPath, args: ['--input-type=module', '-e', source, String(port), f.trace], cwd: '.' } } })
  f.ctx.on('approval/request', async () => 'allowed-once')
  const result = await f.invoke('open', openArgs)
  assert.equal(result.status, 'ok')
  assert.equal(result.preview.state, 'reachable')
  assert.ok(result.preview.url.startsWith(origin + '/orders/'))
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  assert.equal((await (await fetch(origin + '/health')).json()).pid, trace.pid)
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
  assert.equal(await readProcessStartTime(trace.pid), undefined)
  for (const listener of trace.ports) assert.deepEqual(await findListeningPids(listener), [])
})

test('session-scoped grants: another session, a rejection or changed items always ask again', options, async t => {
  // 2026-11-03 Aesc 决策：同会话批准一次长期有效，但范围严格限定在本会话 + 同一执行指纹。
  const f = await setup(t)
  const answers = ['allowed-once', 'rejected', 'allowed-once', 'allowed-once']
  let questions = 0
  f.ctx.on('approval/request', async () => { questions++; return answers.shift() })
  const first = await f.invoke('open', openArgs)
  assert.equal(first.status, 'ok')
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
  // 另一个 DSH 会话不能沿用：被询问且这次用户拒绝 → 不启动、也不产生授权。
  const other = await f.invoke('open', openArgs, undefined, 'other-user')
  assert.equal(other.status, 'needs_configuration')
  assert.equal(questions, 2)
  const otherAgain = await f.invoke('open', openArgs, undefined, 'other-user-2')
  assert.equal(otherAgain.status, 'ok')
  assert.equal(questions, 3)
  assert.equal((await f.client.stop(otherAgain.preview.previewId, 'other-user-2')).status, 'ok')
  // 原会话改动执行项（命令参数）后指纹变化：重新询问。
  await f.save({ ...f.project, runtime: { ...f.project.runtime, env: { ...f.project.runtime.env, EXTRA: 'changed' } } })
  const changed = await f.invoke('open', openArgs)
  assert.equal(changed.status, 'ok')
  assert.equal(questions, 4)
  assert.equal((await f.invoke('stop', { all: true })).stopped[0].state, 'stopped')
})

test('panel suggestion open reaches the official approval dialog with the owner session identity', options, async t => {
  // R5-6（D2-b）：面板一键打开复用 openAttempt 全路径——审批接缝收到的是面板所属
  // 会话的真实 Session；拒绝/不可用不启动任何进程，allowed-once 才真正拉起命令。
  const f = await setup(t)
  let answer = 'rejected'
  const asked = []
  const off = f.ctx.on('approval/request', req => {
    asked.push({ tool: req.toolName, session: req.agent?.session?.id })
    return answer
  })
  const request = { projectId: 'command', target: JSON.stringify(openArgs.target) }
  const rejected = await f.registry.panelOpen(f.session, request)
  assert.equal(rejected.status, 'needs_configuration')
  assert.equal(rejected.diagnostics[0]?.code, 'config_changed_needs_approval')
  assert.deepEqual(asked.map(value => value.tool), ['pagePreview/open'])
  await assert.rejects(stat(f.trace), { code: 'ENOENT' })
  answer = 'allowed-once'
  const opened = await f.registry.panelOpen(f.session, request)
  assert.equal(opened.status, 'ok')
  assert.ok(opened.previewId && opened.url)
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  assert.deepEqual(await findListeningPids(Number(new URL(opened.url).port)), [trace.pid])
  // 异属会话：session 是唯一身份源——它以自己的 owner 身份走同一审批与接管链路。
  const foreign = f.sessions.create(SessionId('someone-else'), { meta: { cwd: f.workspace } })
  foreign.append('turn/start', { turn: 1 })
  const foreignOpened = await f.registry.panelOpen(foreign, request)
  assert.equal(foreignOpened.status, 'ok')
  assert.equal(asked.map(value => value.session).join(','), 'command-user,command-user,someone-else')
  assert.ok(foreignOpened.diagnostics.some(value => value.code === 'preview_taken_over'))
  // 无应答者时如实失败：第三个会话拿不到批准，needs_configuration，且不启动进程。
  off()
  const listenerless = f.sessions.create(SessionId('nobody-listening'), { meta: { cwd: f.workspace } })
  listenerless.append('turn/start', { turn: 1 })
  const unavailable = await f.registry.panelOpen(listenerless, request)
  assert.equal(unavailable.status, 'needs_configuration')
  assert.equal(unavailable.diagnostics[0]?.code, 'config_changed_needs_approval')
  assert.equal((await f.invoke('stop', { all: true })).stopped.every(value => value.state === 'stopped'), true)
})

test('panel suggestion open honors the session full-access permission without a dialog', options, async t => {
  const f = await setup(t)
  // 独立 registry 仅改 fullAccess 接缝；requestApproval 设哨兵证明该会话根本不问。
  const registry = new SessionRegistry(f.client, undefined, { dataDir: f.dataDir,
    fullAccess: exec => exec.agent?.session !== undefined,
    requestApproval: async () => { throw new Error('Full-access sessions must not reach the approval dialog') } })
  const opened = await registry.panelOpen(f.session,
    { projectId: 'command', target: JSON.stringify(openArgs.target) })
  assert.equal(opened.status, 'ok')
  assert.equal(opened.diagnostics[0]?.code, 'approved_by_permission_preset')
  assert.ok((await readFile(f.trace, 'utf8')).length > 0)
  assert.equal((await f.invoke('stop', { all: true })).stopped.every(value => value.state === 'stopped'), true)
})

test('panel suggestion open approval waits past 60s and cancels via panel signal or the bound', options, async t => {
  // R5-F5：审批等待不再是固定 60s——面板 signal 取消与 10 分钟兜底合并成 exec.signal。
  // mock 时钟驱动 bound 的 setTimeout；审批应答保持挂起，只观察取消边与最终答复。
  const f = await setup(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const request = { projectId: 'command', target: JSON.stringify(openArgs.target) }
  const seen = []
  const off = f.ctx.on('approval/request', req => {
    seen.push(req.signal)
    return new Promise(() => {}) // 用户不点按钮：等待只由取消边结束。
  })
  const untilAsked = async count => {
    // 每步虚拟推进 10ms × 400 封顶 4s：必须小于下面注入的 5s 上限，否则兜底先到期、
    // 官方服务在 waterfall 之前就把请求判 cancelled，监听器永远收不到 signal。
    for (let i = 0; i < 400 && seen.length < count; i++) {
      t.mock.timers.tick(10)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(seen.length, count, 'the official approval request must have been issued')
  }

  // 默认 10 分钟兜底：61 秒处不打断（旧 60s 行为已移除），600 秒处如实 cancelled。
  const waiting = f.registry.panelOpen(f.session, request)
  await untilAsked(1)
  t.mock.timers.tick(61_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(seen[0].aborted, false, 'a real approval wait must survive past the old 60s mark')
  t.mock.timers.tick(600_000)
  const expired = await waiting
  assert.equal(expired.status, 'needs_configuration')
  assert.match(expired.diagnostics[0]?.message ?? '', /cancelled/,
    'the bound end reports the approval wait as cancelled: ' + JSON.stringify(expired.diagnostics))
  await assert.rejects(stat(f.trace), { code: 'ENOENT' }, 'a cancelled panel open starts no process')

  // 面板侧取消：transport 注入的 signal 与兜底并联，abort 即结束等待。
  const controller = new AbortController()
  const second = f.registry.panelOpen(f.session, request, undefined, controller.signal)
  await untilAsked(2)
  controller.abort()
  const cancelled = await second
  assert.equal(cancelled.status, 'needs_configuration')
  assert.match(cancelled.diagnostics[0]?.message ?? '', /cancelled/)
  await assert.rejects(stat(f.trace), { code: 'ENOENT' })

  // 上限可注入：小 bound 同样如实到期（生产默认 PANEL_OPEN_BOUND_MS=10min）。
  const quick = new SessionRegistry(f.client, undefined, { dataDir: f.dataDir, panelOpenBoundMs: 5_000,
    requestApproval: (caller, config, exec, previous) =>
      requestExecutionApproval(f.ctx.get('approval'), f.dataDir, caller, config, exec, previous) })
  const third = quick.panelOpen(f.session, request)
  await untilAsked(3)
  t.mock.timers.tick(6_000)
  const bounded = await third
  assert.equal(bounded.status, 'needs_configuration')
  assert.match(bounded.diagnostics[0]?.message ?? '', /cancelled/)
  off()
})
