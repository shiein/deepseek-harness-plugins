/**
 * 预览会话生命周期迁移表（方案 §9.2）。
 * 会话创建前的预检结果只通过 ResultStatus 返回，不进入状态机。
 */

import type { SessionState } from './contracts.ts'

const transitions: Record<SessionState, readonly SessionState[]> = {
  preparing: ['starting', 'failed', 'stopping'],
  starting: ['reachable', 'failed', 'stopping'],
  reachable: ['ready', 'degraded', 'updating', 'failed', 'stopping'],
  ready: ['updating', 'degraded', 'failed', 'stopping'],
  degraded: ['updating', 'ready', 'failed', 'stopping'],
  // 编译失败不在此表中体现为迁移：updating 回到原状态，仅 freshness 置为 stale（见 Session.applyUpdateResult）。
  updating: ['reachable', 'ready', 'degraded', 'failed', 'stopping'],
  failed: ['stopping'],
  // stopping → failed：曾失败的会话清理完成后终态仍是 failed，不被清理重试改写为 stopped（P1-5）。
  stopping: ['stopped', 'cleanup_failed', 'failed'],
  stopped: [],
  cleanup_failed: ['stopping'],
}

export const terminalStates: ReadonlySet<SessionState> = new Set(['stopped'])
/** 用户可以打开页面的状态。 */
export const viewableStates: ReadonlySet<SessionState> = new Set(['reachable', 'ready', 'degraded', 'updating'])

/** IPC 等边界复用迁移表的状态集合，避免另维护一份枚举。 */
export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && Object.hasOwn(transitions, value)
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return transitions[from].includes(to)
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid preview state transition: ${from} -> ${to}`)
  }
}
