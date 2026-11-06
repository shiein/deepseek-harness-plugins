/**
 * Host ↔ Runner 子进程消息（方案 §6.5 进程模型）。
 * Runner 通过 Node IPC（child_process.fork 的 'message' 通道）通信；IPC 断开即视为 Host 退出，Runner 自清理。
 *
 * 请求携带 requestId；仅 inputs-changed 为单向通知。Host 的 RunnerConnection 负责关联、等待与超时。
 * start 带调用者身份与配置来源，Runner 重新读取配置并核对指纹；确认受理不代表目标 ready。
 */

import type { Diagnostic, Freshness, PageTextObservation, PreviewOccupant, PreviewPlan, ReadinessEvidence, ResultStatus, SessionState } from './contracts.ts'
import type { UnmatchedSnapshot } from './unmatched.ts'

export interface RunnerSnapshot {
  previewId: string
  state: SessionState
  freshness: Freshness
  readiness: ReadinessEvidence
  url?: string
  pageText?: PageTextObservation
  /** 当前生效的场景名（R3-2）：switchScenario 后随状态更新；Host 不得用打开时的 plan 值谎报。 */
  scenario?: string
  /** 未命中业务请求汇总（R3-1，§7.2）；场景切换/重载后清空。 */
  unmatched?: UnmatchedSnapshot
}

export interface RunnerReply {
  status: ResultStatus
  previewId?: string
  previews?: RunnerSnapshot[]
  residual?: string[]
  /** status=busy 时的占用者摘要（§4.2 busy 附带占用信息）。 */
  occupant?: PreviewOccupant
  /** 本次启动接管并清理了另一 DSH 会话的预览（其 previewId）。 */
  takenOver?: string
}

export type HostToRunner =
  // approval 携带本次用户批准的执行项指纹（R2-1）：Runner 执行前与当前指纹核对，批准不落盘。
  | { type: 'start'; requestId: string; previewId: string; ownerSessionId: string; plan: PreviewPlan;
      workspaceRoot: string; configFile?: string; approval?: { fingerprint: string } }
  | { type: 'status'; requestId: string; ownerSessionId: string; previewId?: string }
  // R3-2：scenario 省略=重读当前场景数据（预览未选场景则纯文档重载）；给出=切换场景。
  | { type: 'refresh'; requestId: string; previewId: string; ownerSessionId: string; scenario?: string }
  | { type: 'inputs-changed'; previewId: string; ownerSessionId: string; paths: string[] }
  | { type: 'stop'; requestId: string; previewId: string; ownerSessionId: string }
  | { type: 'shutdown'; requestId: string }

export type RunnerToHost =
  | { type: 'ack'; requestId: string; ok: boolean; diagnostics?: Diagnostic[]; result?: RunnerReply }
  | ({ type: 'state' } & RunnerSnapshot)
  | { type: 'diagnostic'; previewId: string; diagnostic: Diagnostic }
  | { type: 'stopped'; previewId: string; residual: string[] }
  // 回传通道 nonce（R4-1 收尾）：仅用于 Host 侧日志/意外诊断脱敏；内部消息，
  // 不投影到快照、工具输出或任何模型可见文本。
  | { type: 'channel-secrets'; previewId: string; secrets: string[] }
  | { type: 'ready-for-commands'; pid: number; node?: { executable: string; version: string } }

type WithoutRequestId<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never
export type RunnerRequest = WithoutRequestId<HostToRunner>
export type RunnerAck = Extract<RunnerToHost, { type: 'ack' }>
