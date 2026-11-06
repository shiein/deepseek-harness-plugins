/**
 * Phase 0 官方 Remote 流探针（方案 §4.1、§4.3、§14）。仅用于经用户授权的固定测试会话。
 * 严格 Remote 描述来自 protocol.ts 的同一份 schema，不依赖仓库内部生成器。
 * 不接入产品 Registry，不伪造目标 ready，不执行业务项目代码。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-title'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CarrierCommand, CarrierReply } from './protocol.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute } from 'node:path'

declare module '@deepseek-ai/cordis' {
  interface Context { pagePreviewPhase0: CarrierProbe }
}

/** 隔离会话专用 Remote Service；session 资源由 Gateway 按调用者权限校验。 */
export class CarrierProbe extends TypertRemoteService {
  private readonly origin: string
  private readonly output: string | undefined
  readonly sessionId = SessionId('page-preview-phase0-carrier')
  private pending: { id: number; resolve: (reply: CarrierReply) => void } | undefined
  private running = false
  private readonly observations: { startedAt: string; completed: boolean; commands: CarrierCommand[]; replies: CarrierReply[]; initialDocumentLoads?: number; documentLoads: number; error?: string } = {
    startedAt: new Date().toISOString(), completed: false, commands: [], replies: [], documentLoads: 0,
  }

  constructor(ctx: Context, origin: string, output = process.env.DSH_PREVIEW_PROBE_OUTPUT) {
    super(ctx, 'pagePreviewPhase0')
    this.origin = origin
    this.output = output
    ctx.sessions.create(this.sessionId, { meta: { cwd: process.cwd() } })
  }

  /** 只对登记的探针会话发送操作，其他会话不能接收或触发探针。 */
  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<CarrierCommand> {
    if (sessionId !== this.sessionId) return
    if (this.observations.completed) return
    if (this.running) throw new Error('Phase 0 carrier probe already has a subscriber')
    this.running = true
    try {
      const initial = await this.documentLoads(signal)
      this.observations.initialDocumentLoads = initial
      for (const [index, kind] of (['open', 'refresh', 'close'] as const).entries()) {
        const id = index + 1
        const command = { id, kind, url: this.origin + '/' }
        const control = AbortSignal.any([signal, AbortSignal.timeout(10000)])
        let release: (() => void) | undefined
        const received = new Promise<CarrierReply>((resolve, reject) => {
          const abort = () => reject(control.reason)
          control.addEventListener('abort', abort, { once: true })
          release = () => control.removeEventListener('abort', abort)
          this.pending = { id, resolve }
        })
        // 消费者取消时，生成器可能直接进入 finally，避免留下未观察的拒绝。
        void received.catch(() => {})
        this.observations.commands.push(command)
        try {
          yield command
          const reply = await received
          if (reply.status !== 'accepted') throw new Error('Client operation failed: ' + reply.detail)
          if (kind !== 'close') await this.waitDocumentLoads(initial + id, control)
        } finally {
          release?.()
          this.pending = undefined
        }
      }
      this.observations.completed = true
    } catch (error) {
      this.observations.error = String(error)
      throw error
    } finally {
      this.running = false
      await this.save()
    }
  }

  /** 仅确认载体 API 操作；真实文档加载由受控响应层另行证明。 */
  acknowledge(sessionId: string, reply: CarrierReply): void {
    if (sessionId !== this.sessionId || reply.id !== this.pending?.id) throw new Error('Unexpected carrier acknowledgement')
    this.observations.replies.push(reply)
    this.pending.resolve(reply)
  }

  private async documentLoads(signal: AbortSignal): Promise<number> {
    const response = await fetch(this.origin + '/phase0/status', { signal })
    if (!response.ok) throw new Error('Static probe status is unavailable')
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('reports' in value) || !Array.isArray(value.reports)) throw new Error('Invalid static probe status')
    return value.reports.filter((report: unknown) => typeof report === 'object' && report !== null && 'kind' in report && report.kind === 'document-loaded').length
  }

  private async waitDocumentLoads(count: number, signal: AbortSignal): Promise<void> {
    while (true) {
      this.observations.documentLoads = await this.documentLoads(signal)
      if (this.observations.documentLoads >= count) return
      await delay(25, undefined, { signal })
    }
  }

  private async save(): Promise<void> {
    const dir = this.output
    if (!dir) throw new Error('Phase 0 probe output directory is required')
    await mkdir(dir, { recursive: true })
    await writeFile(dir + '/carrier-observations.json', JSON.stringify(this.observations, null, 2))
  }
}

export const name = 'page-preview-phase0-carrier'
export const inject = ['sessions', 'typertGateway', 'sessionTitle']

/** 显式配置供运行中的 Desktop 使用；环境变量保留给隔离 CLI 探针。 */
export function apply(ctx: Context, config: { origin?: string; output?: string } = {}): void {
  const input = config.origin ?? process.env.DSH_PREVIEW_PROBE_ORIGIN
  if (!input) throw new Error('DSH_PREVIEW_PROBE_ORIGIN is required')
  const origin = new URL(input)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== input) throw new Error('Probe origin must be a plain loopback HTTP origin')
  const output = config.output ?? process.env.DSH_PREVIEW_PROBE_OUTPUT
  if (typeof output !== 'string' || !isAbsolute(output)) throw new Error('Probe output directory must be absolute')
  const probe = new CarrierProbe(ctx, input, output)
  const session = ctx.sessions.get(probe.sessionId)
  if (!session) throw new Error('Probe session was not created')
  // 确定性标题使探针可检索；rename 不触发自动标题模型。
  ctx.sessionTitle.rename(session, 'Page Preview Phase 0')
}
