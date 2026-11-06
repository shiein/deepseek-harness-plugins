/**
 * Client 面板的 Host Remote 服务（方案 §4.3、§10）。
 * sessionId 由面板所在会话显式给出，与工具调用使用同一 owner/workspace 解析；
 * 只回传该 owner 经 status/stop 即可看到的投影，不建第二份事实源。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PanelOpenReply, PanelSnapshot, PanelStopReply } from '../client/protocol.ts'
import { resolvePreviewCaller } from './caller.ts'
import type { PreviewCaller } from './caller.ts'
import type { SessionRegistry } from './session-registry.ts'

export class PanelService extends TypertRemoteService {
  private readonly registry: SessionRegistry
  private readonly sessions: Pick<SessionStore, 'get'>

  constructor(ctx: Context, registry: SessionRegistry, sessions?: Pick<SessionStore, 'get'>) {
    super(ctx, 'pagePreview')
    this.registry = registry
    this.sessions = sessions ?? ctx.sessions
  }

  /** 面板状态流：初始快照后仅在 Runner 会话事实前进时再次投影；不轮询、不伪造状态。 */
  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<PanelSnapshot> {
    const caller = await this.caller(sessionId)
    // 跟随期间登记：open 据此知道侧边栏 Browser 会自动加载新预览，可等待真实挂载证据。
    const release = this.registry.trackFollower(caller.ownerSessionId)
    try {
      let version = 0
      while (!signal.aborted) {
        yield await this.registry.panelSnapshot(caller)
        const next = await this.registry.panelChanges(version, signal)
        if (next === undefined) return
        version = next
      }
    } finally { release() }
  }

  /** 面板停止：复用同一 owner 核对；异属会话只能得到 not_found，看不到对方预览。 */
  async stop(sessionId: string, previewId: string): Promise<PanelStopReply> {
    return this.registry.stopForOwner(await this.caller(sessionId), previewId)
  }

  /**
   * 面板一键打开（R5-6、R5-F5）：先经 resolvePreviewCaller 校验「已知会话+显式工作区」，
   * 再交给共享打开路径。cancellation signal 由 transport 注入（协议声明参数不进 wire），
   * 面板侧取消会终止审批等待与启动；活动 Agent 如实传入以保留审批 scope 语义。
   */
  async open(sessionId: string, request: { projectId: string, target: string },
    signal?: AbortSignal): Promise<PanelOpenReply> {
    const session: Session | undefined = this.sessions.get(SessionId(sessionId))
    if (!session) throw new Error('Preview panel requires a known session with an explicit workspace directory')
    await resolvePreviewCaller(session)
    return this.registry.panelOpen(session, request, this.agentOf(session), signal)
  }

  /**
   * 活动 Agent 由 DSH 的 agents 服务按会话提供（官方 scope 载体）。
   * dsh-agent 不是本插件的声明依赖：经 ctx.get 结构化读取，服务缺失时返回 undefined，
   * 由 panelOpen 退回 {id, session} 最小身份（审批仍按 session 核对，语义不变）。
   */
  private agentOf(session: Session): { id: string; session: Session } | undefined {
    try {
      const agents = this.ctx.get('agents') as
        { get?: (id: SessionId) => { id: string; session: Session } | undefined } | undefined
      const agent = agents?.get?.(session.id)
      return agent?.session === session ? agent : undefined
    } catch { return undefined }
  }

  private async caller(sessionId: string): Promise<PreviewCaller> {
    const session: Session | undefined = this.sessions.get(SessionId(sessionId))
    if (!session) throw new Error('Preview panel requires a known session with an explicit workspace directory')
    return resolvePreviewCaller(session)
  }
}
