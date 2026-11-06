/**
 * open 结果的 pageText 投影（方案 §4.2、R5-0a，决策 P-A）。
 *
 * 早于挂载信号的文本观测（首帧空文本）不得当作页面文本输出——它读起来像"页面没有文字"，
 * 实际只是"挂载后尚未采集到"。可输出的条件：观测不晚于挂载边界到达 Runner
 * （`receivedAt >= 边界 at`，两者同为 Runner 接收时钟）。
 *
 * 挂载边界按策略取值：
 * - `isolated`：框架挂载信号（`targetMounted` 证据到达时间；`failed` 不算边界——挂载未成功）。
 *   未配置断言时信号仍到达并记 unverified+at，文本观测晚于它即属"挂载后"。
 * - `static`：没有框架挂载概念，文档加载证据即"页面已成形"边界。
 * - `project`/`attach`：响应层不注入 bootstrap，本不产生 pageText；此函数仍如实判定。
 */
import type { PageTextObservation, ReadinessEvidence, Strategy } from '../shared/contracts.ts'
import type { RunnerSnapshot } from '../shared/ipc.ts'

/** 返回可证明为挂载后采集的文本观测；无法证明时返回 undefined（不等于"页面没有文字"）。 */
export function postMountPageText(
  snapshot: Pick<RunnerSnapshot, 'pageText' | 'readiness'>, strategy: Strategy,
): PageTextObservation | undefined {
  const text = snapshot.pageText
  if (text === undefined) return undefined
  const boundary = mountBoundary(snapshot.readiness, strategy)
  if (boundary === undefined || text.receivedAt < boundary) return undefined
  return text
}

function mountBoundary(readiness: ReadinessEvidence, strategy: Strategy): string | undefined {
  const evidence = strategy === 'static' ? readiness.documentLoaded : readiness.targetMounted
  if (evidence.status === 'failed') return undefined
  return evidence.at
}
