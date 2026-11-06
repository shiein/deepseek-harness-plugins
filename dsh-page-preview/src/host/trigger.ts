/**
 * 轮次结束后的触发决策（方案 §9.1；R3 计划 R3-5，Aesc 默认决策 D2）。
 *
 * 模式（插件配置 `trigger`，cordis.patch.yml 的 page-preview 条目；默认 smart）：
 *   - off：不做任何事；Agent 仍可手动 open，status 仍可查看候选
 *   - smart（默认）：
 *       · 调用者会话已有预览且其项目受影响 → 通知 Runner（inputs-changed），由适配器刷新或报告 restart-required
 *       · 没有预览 → 只"推荐"：候选进入面板与 status，不自动启动任何进程
 *   - always：在 smart 基础上，没有预览且恰有一个 strong 候选时自动 open。
 *       自动 open 没有 Agent 的工具调用上下文，审批路径未定（D2），本轮只实现决策，不实现执行（返回 unsupported 诊断）
 *
 * 不变量：
 *   - 用户已选定的页面不被推荐覆盖（已有预览只刷新，不换目标）
 *   - 自动运行失败保留错误，不生成替代页面
 *   - 不放宽 requirements/scope/strategy；不绕过执行审批
 *   - 非页面变化（ImpactResult.unrelated）不触发任何动作
 */

import type { Candidate } from '../shared/contracts.ts'
import type { ImpactResult } from '../core/impact/types.ts'
import { singleConfidentCandidate } from '../core/impact/rank.ts'

export const TRIGGER_MODES = ['off', 'smart', 'always'] as const
export type TriggerMode = (typeof TRIGGER_MODES)[number]
export const DEFAULT_TRIGGER_MODE: TriggerMode = 'smart'

export type TriggerAction =
  | { kind: 'none'; reason: string }
  /** 通知 Runner 输入变化（已有预览）。 */
  | { kind: 'notify-inputs'; previewId: string; paths: string[] }
  /** 只推荐，不启动。 */
  | { kind: 'recommend'; candidates: Candidate[] }
  /** always 模式下的自动打开意图；本轮执行层返回 unsupported（D2 未决）。 */
  | { kind: 'auto-open'; candidate: Candidate }

export interface OwnedPreviewView {
  previewId: string
  projectId: string
  state: string
}

/** 能接收 inputs-changed 的可更新状态（与 RunnerSession.runUpdate 门禁一致，updating 由其互斥排队）。 */
const NOTIFIABLE_STATES = ['reachable', 'ready', 'degraded', 'updating']

/**
 * 纯决策（方案 §9.1、D2）：
 *   off → 不动作；smart → 受影响预览 notify-inputs，无受影响预览时 recommend；
 *   always → smart + 恰有一个 strong 候选时给出 auto-open 意图（执行层仍返回 unsupported）。
 * 项目受影响按应用根前缀判定（执行项/构建配置变化可能不产生页面候选但仍在应用内）；
 * 非页面变化（无候选且无应用内改动）不触发任何动作。
 */
export function decideTrigger(
  mode: TriggerMode, impact: ImpactResult, owned: readonly OwnedPreviewView[],
): TriggerAction[] {
  if (mode === 'off') return [{ kind: 'none', reason: 'Turn-end triggers are disabled (trigger: off)' }]
  const actions: TriggerAction[] = []
  for (const preview of owned) {
    if (!NOTIFIABLE_STATES.includes(preview.state)) continue
    const app = impact.apps.find(value => value.projectId === preview.projectId)
    if (app === undefined) continue
    const prefix = app.root === '' ? '' : app.root + '/'
    const paths = impact.changes.map(change => change.path)
      .filter(path => prefix === '' || path.startsWith(prefix))
    if (paths.length) actions.push({ kind: 'notify-inputs', previewId: preview.previewId, paths })
  }
  // 已有预览受影响时只刷新，不换目标（§9.1：用户已选定的页面不被推荐覆盖）。
  if (actions.length) return actions
  if (!impact.candidates.length) {
    return [{ kind: 'none', reason: 'No turn changes affect a previewable target' }]
  }
  actions.push({ kind: 'recommend', candidates: impact.candidates.slice(0, 3) })
  if (mode === 'always') {
    const candidate = singleConfidentCandidate({ candidates: impact.candidates, omitted: impact.omitted })
    if (candidate) actions.push({ kind: 'auto-open', candidate })
  }
  return actions
}
