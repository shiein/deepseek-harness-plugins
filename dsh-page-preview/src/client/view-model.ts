/** 面板纯逻辑（方案 §10）：Remote 绑定、行投影与可停止判定；不依赖 React，可独立单测。 */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { PanelOpenReply, PanelPreview, PanelSnapshot, PanelStopReply, PanelSuggestionOpen } from './protocol.ts'

export interface PanelRemote {
  follow(sessionId: string, signal: AbortSignal): RemoteStreamHandle<PanelSnapshot, never>
  stop(sessionId: string, previewId: string): Promise<RemoteResult<PanelStopReply>>
  open(sessionId: string, request: PanelSuggestionOpen): Promise<RemoteResult<PanelOpenReply>>
}

/** slots inject 返回给 body 的实例：所有 Remote 调用在此绑定面板所在会话。 */
export interface PanelController {
  readonly sessionId: string
  readonly follow: (signal: AbortSignal) => RemoteStreamHandle<PanelSnapshot, never>
  readonly stop: (previewId: string) => Promise<RemoteResult<PanelStopReply>>
  /** R5-6：建议候选一键打开；点击即授权意图，执行指纹审批仍在 Host 走官方接缝。 */
  readonly open: (request: PanelSuggestionOpen) => Promise<RemoteResult<PanelOpenReply>>
  /** 在 DSH Browser 页签中打开预览地址（Client UI 动作，不经 Host Remote）。 */
  readonly openInBrowser: (url: string) => void
}

export function createPanelController(remote: PanelRemote, sessionId: string,
  openInBrowser: (url: string) => void,
): PanelController {
  return {
    sessionId,
    follow: signal => remote.follow(sessionId, signal),
    stop: previewId => remote.stop(sessionId, previewId),
    open: request => remote.open(sessionId, request),
    openInBrowser,
  }
}

/** 三层就绪证据的概括文案；不合并成 ready 以外的假状态。 */
export function readinessLabel(preview: PanelPreview): string {
  const parts = [preview.readiness.serviceReachable.status, preview.readiness.documentLoaded.status, preview.readiness.targetMounted.status]
  if (parts.every(value => value === 'proven')) return 'proven'
  if (parts.some(value => value === 'failed')) return 'failed'
  return 'unverified'
}

/**
 * 状态/新鲜度徽标文案：词典有 `<kind>.<value>` 时用译文，否则原样显示枚举值（新增状态不会显示成空白）。
 */
export function badgeLabel(t: (key: string) => string, kind: 'state' | 'freshness', value: string): string {
  const key = kind + '.' + value
  const text = t(key)
  return text === key || text === '' ? value : text
}

export function stoppable(state: string): boolean {
  return !['stopped', 'failed', 'cleanup_failed'].includes(state)
}
