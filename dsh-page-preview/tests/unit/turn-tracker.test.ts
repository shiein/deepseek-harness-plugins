/** 轮次跟踪：turn/start/end、tools/result 与 ImpactService 的接线（方案 §5.3、§9.1；R3-4）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { TurnTracker } from '../../src/host/turn-tracker.ts'
import { ImpactService } from '../../src/host/impact-service.ts'
import type { ImpactResult } from '../../src/core/impact/types.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionRegistry } from '../../src/host/session-registry.ts'

const session = (id: string, cwd: unknown) =>
  ({ id, header: { cwd } }) as unknown as Session
const event = (type: string) => ({ type, seq: 0, time: 0, data: {} }) as unknown as SessionEvent

/** 等 analyzeNow 的异步链结算（内部等 baseline promise + diff），有界轮询避免挂死。 */
async function untilSettled(flag: () => boolean) {
  for (let i = 0; i < 50 && !flag(); i++) await new Promise(resolve => setImmediate(resolve))
}

test('turn/start builds a baseline only for absolute workspace cwd', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-turn-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const impact = new ImpactService()
  const analyzed: Array<{ sessionId: string, result: ImpactResult }> = []
  const registry = { onTurnAnalyzed: (sessionId: string, result: ImpactResult) =>
    analyzed.push({ sessionId, result }) } as unknown as SessionRegistry
  const tracker = new TurnTracker(registry, impact, () => root)
  tracker.onSessionEvent(session('s-rel', 'relative/path'), event('turn/start'))
  tracker.onSessionEvent(session('s-rel', 'relative/path'), event('turn/end'))
  await untilSettled(() => analyzed.length === 1)
  assert.ok(analyzed[0]!.result.degraded.some(value => value.includes('No turn baseline')))
  tracker.onSessionEvent(session('s-abs', root), event('turn/start'))
  // beginTurn 是 fire-and-forget；analyzeNow 会等 prepared 就绪，用它结算基线建立。
  await impact.analyzeNow('s-abs')
  await writeFile(join(root, 'a.txt'), 'v1')
  tracker.onSessionEvent(session('s-abs', root), event('turn/end'))
  await untilSettled(() => analyzed.length === 2)
  const last = analyzed[1]!.result
  assert.deepEqual(last.degraded, [])
  assert.ok(last.changes.some(value => value.path === 'a.txt'), JSON.stringify(last.changes))
})

test('tools/result records agent writes only for whitelisted successful calls', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-turn-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const impact = new ImpactService()
  const analyzed: ImpactResult[] = []
  const registry = { onTurnAnalyzed: (_id: string, result: ImpactResult) =>
    analyzed.push(result) } as unknown as SessionRegistry
  const cwd = { current: root as string | undefined }
  const tracker = new TurnTracker(registry, impact, () => cwd.current)
  const self = session('s1', root)
  tracker.onSessionEvent(self, event('turn/start'))
  await impact.analyzeNow('s1')
  const execFor = (tool: string, args: object) =>
    ({ agent: { session: self }, name: tool, arguments: args }) as unknown as Readonly<ToolExecution>
  const resultFor = (meta: object | undefined, isError = false) =>
    ({ meta, isError }) as unknown as Readonly<ToolExecutionResult>
  // 白名单外工具与失败结果都不产生 agent-confirmed。
  await put('a.txt', 'v1')
  tracker.onToolResult(execFor('bash', {}), resultFor(undefined))
  await put('b.txt', 'v1')
  tracker.onToolResult(execFor('write', { file_path: 'b.txt' }), resultFor(undefined, true))
  await put('c.txt', 'v1')
  tracker.onToolResult(execFor('write', { file_path: 'c.txt' }), resultFor({ path: join(root, 'c.txt') }))
  // 没有有效工作目录时整段跳过（exec 级 cwd 缺失）。
  cwd.current = undefined
  await put('d.txt', 'v1')
  tracker.onToolResult(execFor('write', { file_path: 'd.txt' }), resultFor({ path: join(root, 'd.txt') }))
  cwd.current = root
  await new Promise(resolve => setImmediate(resolve)) // 让提取链结算
  tracker.onSessionEvent(self, event('turn/end'))
  await untilSettled(() => analyzed.length === 1)
  const origins = new Map(analyzed[0]!.changes.map(value => [value.path, value.origin]))
  assert.equal(origins.get('a.txt'), 'workspace-observed')
  assert.equal(origins.get('b.txt'), 'workspace-observed')
  assert.equal(origins.get('c.txt'), 'agent-confirmed')
  assert.equal(origins.get('d.txt'), 'workspace-observed')
})
