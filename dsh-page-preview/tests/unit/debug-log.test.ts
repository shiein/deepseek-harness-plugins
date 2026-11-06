/** 结构化调试日志（R4-1，r4-1 测试债）：脱敏、滚动、dataDir 缺失、写失败降级、诊断 hint 带路径。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { createDebugLog, hostLogFile, runnerLogFile, MAX_LOG_BYTES } from '../../src/shared/debug-log.ts'
import type { DebugLog } from '../../src/shared/debug-log.ts'
import { createRedactor, REDACTED } from '../../src/shared/redact.ts'
import { RunnerController } from '../../src/runner/controller.ts'
import { loadWorkspaceProjects } from '../../src/shared/config/projects.ts'
import { collectExecutionItems, executionFingerprint } from '../../src/shared/config/fingerprint.ts'
import { fingerprintJson } from '../../src/shared/fingerprint.ts'
import { adapters } from '../../src/adapters/registry.ts'
import type { Adapter, RunningHandle } from '../../src/adapters/types.ts'

const SECRET = 'sk-synthetic-secret-9x7y'
const NONCE = 'nonce-synthetic-abc123'

async function dir(t: { after(callback: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-debug-log-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

interface LogLine {
  level?: string; scope?: string; event?: string; previewId?: string; code?: string; detail?: string
  error?: { name?: string; message?: string; stack?: string }
}
function entries(file: string) {
  return readFile(file, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line) as LogLine))
}

test('host/runner log paths: absolute dataDir required, runner key is a stable workspace hash', async t => {
  const base = await dir(t)
  assert.equal(hostLogFile(undefined), undefined)
  assert.equal(hostLogFile('relative/path'), undefined)
  assert.equal(hostLogFile(base), join(base, 'logs', 'host.jsonl'))
  const runner = runnerLogFile(base, '/some/workspace')
  assert.match(runner, /\/logs\/runner-[0-9a-f]{16}\.jsonl$/)
  assert.equal(runner, runnerLogFile(base, '/some/workspace'))
  assert.notEqual(runner, runnerLogFile(base, '/other/workspace'))
  assert.notEqual(runner, hostLogFile(base))
})

test('missing dataDir keeps the log a no-op without touching the filesystem', async t => {
  const base = await dir(t)
  const log = createDebugLog(undefined, createRedactor())
  assert.equal(log.file, undefined)
  log.write({ level: 'error', scope: 'host', event: 'tool.failed', detail: 'anything' })
  assert.equal(log.available, true)
  assert.deepEqual(await readdir(base), [])
})

test('secrets and channel nonces never reach the log file', async t => {
  const base = await dir(t)
  const file = join(base, 'logs', 'host.jsonl')
  const redactor = createRedactor({ secrets: [SECRET], channels: [NONCE] })
  const log = createDebugLog(file, redactor)
  const error = new Error('open failed with token ' + SECRET)
  error.stack = 'Error: open failed\n    at open (' + NONCE + '/file.ts:1:1)'
  log.write({ level: 'error', scope: 'host', event: 'tool.failed', detail: 'bearer ' + SECRET,
    previewId: 'p1', code: 'runtime_error', error })
  const raw = await readFile(file, 'utf8')
  assert.doesNotMatch(raw, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(raw, new RegExp(NONCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const line = (await entries(file))[0]
  assert.equal(line?.event, 'tool.failed')
  assert.ok(line.detail?.includes(REDACTED))
  assert.equal(line.error?.name, 'Error')
  assert.ok(line.error?.message?.includes(REDACTED))
  assert.ok(line.error?.stack === undefined || !line.error.stack.includes(NONCE))
})

test('entries serialize every field and non-Error values degrade to a message', async t => {
  const base = await dir(t)
  const file = join(base, 'logs', 'host.jsonl')
  const log = createDebugLog(file, createRedactor())
  log.write({ level: 'warn', scope: 'runner', event: 'runner.exited', previewId: 'p9',
    code: 'runtime_error', error: 'plain string' })
  log.write({ level: 'debug', scope: 'host', event: 'panel.inspect_failed' })
  const lines = await entries(file)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]?.level, 'warn')
  assert.equal(lines[0]?.scope, 'runner')
  assert.equal(lines[0]?.previewId, 'p9')
  assert.equal(lines[0]?.error?.message, 'plain string')
  assert.equal(lines[1]?.error, undefined)
  assert.equal(lines[1]?.code, undefined)
})

test('oversized log rotates once into a single .1 sibling', async t => {
  const base = await dir(t)
  const file = join(base, 'logs', 'host.jsonl')
  await mkdir(join(base, 'logs'), { recursive: true })
  await writeFile(file, 'x'.repeat(MAX_LOG_BYTES))
  const log = createDebugLog(file, createRedactor())
  log.write({ level: 'error', scope: 'host', event: 'first.after.rotation' })
  assert.equal((await readFile(file + '.1', 'utf8'))[0], 'x')
  assert.deepEqual((await entries(file)).map(value => value.event), ['first.after.rotation'])
  // 再次超限仍只有一份 .1：旧备份被替换，不产生 .2。
  await writeFile(file, 'y'.repeat(MAX_LOG_BYTES))
  log.write({ level: 'error', scope: 'host', event: 'second.after.rotation' })
  assert.deepEqual(await readdir(join(base, 'logs')), ['host.jsonl', 'host.jsonl.1'])
  assert.equal((await readFile(file + '.1', 'utf8'))[0], 'y')
  assert.deepEqual((await entries(file)).map(value => value.event), ['second.after.rotation'])
})

test('a write failure degrades to no-op, reports unavailable and never throws', async t => {
  const base = await dir(t)
  const blocker = join(base, 'blocker')
  await writeFile(blocker, 'not a directory')
  const file = join(blocker, 'host.jsonl')
  const log = createDebugLog(file, createRedactor())
  assert.equal(log.available, true)
  log.write({ level: 'error', scope: 'host', event: 'tool.failed' })
  assert.equal(log.available, false)
  assert.ok(!existsSync(file))
  // 失败不传染其他实例；可用实例照常写入。
  const good = createDebugLog(join(base, 'logs', 'host.jsonl'), createRedactor())
  good.write({ level: 'error', scope: 'host', event: 'tool.failed' })
  assert.equal(good.available, true)
  assert.equal((await entries(join(base, 'logs', 'host.jsonl'))).length, 1)
})

test('Runner unexpected failures write the log and surface its path or unavailability in the hint', async t => {
  const base = await dir(t)
  const workspace = join(base, 'workspace')
  const services = join(base, 'services')
  await mkdir(workspace)
  const plain = await RunnerController.create(workspace, join(base, 'plugin'), services, () => undefined)
  const missing = join(base, 'does-not-exist')
  const plan = {} as Parameters<RunnerController['handle']>[0] extends { plan: infer P } ? P : never
  const ack = await plain.handle({ type: 'start', requestId: 'r1', previewId: 'p1', workspaceRoot: missing,
    ownerSessionId: 'A', plan })
  assert.equal(ack?.type, 'ack')
  assert.equal(ack?.result?.status, 'error')
  const diagnostic = ack?.diagnostics?.[0]
  assert.equal(diagnostic?.code, 'runtime_error')
  const logPath = runnerLogFile(join(base, 'plugin'), workspace)
  assert.ok(diagnostic?.hint?.includes('details are in ' + logPath),
    'hint should carry the log path: ' + diagnostic?.hint)
  const lines = await entries(logPath)
  assert.equal(lines.at(-1)?.event, 'command.failed')
  // 注入不可用的日志实例：hint 如实说明日志不可用而不是假装可写。
  const unavailable: DebugLog = { file: '/fake/runner.jsonl', available: false, write: () => undefined }
  const degraded = await RunnerController.create(workspace, join(base, 'plugin2'), services, () => undefined,
    unavailable)
  const ack2 = await degraded.handle({ type: 'start', requestId: 'r2', previewId: 'p2', workspaceRoot: missing,
    ownerSessionId: 'A', plan })
  const diagnostic2 = ack2?.diagnostics?.[0]
  assert.ok(diagnostic2?.hint?.includes('the debug log at /fake/runner.jsonl is unavailable'),
    'hint: ' + diagnostic2?.hint)
})

test('Runner log redacts a start failure carrying env text via the project env source', async t => {
  // 走产品接线：verifyApproval → collectExecutionItems 对缺失 setup 文件抛出带路径的原始 ENOENT；
  // 错误里嵌入的 env 值必须被 start 目标项目的 env 密钥替换，不能落盘。
  const base = await dir(t)
  const workspace = join(base, 'ws')
  await mkdir(workspace)
  const secret = 'tok-runner-x7q9-secretvalue'
  const setup = './setup-' + secret + '.js'
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'app', root: '.', runtime: { adapter: 'static', publicRoot: 'public',
      env: { API_TOKEN: secret }, setup } }] }))
  const dataDir = join(base, 'plugin-runner')
  const controller = await RunnerController.create(workspace, dataDir, join(base, 'services'), () => undefined)
  const plan = { projectId: 'app', adapter: { id: 'static', version: '0' }, strategy: 'static',
    process: { kind: 'in-runner' }, requirements: [], missing: [], fingerprints: { config: 'unused' },
    readiness: {}, capabilities: {}, scenario: undefined } as never
  const ack = await controller.handle({ type: 'start', requestId: 'r1', previewId: 'p1',
    ownerSessionId: 'o1', workspaceRoot: workspace, plan })
  assert.equal(ack?.result?.status, 'error')
  const raw = await readFile(runnerLogFile(dataDir, workspace), 'utf8')
  const line = JSON.parse(raw.trim().split('\n').at(-1)!) as LogLine
  assert.equal(line.event, 'command.failed')
  assert.doesNotMatch(raw, /tok-runner-x7q9-secretvalue/)
  assert.match(line.error?.message ?? '', /ENOENT.*\[redacted\]/)
})

test('Runner log redacts a live session failure with env and channel secrets', async t => {
  // 走产品接线：真实 workspace.open → session.start → handle.refresh 抛出含 env 值与回传 nonce 的
  // 原始错误；可归属条目用该会话密钥（env + channelSecrets），命令 ack 诊断保持通用文案。
  const base = await dir(t)
  const workspace = join(base, 'ws')
  await mkdir(join(workspace, 'public'), { recursive: true })
  const secret = 'tok-live-8d3f-aabb-5566'
  const nonce = 'chan-nonce-0123456789abcdef'
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'app', root: '.', runtime: { adapter: 'static', publicRoot: 'public',
      env: { API_TOKEN: secret } } }] }))
  const dataDir = join(base, 'plugin-live')
  const controller = await RunnerController.create(await realpath(workspace), dataDir,
    join(base, 'services'), () => undefined)
  const workspaceRoot = await realpath(workspace)
  const loaded = await loadWorkspaceProjects(workspaceRoot, undefined, { dataDir })
  const project = loaded[0]!.config.project
  const items = await collectExecutionItems(workspaceRoot, project)
  const approval = { fingerprint: executionFingerprint(items) }
  // 注册表是类型级 readonly；测试期借道原型注入桩适配器，验证会话密钥经真实命令路径到达日志。
  const stub: Adapter = {
    id: 'test-stub', version: '1', strategies: ['isolated'],
    features: { scenarios: false, targetAssertions: false, isolatedTarget: false },
    async probe() { throw new Error('not exercised') },
    async discover() { throw new Error('not exercised') },
    async plan() { throw new Error('not exercised') },
    async start(ctx): Promise<RunningHandle> {
      ctx.emit({ type: 'evidence', layer: 'serviceReachable',
        evidence: { status: 'proven', detail: 'stub listener' } })
      return {
        url: 'http://127.0.0.1:9/',
        channelSecrets: [nonce],
        async refresh() { throw new Error('refresh leaked ' + secret + ' and ' + nonce) },
        async stop() { return { residual: [] } },
      }
    },
  }
  Array.prototype.push.call(adapters, stub)
  t.after(() => {
    const index = adapters.findIndex(value => value.id === 'test-stub')
    if (index >= 0) Array.prototype.splice.call(adapters, index, 1)
  })
  const capability = { status: 'unsupported', source: 'none', reason: 'test' } as const
  const plan = {
    projectId: 'app', targetId: 't', selector: { kind: 'route', path: '/' }, scope: 'page',
    strategy: 'isolated', adapter: { id: 'test-stub', version: '1' }, toolchain: {},
    requirements: [], process: { kind: 'in-runner' },
    readiness: { serviceDeadlineMs: 5000, targetDeadlineMs: 1000 },
    capabilities: { scopes: {}, isolatedRender: capability, scenarioApply: capability,
      scenarioReset: capability,
      refresh: { status: 'supported', source: 'adapter', coverage: ['test'] },
      captureCurrentView: capability, runtimeErrors: capability, readinessAssertion: capability,
      network: [] },
    fingerprints: { config: fingerprintJson(project) }, missing: [], knownDifferences: [],
  } as never
  const started = await controller.handle({ type: 'start', requestId: 'r1', previewId: 'p1',
    ownerSessionId: 'o1', workspaceRoot, plan, approval })
  assert.equal(started?.result?.status, 'ok', JSON.stringify(started?.diagnostics))
  // start 的 ack 在异步 session.start 落定前返回；refresh 需等 handle 挂上（reachable）。
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await controller.handle({ type: 'status', requestId: 'rs' + attempt,
      previewId: 'p1', ownerSessionId: 'o1' })
    const state = status?.result?.previews?.[0]?.state
    if (state === 'reachable' || state === 'ready' || state === 'degraded') break
    assert.ok(attempt < 49, 'preview did not reach a refreshable state: ' + state)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const ack = await controller.handle({ type: 'refresh', requestId: 'r2', previewId: 'p1',
    ownerSessionId: 'o1' })
  assert.equal(ack?.result?.status, 'error')
  const raw = await readFile(runnerLogFile(dataDir, workspaceRoot), 'utf8')
  const line = JSON.parse(raw.trim().split('\n').at(-1)!) as LogLine
  assert.equal(line.event, 'command.failed')
  assert.doesNotMatch(raw, /tok-live-8d3f-aabb-5566/)
  assert.doesNotMatch(raw, /chan-nonce-0123456789abcdef/)
  assert.match(line.error?.message ?? '', /\[redacted\]/)
  for (const diagnostic of ack?.diagnostics ?? []) {
    assert.ok(!diagnostic.message.includes(secret) && !diagnostic.message.includes(nonce))
  }
  await controller.shutdown()
})

test('Host log and unexpected diagnostic redact env and channel secrets', async t => {
  // 走产品接线：channel-secrets 消息经 RunnerClient.emit 进缓存（RunnerConnection 的真实入口），
  // 真实 SessionRegistry.status → caller 解析 → runner.inspect 抛出带 env 值与 nonce 的 TypeError；
  // host.jsonl 与返回给 Agent 的诊断都不得出现两者明文。
  const base = await dir(t)
  const workspace = join(base, 'ws')
  await mkdir(workspace)
  const secret = 'tok-host-55aa-bb22-cc99'
  const nonce = 'chan-nonce-host-8f7e6d5c'
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'app', root: '.', runtime: { adapter: 'static', publicRoot: 'public',
      env: { API_TOKEN: secret } } }] }))
  const dataDir = join(base, 'plugin-host')
  const { SessionRegistry } = await import('../../src/host/session-registry.ts')
  const { RunnerClient } = await import('../../src/host/runner-client.ts')
  const client = new RunnerClient({ dataDir })
  t.after(async () => { assert.deepEqual(await client.dispose(), { residual: [] }) })
  const receiver = client as unknown as { emit(message: unknown): void }
  receiver.emit({ type: 'channel-secrets', previewId: 'p1', secrets: [nonce] })
  assert.deepEqual(client.channelSecrets(), [nonce])
  client.inspect = () => Promise.reject(new TypeError('upstream leaked ' + secret + ' and ' + nonce))
  const workspaceRoot = await realpath(workspace)
  const registry = new SessionRegistry(client,
    () => Promise.resolve({ ownerSessionId: 'o1', workspaceRoot }), { dataDir })
  const exec = { signal: new AbortController().signal } as never
  const result = await registry.status({ previewId: 'p1' }, exec)
  assert.equal(result.status, 'error')
  const message = result.diagnostics?.[0]?.message ?? ''
  assert.match(message, /Preview operation failed unexpectedly: TypeError/)
  assert.ok(!message.includes(secret), 'diagnostic leaked env text: ' + message)
  assert.ok(!message.includes(nonce), 'diagnostic leaked channel nonce: ' + message)
  assert.ok(message.includes(REDACTED))
  const raw = await readFile(join(dataDir, 'logs', 'host.jsonl'), 'utf8')
  const line = JSON.parse(raw.trim().split('\n').at(-1)!) as LogLine
  assert.equal(line.event, 'tool.failed')
  assert.doesNotMatch(raw, /tok-host-55aa-bb22-cc99/)
  assert.doesNotMatch(raw, /chan-nonce-host-8f7e6d5c/)
  assert.match(line.error?.message ?? '', /\[redacted\]/)
})

test('Host unexpected failures append the log path to the runtime_error hint', async t => {
  const base = await dir(t)
  const { SessionRegistry } = await import('../../src/host/session-registry.ts')
  const { RunnerClient } = await import('../../src/host/runner-client.ts')
  const client = new RunnerClient({ dataDir: join(base, 'plugin') })
  t.after(async () => { assert.deepEqual(await client.dispose(), { residual: [] }) })
  // resolveCaller 抛普通 Error 走未分类分支（与 stop 传输失败同一入口，但不需要真实预览）。
  const registry = new SessionRegistry(client, async () => { throw new Error('synthetic-transport-failure') },
    { dataDir: join(base, 'plugin') })
  const result = await registry.status({}, {} as never)
  assert.equal(result.status, 'error')
  const hint = result.diagnostics?.[0]?.hint ?? ''
  const logPath = join(base, 'plugin', 'logs', 'host.jsonl')
  assert.ok(hint.includes('details are in ' + logPath),
    'hint should carry the log path: ' + hint)
  const lines = await entries(logPath)
  assert.equal(lines.at(-1)?.event, 'tool.failed')
  assert.equal(lines.at(-1)?.error?.message, 'synthetic-transport-failure')
  // 日志写不进去时（dataDir 不可创建）：hint 如实声明不可用。
  const blocker = join(base, 'blocker')
  await writeFile(blocker, 'not a directory')
  const unavailable = new SessionRegistry(client, async () => { throw new Error('again') },
    { dataDir: join(blocker, 'nested') })
  const failed = await unavailable.status({}, {} as never)
  assert.equal(failed.status, 'error')
  const blocked = join(blocker, 'nested', 'logs', 'host.jsonl')
  assert.ok(failed.diagnostics?.[0]?.hint?.includes('the debug log at ' + blocked + ' is unavailable'),
    'hint: ' + failed.diagnostics?.[0]?.hint)
})
