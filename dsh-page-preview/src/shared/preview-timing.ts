/** Runner 启动耗时的共享 wire schema（方案 §4.2、§9.2）：均由同一 Runner 单调时钟计量。 */
import { z } from 'zod'

export const startupTimingSchema = z.strictObject({
  serviceReadyMs: z.int().nonnegative().exactOptional(),
  documentLoadedMs: z.int().nonnegative().exactOptional(),
  mountFeedbackMs: z.int().nonnegative().exactOptional(),
  assertionSettledMs: z.int().nonnegative().exactOptional(),
})

/** 自 Runner 开始启动的累计毫秒数；尚未观察到的阶段缺省。 */
export type PreviewStartupTiming = z.infer<typeof startupTimingSchema>

/** 此次 open 调用的 Host 观测（可以复用既有预览），独立于 Runner 首次启动数据。 */
export interface OpenTiming {
  totalMs: number
  preflightMs?: number
  approvalMs?: number
  runnerRequestMs?: number
  readinessWaitMs?: number
}
