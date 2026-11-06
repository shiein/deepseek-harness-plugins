/**
 * Phase 0 Host 探针（方案 §4.1、§14）。仅加载到隔离 DSH_HOME。
 * 真实工具管线、Session API；手工追加事件只证明传输，不冒充模型轮次实测。
 * 不调用模型，不读取用户配置，不自动批准执行项。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'page-preview-phase0'
export const inject = ['tools', 'sessions', 'agents', 'workingDirectory', 'llm']

export async function apply(ctx) {
  const observations = { events: [], tools: [], checks: {} }
  const seed = []
  ctx.on('session/event', (session, event) => {
    if (!session.id.startsWith('page-preview-phase0')) return
    if (session.id === 'page-preview-phase0-events') seed.push(event)
    if (event.type === 'turn/start' || event.type === 'turn/end') observations.events.push({
      sessionId: session.id, type: event.type, seq: event.seq, data: event.data,
    })
  })
  ctx.on('tools/result', (exec, result) => {
    if (!exec.name.startsWith('page_preview_phase0') && exec.agent?.id !== 'page-preview-phase0-tools') return
    observations.tools.push({ name: exec.name, agentId: exec.agent?.id,
      argumentKeys: Object.keys(exec.arguments ?? {}),
      // 只记录探针自己的文件路径，不记录任意工具参数或内容。
      filePath: exec.name === 'write' ? exec.arguments.file_path : undefined,
      isError: result.isError,
    })
  })
  ctx.tools.register(defineTool({
    name: 'page_preview_phase0_echo', description: 'Local offline Phase 0 probe',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return args.value },
  }))
  ctx.tools.register(defineTool({
    name: 'page_preview_phase0_wait', description: 'Cooperative cancellation probe',
    timeoutMs: 60, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      await new Promise((resolve, reject) => {
        if (exec.signal.aborted) { reject(exec.signal.reason); return }
        exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })
      throw new Error('Probe must be cancelled')
    },
  }))
  await (async () => {
    const dir = fileURLToPath(new URL('../../output/phase0/', import.meta.url))
    await mkdir(dir, { recursive: true })
    try {
      observations.checks.pluginToolsRegistered = ['open', 'status', 'capture', 'stop'].every((n) => ctx.tools.get('page_preview_' + n))
      const session = ctx.sessions.create('page-preview-phase0-events')
      for (const [i, reason] of [{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } },
        { kind: 'error', error: { code: 'UNKNOWN', message: 'phase0 synthetic failure' } }].entries()) {
        session.append('turn/start', { turn: i + 1 })
        session.append('turn/end', { turn: i + 1, reason })
      }
      const count = observations.events.length
      ctx.sessions.create('page-preview-phase0-replay', { seed })
      observations.checks.seedDoesNotRepublish = observations.events.length === count
      const handle = await ctx.agents.create({ sessionId: 'page-preview-phase0-tools', meta: { cwd: process.cwd() } })
      ctx.effect(() => () => handle.dispose())
      const agent = handle.agent
      observations.checks.caller = { agentId: agent.id, sessionId: agent.session.id, workspaceRoot: ctx.workingDirectory.get(agent.session) }
      const call = (name, args, signal = AbortSignal.timeout(2000)) => ctx.tools.execute({
        callId: 'phase0-' + name + '-' + observations.tools.length,
        name, arguments: args, signal, agent,
      })
      observations.checks.echo = await call('page_preview_phase0_echo', { value: 'phase0-echo' })
      observations.checks.timeout = await call('page_preview_phase0_wait', {})
      const controller = new AbortController()
      const pending = call('page_preview_phase0_wait', {}, controller.signal)
      setTimeout(() => controller.abort(new Error('phase0 caller cancellation')), 10)
      observations.checks.cancel = await pending
      observations.checks.write = await call('write', { file_path: './phase0-created-' + Date.now() + '.txt', content: 'disposable Phase 0 data\n' })
      await handle.dispose()
      // 只用本地脚本流驱动真实 Agent loop；不向任何模型服务发请求。
      let streamStarted
      class LocalProbeAdapter extends LlmAdapter {
        async *stream(options) {
          streamStarted?.()
          if (options.model === 'cancel') {
            await new Promise((resolve, reject) => {
              if (options.signal.aborted) { reject(options.signal.reason); return }
              options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
            })
            return
          }
          if (options.model === 'error') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PHASE0', message: 'phase0-stream-failure' } } }
            return
          }
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'phase0-local-response' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'phase0-local-response' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['page-preview-phase0-local'], new LocalProbeAdapter())
      for (const model of ['complete', 'error', 'cancel']) {
        const loop = await ctx.agents.create({
          sessionId: 'page-preview-phase0-loop-' + model, meta: { cwd: process.cwd() },
          agentOptions: { provider: 'page-preview-phase0-local', model },
        })
        try {
          const started = new Promise((resolve) => { streamStarted = resolve })
          loop.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'phase0-local-only' }], source: { kind: 'user' } }))
          if (model === 'cancel') {
            await Promise.race([started, loop.agent.whenIdle().then(() => { throw new Error('Loop stopped before local stream') })])
            loop.agent.cancel({ kind: 'user' })
          }
          await loop.agent.whenIdle()
        } finally {
          await loop.dispose()
        }
      }
      assert.equal(observations.checks.pluginToolsRegistered, true)
      assert.equal(observations.checks.seedDoesNotRepublish, true)
      assert.equal(observations.checks.echo.isError, false)
      assert.equal(observations.checks.timeout.error?.info?.code, 'TOOL_TIMEOUT')
      assert.equal(observations.checks.cancel.isError, true)
      assert.equal(observations.checks.write.isError, false)
      for (const [model, kind] of [['complete', 'completed'], ['error', 'error'], ['cancel', 'aborted']]) {
        const events = observations.events.filter((event) => event.sessionId === 'page-preview-phase0-loop-' + model)
        assert.deepEqual(events.map((event) => event.type), ['turn/start', 'turn/end'])
        assert.equal(events[1].data.reason.kind, kind)
      }
    } catch (error) {
      observations.error = String(error)
    }
    await writeFile(dir + 'host-observations.json', JSON.stringify(observations, null, 2))
    if (observations.error) throw new Error('Phase 0 host probe failed; inspect local host-observations.json')
  })()
  return () => {}
}
